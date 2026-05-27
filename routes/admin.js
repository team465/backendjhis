const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const guard = [authenticate, authorize('admin')];

// ── Platform overview stats ──────────────────────────
router.get('/stats', ...guard, async (req, res) => {
  try {
    const [u, r, rev, recent] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total,
          COUNT(*) FILTER (WHERE role='passenger') AS passengers,
          COUNT(*) FILTER (WHERE role='driver')    AS drivers,
          COUNT(*) FILTER (WHERE role='admin')     AS admins,
          COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '7 days') AS new_week
        FROM users`),
      pool.query(`SELECT COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status IN ('pending','matched','arrived','in_progress')) AS active,
          COUNT(*) FILTER (WHERE status='completed')  AS completed,
          COUNT(*) FILTER (WHERE status='cancelled')  AS cancelled,
          COUNT(*) FILTER (WHERE status='scheduled')  AS scheduled,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('month',NOW())) AS this_month
        FROM rides`),
      pool.query(`SELECT
          COALESCE(SUM(fare) FILTER (WHERE status='completed'),0) AS total_revenue,
          COALESCE(SUM(fare) FILTER (WHERE status='completed' AND created_at >= date_trunc('month',NOW())),0) AS month_revenue,
          COALESCE(ROUND(AVG(fare) FILTER (WHERE status='completed'),2),0) AS avg_fare
        FROM rides`),
      pool.query(`SELECT r.id, r.status, r.fare, r.created_at,
               p.name AS passenger_name, d.name AS driver_name,
               r.pickup_address, r.destination_address, r.vehicle_type
        FROM rides r
        LEFT JOIN users p ON p.id=r.passenger_id LEFT JOIN users d ON d.id=r.driver_id
        ORDER BY r.created_at DESC LIMIT 8`),
    ]);
    res.json({ users: u.rows[0], rides: r.rows[0], revenue: rev.rows[0], recent: recent.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Users list ───────────────────────────────────────
router.get('/users', ...guard, async (req, res) => {
  const { role, search } = req.query;
  let q = `SELECT id, name, email, role, is_verified, created_at FROM users WHERE 1=1`;
  const params = [];
  if (role && role !== 'all') { params.push(role); q += ` AND role=$${params.length}`; }
  if (search) { params.push(`%${search}%`); q += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})`; }
  q += ' ORDER BY created_at DESC';
  try { res.json((await pool.query(q, params)).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Change user role ─────────────────────────────────
router.patch('/users/:id/role', ...guard, async (req, res) => {
  const { role } = req.body;
  if (!['passenger','driver','admin'].includes(role))
    return res.status(400).json({ error: 'Invalid role' });
  try {
    const result = await pool.query(
      `UPDATE users SET role=$1 WHERE id=$2 RETURNING id,name,email,role`, [role, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Delete user ──────────────────────────────────────
router.delete('/users/:id', ...guard, async (req, res) => {
  if (parseInt(req.params.id) === req.user.id)
    return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    const result = await pool.query('DELETE FROM users WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Passengers with ride stats ───────────────────────
router.get('/passengers', ...guard, async (req, res) => {
  const { search } = req.query;
  let q = `SELECT u.id, u.name, u.email, u.created_at,
      COUNT(r.id) FILTER (WHERE r.status='completed')              AS total_rides,
      COALESCE(SUM(r.fare) FILTER (WHERE r.status='completed'), 0) AS total_spent,
      MAX(r.created_at)                                             AS last_ride
    FROM users u LEFT JOIN rides r ON r.passenger_id=u.id
    WHERE u.role='passenger'`;
  const params = [];
  if (search) { params.push(`%${search}%`); q += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`; }
  q += ' GROUP BY u.id ORDER BY total_rides DESC NULLS LAST';
  try { res.json((await pool.query(q, params)).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Profile requests (unverified users) ─────────────
router.get('/profile-requests', ...guard, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, email, role, is_verified, created_at
      FROM users WHERE is_verified=FALSE AND role != 'admin'
      ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/profile-requests/:id/verify', ...guard, async (req, res) => {
  const { verified } = req.body;
  try {
    const result = await pool.query(
      `UPDATE users SET is_verified=$1 WHERE id=$2 AND role!='admin' RETURNING id,name,email,role,is_verified`,
      [!!verified, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Driver applications ──────────────────────────────
router.get('/driver-applications', ...guard, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.email, u.is_verified, u.created_at,
             COUNT(r.id) FILTER (WHERE r.status='completed') AS total_rides
      FROM users u LEFT JOIN rides r ON r.driver_id=u.id
      WHERE u.role='driver'
      GROUP BY u.id ORDER BY u.is_verified ASC, u.created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/driver-applications/:id/verify', ...guard, async (req, res) => {
  const { verified } = req.body;
  try {
    const result = await pool.query(
      `UPDATE users SET is_verified=$1 WHERE id=$2 AND role='driver' RETURNING id,name,email,is_verified`,
      [!!verified, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Driver not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Driver waitlist ──────────────────────────────────
router.get('/waitlist', ...guard, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM driver_waitlist ORDER BY created_at DESC')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/waitlist', ...guard, async (req, res) => {
  const { name, email, phone, vehicle_type, notes } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  try {
    const result = await pool.query(
      `INSERT INTO driver_waitlist (name,email,phone,vehicle_type,notes) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, email, phone||null, vehicle_type||'tuktuk', notes||null]);
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/waitlist/:id/status', ...guard, async (req, res) => {
  const { status } = req.body;
  if (!['pending','contacted','accepted','rejected'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  try {
    const result = await pool.query(
      `UPDATE driver_waitlist SET status=$1 WHERE id=$2 RETURNING *`, [status, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/waitlist/:id', ...guard, async (req, res) => {
  try {
    await pool.query('DELETE FROM driver_waitlist WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Driver leads (passengers who could become drivers) ─
router.get('/driver-leads', ...guard, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.email, u.created_at,
             COUNT(r.id) AS total_rides,
             COALESCE(SUM(r.fare),0) AS total_spent,
             MAX(r.created_at) AS last_ride
      FROM users u JOIN rides r ON r.passenger_id=u.id
      WHERE u.role='passenger'
      GROUP BY u.id HAVING COUNT(r.id) >= 2
      ORDER BY total_rides DESC LIMIT 50`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/driver-leads/:id/convert', ...guard, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE users SET role='driver' WHERE id=$1 AND role='passenger' RETURNING id,name,email,role`,
      [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Passenger not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Rides list ───────────────────────────────────────
router.get('/rides', ...guard, async (req, res) => {
  const { status, search } = req.query;
  let q = `SELECT r.*, p.name AS passenger_name, d.name AS driver_name
    FROM rides r LEFT JOIN users p ON p.id=r.passenger_id LEFT JOIN users d ON d.id=r.driver_id WHERE 1=1`;
  const params = [];
  if (status && status !== 'all') { params.push(status); q += ` AND r.status=$${params.length}`; }
  if (search) { params.push(`%${search}%`); q += ` AND (p.name ILIKE $${params.length} OR r.pickup_address ILIKE $${params.length} OR r.destination_address ILIKE $${params.length})`; }
  q += ' ORDER BY r.created_at DESC LIMIT 100';
  try { res.json((await pool.query(q, params)).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Active rides for live tracker ────────────────────
router.get('/active-rides', ...guard, async (req, res) => {
  try {
    res.json((await pool.query(`
      SELECT r.id, r.status, r.fare, r.vehicle_type, r.pickup_address, r.destination_address, r.created_at,
             p.name AS passenger_name, d.name AS driver_name
      FROM rides r LEFT JOIN users p ON p.id=r.passenger_id LEFT JOIN users d ON d.id=r.driver_id
      WHERE r.status IN ('pending','matched','arrived','in_progress')
      ORDER BY r.created_at DESC`)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Safety dashboard ─────────────────────────────────
router.get('/safety', ...guard, async (req, res) => {
  try {
    const [stats, lowRated, recent] = await Promise.all([
      pool.query(`SELECT
          COUNT(*) FILTER (WHERE status='cancelled') AS cancelled_rides,
          COUNT(*) FILTER (WHERE status='completed') AS completed_rides,
          ROUND(COUNT(*) FILTER (WHERE status='cancelled') * 100.0 / NULLIF(COUNT(*),0),1) AS cancel_rate,
          COUNT(*) FILTER (WHERE driver_rating <= 2 AND driver_rating IS NOT NULL) AS low_ratings
        FROM rides`),
      pool.query(`SELECT u.id, u.name, u.email,
          ROUND(AVG(r.driver_rating),1) AS avg_rating, COUNT(r.id) AS total_rides
        FROM users u JOIN rides r ON r.driver_id=u.id
        WHERE u.role='driver' AND r.driver_rating IS NOT NULL
        GROUP BY u.id HAVING AVG(r.driver_rating) < 3 AND COUNT(r.id) >= 2
        ORDER BY avg_rating ASC LIMIT 10`),
      pool.query(`SELECT r.id, r.status, r.created_at, r.driver_rating,
               p.name AS passenger_name, d.name AS driver_name,
               r.pickup_address, r.destination_address
        FROM rides r LEFT JOIN users p ON p.id=r.passenger_id LEFT JOIN users d ON d.id=r.driver_id
        WHERE r.status='cancelled' ORDER BY r.created_at DESC LIMIT 15`),
    ]);
    res.json({ stats: stats.rows[0], lowRatedDrivers: lowRated.rows, recentCancellations: recent.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Onboarding funnel ────────────────────────────────
router.get('/onboarding-funnel', ...guard, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE role='driver') AS registered,
        COUNT(*) FILTER (WHERE role='driver' AND is_verified=TRUE) AS verified,
        (SELECT COUNT(DISTINCT driver_id) FROM rides WHERE driver_id IS NOT NULL AND status='completed') AS first_ride,
        (SELECT COUNT(DISTINCT driver_id) FROM rides WHERE driver_id IS NOT NULL AND status='completed'
           GROUP BY driver_id HAVING COUNT(*) >= 10 LIMIT 1) AS power_drivers
      FROM users`);
    const row = result.rows[0];
    // Count power drivers properly
    const pd = await pool.query(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT driver_id FROM rides WHERE status='completed' GROUP BY driver_id HAVING COUNT(*)>=10
       ) t`);
    res.json({ ...row, power_drivers: pd.rows[0].cnt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Incidents ────────────────────────────────────────
router.get('/incidents', ...guard, async (req, res) => {
  try {
    res.json((await pool.query(`
      SELECT i.*, u.name AS reporter_name, r.pickup_address, r.destination_address
      FROM incidents i
      LEFT JOIN users u ON u.id=i.reporter_id LEFT JOIN rides r ON r.id=i.ride_id
      ORDER BY i.created_at DESC`)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/incidents', ...guard, async (req, res) => {
  const { ride_id, type, description, severity } = req.body;
  if (!description) return res.status(400).json({ error: 'Description required' });
  try {
    const result = await pool.query(
      `INSERT INTO incidents (ride_id,reporter_id,type,description,severity) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [ride_id||null, req.user.id, type||'general', description, severity||'medium']);
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/incidents/:id/status', ...guard, async (req, res) => {
  const { status } = req.body;
  if (!['open','investigating','resolved','closed'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  const resolved = ['resolved','closed'].includes(status) ? 'NOW()' : 'NULL';
  try {
    const result = await pool.query(
      `UPDATE incidents SET status=$1, resolved_at=${resolved} WHERE id=$2 RETURNING *`,
      [status, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Disputes ─────────────────────────────────────────
router.get('/disputes', ...guard, async (req, res) => {
  try {
    res.json((await pool.query(`
      SELECT d.*, u.name AS raised_by_name, r.pickup_address, r.destination_address, r.fare
      FROM disputes d
      LEFT JOIN users u ON u.id=d.raised_by_id LEFT JOIN rides r ON r.id=d.ride_id
      ORDER BY d.created_at DESC`)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/disputes', ...guard, async (req, res) => {
  const { ride_id, reason, description } = req.body;
  if (!reason) return res.status(400).json({ error: 'Reason required' });
  try {
    const result = await pool.query(
      `INSERT INTO disputes (ride_id,raised_by_id,reason,description) VALUES ($1,$2,$3,$4) RETURNING *`,
      [ride_id||null, req.user.id, reason, description||null]);
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/disputes/:id', ...guard, async (req, res) => {
  const { status, resolution } = req.body;
  if (!['open','investigating','resolved','dismissed'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  const resolved = ['resolved','dismissed'].includes(status) ? 'NOW()' : 'NULL';
  try {
    const result = await pool.query(
      `UPDATE disputes SET status=$1, resolution=$2, resolved_at=${resolved} WHERE id=$3 RETURNING *`,
      [status, resolution||null, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Traffic messages ─────────────────────────────────
router.get('/traffic-messages', ...guard, async (req, res) => {
  try {
    res.json((await pool.query(
      `SELECT DISTINCT ON (title, message) id, title, message, created_at
       FROM notifications WHERE type='traffic' ORDER BY title, message, created_at DESC`)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/traffic-messages', ...guard, async (req, res) => {
  const { title, message } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
  try {
    const users = await pool.query('SELECT id FROM users');
    if (!users.rows.length) return res.json({ sent: 0 });
    const vals = users.rows.map((_,i) => `($${i*4+1},$${i*4+2},$${i*4+3},$${i*4+4})`).join(',');
    const flat = users.rows.flatMap(u => [u.id, title, message, 'traffic']);
    await pool.query(`INSERT INTO notifications (user_id,title,message,type) VALUES ${vals}`, flat);
    res.json({ sent: users.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Withdrawals ──────────────────────────────────────
router.get('/withdrawals', ...guard, async (req, res) => {
  try {
    res.json((await pool.query(`
      SELECT w.*, u.name AS driver_name, u.email AS driver_email
      FROM driver_withdrawals w JOIN users u ON u.id=w.driver_id
      ORDER BY w.created_at DESC`)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/withdrawals', ...guard, async (req, res) => {
  const { driver_id, amount, method, notes } = req.body;
  if (!driver_id || !amount) return res.status(400).json({ error: 'driver_id and amount required' });
  try {
    const result = await pool.query(
      `INSERT INTO driver_withdrawals (driver_id,amount,method,notes) VALUES ($1,$2,$3,$4) RETURNING *`,
      [driver_id, amount, method||'bank', notes||null]);
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/withdrawals/:id/status', ...guard, async (req, res) => {
  const { status } = req.body;
  if (!['pending','approved','paid','rejected'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  const processed = ['paid','rejected'].includes(status) ? 'NOW()' : 'NULL';
  try {
    const result = await pool.query(
      `UPDATE driver_withdrawals SET status=$1, processed_at=${processed} WHERE id=$2 RETURNING *`,
      [status, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Monthly analytics ────────────────────────────────
router.get('/analytics', ...guard, async (req, res) => {
  try {
    res.json((await pool.query(`
      SELECT TO_CHAR(date_trunc('month',created_at),'Mon YYYY') AS month,
             date_trunc('month',created_at) AS month_date,
             COUNT(*) FILTER (WHERE status='completed') AS rides,
             COALESCE(SUM(fare) FILTER (WHERE status='completed'),0) AS revenue,
             COUNT(*) FILTER (WHERE status='cancelled') AS cancelled
      FROM rides WHERE created_at >= NOW()-INTERVAL '6 months'
      GROUP BY date_trunc('month',created_at) ORDER BY month_date ASC`)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Drivers with stats ───────────────────────────────
router.get('/drivers', ...guard, async (req, res) => {
  const { search } = req.query;
  let q = `SELECT u.id, u.name, u.email, u.is_verified, u.created_at,
      COUNT(r.id)  FILTER (WHERE r.status='completed') AS total_rides,
      COALESCE(SUM(r.fare) FILTER (WHERE r.status='completed'),0) AS total_earned,
      ROUND(AVG(r.driver_rating) FILTER (WHERE r.driver_rating IS NOT NULL),1) AS avg_rating,
      COUNT(r.id)  FILTER (WHERE r.status IN ('matched','arrived','in_progress')) AS active_rides,
      MAX(r.updated_at) AS last_active
    FROM users u LEFT JOIN rides r ON r.driver_id=u.id WHERE u.role='driver'`;
  const params = [];
  if (search) { params.push(`%${search}%`); q += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`; }
  q += ' GROUP BY u.id ORDER BY total_rides DESC NULLS LAST';
  try { res.json((await pool.query(q, params)).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fare config ──────────────────────────────────────
router.get('/fare-config', ...guard, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM fare_config ORDER BY vehicle_type')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/fare-config/:type', ...guard, async (req, res) => {
  const { base_fare, per_km, min_fare } = req.body;
  if (base_fare == null || per_km == null || min_fare == null)
    return res.status(400).json({ error: 'base_fare, per_km and min_fare are required' });
  try {
    const result = await pool.query(
      `UPDATE fare_config SET base_fare=$1,per_km=$2,min_fare=$3,updated_at=NOW() WHERE vehicle_type=$4 RETURNING *`,
      [base_fare, per_km, min_fare, req.params.type]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Vehicle type not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Payments breakdown ───────────────────────────────
router.get('/payments-breakdown', ...guard, async (req, res) => {
  try {
    const [byMethod, recent] = await Promise.all([
      pool.query(`SELECT payment_method, COUNT(*) AS count, COALESCE(SUM(fare),0) AS total
        FROM rides WHERE status='completed' AND payment_method IS NOT NULL
        GROUP BY payment_method ORDER BY total DESC`),
      pool.query(`SELECT r.id, r.fare, r.payment_method, r.created_at, u.name AS passenger_name
        FROM rides r LEFT JOIN users u ON u.id=r.passenger_id
        WHERE r.status='completed' ORDER BY r.created_at DESC LIMIT 30`),
    ]);
    res.json({ byMethod: byMethod.rows, recent: recent.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Enterprise finance ────────────────────────────────
router.get('/ent-finance', ...guard, async (req, res) => {
  try {
    const [byVehicle, byPayment, monthly] = await Promise.all([
      pool.query(`SELECT vehicle_type,
          COUNT(*) FILTER (WHERE status='completed') AS rides,
          COALESCE(SUM(fare) FILTER (WHERE status='completed'),0) AS revenue
        FROM rides GROUP BY vehicle_type ORDER BY revenue DESC`),
      pool.query(`SELECT payment_method,
          COUNT(*) FILTER (WHERE status='completed') AS rides,
          COALESCE(SUM(fare) FILTER (WHERE status='completed'),0) AS revenue
        FROM rides GROUP BY payment_method ORDER BY revenue DESC`),
      pool.query(`SELECT TO_CHAR(date_trunc('month',created_at),'Mon YYYY') AS month,
          date_trunc('month',created_at) AS month_date,
          COUNT(*) FILTER (WHERE status='completed') AS rides,
          COALESCE(SUM(fare) FILTER (WHERE status='completed'),0) AS revenue,
          COALESCE(SUM(fare)*0.15 FILTER (WHERE status='completed'),0) AS platform_cut,
          COALESCE(SUM(fare)*0.05 FILTER (WHERE status='completed'),0) AS ngo_cut
        FROM rides WHERE created_at >= NOW()-INTERVAL '12 months'
        GROUP BY date_trunc('month',created_at) ORDER BY month_date ASC`),
    ]);
    res.json({ byVehicle: byVehicle.rows, byPayment: byPayment.rows, monthly: monthly.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Enterprise compliance ─────────────────────────────
router.get('/ent-compliance', ...guard, async (req, res) => {
  try {
    const [userSummary, rideSummary, unverified] = await Promise.all([
      pool.query(`SELECT
          COUNT(*) AS total_users,
          COUNT(*) FILTER (WHERE is_verified=TRUE)  AS verified_users,
          COUNT(*) FILTER (WHERE is_verified=FALSE) AS unverified_users,
          COUNT(*) FILTER (WHERE role='passenger')  AS passengers,
          COUNT(*) FILTER (WHERE role='driver')      AS drivers,
          COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '30 days') AS new_30d
        FROM users WHERE role != 'admin'`),
      pool.query(`SELECT COUNT(*) AS total_rides,
          COUNT(*) FILTER (WHERE status='completed')  AS completed,
          COUNT(*) FILTER (WHERE status='cancelled')  AS cancelled,
          COUNT(*) FILTER (WHERE fare IS NULL AND status='completed') AS rides_no_fare,
          COALESCE(SUM(fare) FILTER (WHERE status='completed'),0) AS total_revenue
        FROM rides`),
      pool.query(`SELECT id,name,email,role,created_at FROM users
        WHERE is_verified=FALSE AND role!='admin' ORDER BY created_at DESC LIMIT 10`),
    ]);
    res.json({ userSummary: userSummary.rows[0], rideSummary: rideSummary.rows[0], unverified: unverified.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Communications (alias for notify) ───────────────
router.post('/communications', ...guard, async (req, res) => {
  const { user_id, role, title, message } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
  try {
    if (user_id) {
      await pool.query(
        `INSERT INTO notifications (user_id,title,message,type) VALUES ($1,$2,$3,'admin_message')`,
        [user_id, title, message]);
      return res.json({ sent: 1 });
    }
    let q = 'SELECT id FROM users WHERE 1=1';
    const params = [];
    if (role && role !== 'all') { params.push(role); q += ` AND role=$${params.length}`; }
    const users = await pool.query(q, params);
    if (!users.rows.length) return res.json({ sent: 0 });
    const vals = users.rows.map((_,i) => `($${i*4+1},$${i*4+2},$${i*4+3},$${i*4+4})`).join(',');
    const flat = users.rows.flatMap(u => [u.id, title, message, 'admin_message']);
    await pool.query(`INSERT INTO notifications (user_id,title,message,type) VALUES ${vals}`, flat);
    res.json({ sent: users.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Hotel partners ───────────────────────────────────
router.get('/hotel-partners', ...guard, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM hotel_partners ORDER BY created_at DESC')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/hotel-partners', ...guard, async (req, res) => {
  const { name, contact_name, email, phone, location, commission_pct } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const result = await pool.query(
      `INSERT INTO hotel_partners (name,contact_name,email,phone,location,commission_pct)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, contact_name||null, email||null, phone||null, location||null, commission_pct||10]);
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/hotel-partners/:id', ...guard, async (req, res) => {
  const { name, contact_name, email, phone, location, commission_pct, status } = req.body;
  try {
    const result = await pool.query(
      `UPDATE hotel_partners SET name=$1,contact_name=$2,email=$3,phone=$4,location=$5,
         commission_pct=$6,status=COALESCE($7,status) WHERE id=$8 RETURNING *`,
      [name, contact_name||null, email||null, phone||null, location||null, commission_pct||10, status||null, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/hotel-partners/:id', ...guard, async (req, res) => {
  try {
    await pool.query('DELETE FROM hotel_partners WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Investor metrics ─────────────────────────────────
router.get('/investor-metrics', ...guard, async (req, res) => {
  try {
    const [kpi, growth, topDrivers] = await Promise.all([
      pool.query(`SELECT
          (SELECT COUNT(*) FROM users WHERE role='passenger') AS total_passengers,
          (SELECT COUNT(*) FROM users WHERE role='driver')     AS total_drivers,
          (SELECT COUNT(*) FROM rides WHERE status='completed') AS total_rides,
          (SELECT COALESCE(SUM(fare),0) FROM rides WHERE status='completed') AS total_revenue,
          (SELECT COALESCE(SUM(fare),0) FROM rides WHERE status='completed'
             AND created_at >= date_trunc('month',NOW())) AS month_revenue,
          (SELECT COUNT(*) FROM rides WHERE status='completed'
             AND created_at >= date_trunc('month',NOW())) AS month_rides,
          (SELECT COUNT(*) FROM users WHERE created_at >= date_trunc('month',NOW())) AS new_users_month,
          (SELECT ROUND(AVG(fare),2) FROM rides WHERE status='completed') AS avg_fare`),
      pool.query(`SELECT TO_CHAR(date_trunc('month',created_at),'Mon YYYY') AS month,
          date_trunc('month',created_at) AS month_date,
          COUNT(*) FILTER (WHERE status='completed') AS rides,
          COALESCE(SUM(fare) FILTER (WHERE status='completed'),0) AS revenue,
          COUNT(DISTINCT passenger_id) AS active_passengers,
          COUNT(DISTINCT driver_id) FILTER (WHERE driver_id IS NOT NULL) AS active_drivers
        FROM rides WHERE created_at >= NOW()-INTERVAL '6 months'
        GROUP BY date_trunc('month',created_at) ORDER BY month_date ASC`),
      pool.query(`SELECT u.id, u.name,
          COUNT(r.id) FILTER (WHERE r.status='completed') AS rides,
          COALESCE(SUM(r.fare) FILTER (WHERE r.status='completed'),0) AS earned
        FROM users u LEFT JOIN rides r ON r.driver_id=u.id
        WHERE u.role='driver' GROUP BY u.id ORDER BY earned DESC LIMIT 5`),
    ]);
    res.json({ kpi: kpi.rows[0], growth: growth.rows, topDrivers: topDrivers.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Events log ───────────────────────────────────────
router.get('/events-log', ...guard, async (req, res) => {
  try {
    const [rides, users, incidents] = await Promise.all([
      pool.query(`SELECT r.id, r.status, r.created_at, r.fare, r.vehicle_type,
               p.name AS passenger_name, d.name AS driver_name
        FROM rides r LEFT JOIN users p ON p.id=r.passenger_id LEFT JOIN users d ON d.id=r.driver_id
        ORDER BY r.created_at DESC LIMIT 30`),
      pool.query(`SELECT id, name, email, role, is_verified, created_at FROM users ORDER BY created_at DESC LIMIT 20`),
      pool.query(`SELECT i.id, i.type, i.severity, i.status, i.description, i.created_at, u.name AS reporter_name
        FROM incidents i LEFT JOIN users u ON u.id=i.reporter_id ORDER BY i.created_at DESC LIMIT 10`),
    ]);
    res.json({ rides: rides.rows, users: users.rows, incidents: incidents.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Content manager ───────────────────────────────────
router.get('/content', ...guard, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM content_items ORDER BY category, key')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/content/:key', ...guard, async (req, res) => {
  const { value, category } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO content_items (key,value,category) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value=$2, category=$3, updated_at=NOW() RETURNING *`,
      [req.params.key, value||'', category||'general']);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/content', ...guard, async (req, res) => {
  const { key, value, category } = req.body;
  if (!key) return res.status(400).json({ error: 'Key required' });
  try {
    const result = await pool.query(
      `INSERT INTO content_items (key,value,category) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW() RETURNING *`,
      [key, value||'', category||'general']);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/content/:id', ...guard, async (req, res) => {
  try {
    await pool.query('DELETE FROM content_items WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SEO settings ─────────────────────────────────────
router.get('/seo', ...guard, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM seo_settings WHERE id=1');
    res.json(result.rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/seo', ...guard, async (req, res) => {
  const { site_title, meta_desc, keywords, og_title, og_desc } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO seo_settings (id,site_title,meta_desc,keywords,og_title,og_desc)
       VALUES (1,$1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET site_title=$1,meta_desc=$2,keywords=$3,og_title=$4,og_desc=$5,updated_at=NOW()
       RETURNING *`,
      [site_title, meta_desc, keywords, og_title||null, og_desc||null]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Platform settings ────────────────────────────────
router.get('/settings', ...guard, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM platform_settings WHERE id=1');
    res.json(result.rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings', ...guard, async (req, res) => {
  const { platform_name, support_email, support_phone, default_currency, commission_pct, ngo_pct, booking_enabled, maintenance_mode } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO platform_settings
         (id,platform_name,support_email,support_phone,default_currency,commission_pct,ngo_pct,booking_enabled,maintenance_mode)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         platform_name=$1,support_email=$2,support_phone=$3,default_currency=$4,
         commission_pct=$5,ngo_pct=$6,booking_enabled=$7,maintenance_mode=$8,updated_at=NOW()
       RETURNING *`,
      [platform_name, support_email, support_phone, default_currency, commission_pct, ngo_pct, booking_enabled, maintenance_mode]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Broadcast notification ───────────────────────────
router.post('/notify', ...guard, async (req, res) => {
  const { role, title, message, type = 'admin_broadcast' } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'Title and message are required' });
  try {
    let q = 'SELECT id FROM users WHERE 1=1';
    const params = [];
    if (role && role !== 'all') { params.push(role); q += ` AND role=$${params.length}`; }
    const users = await pool.query(q, params);
    if (!users.rows.length) return res.json({ sent: 0 });
    const vals = users.rows.map((_,i) => `($${i*4+1},$${i*4+2},$${i*4+3},$${i*4+4})`).join(',');
    const flat = users.rows.flatMap(u => [u.id, title, message, type]);
    await pool.query(`INSERT INTO notifications (user_id,title,message,type) VALUES ${vals}`, flat);
    res.json({ sent: users.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
