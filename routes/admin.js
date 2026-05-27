const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const guard = [authenticate, authorize('admin')];

// ── Platform overview stats ──────────────────────────
router.get('/stats', ...guard, async (req, res) => {
  try {
    const [u, r, rev, recent] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                                                AS total,
          COUNT(*) FILTER (WHERE role='passenger')               AS passengers,
          COUNT(*) FILTER (WHERE role='driver')                   AS drivers,
          COUNT(*) FILTER (WHERE role='admin')                    AS admins,
          COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '7 days') AS new_week
        FROM users`),
      pool.query(`
        SELECT
          COUNT(*)                                                        AS total,
          COUNT(*) FILTER (WHERE status IN ('pending','matched','arrived','in_progress')) AS active,
          COUNT(*) FILTER (WHERE status='completed')                      AS completed,
          COUNT(*) FILTER (WHERE status='cancelled')                      AS cancelled,
          COUNT(*) FILTER (WHERE status='scheduled')                      AS scheduled,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('month',NOW())) AS this_month
        FROM rides`),
      pool.query(`
        SELECT
          COALESCE(SUM(fare)  FILTER (WHERE status='completed'),0)                                         AS total_revenue,
          COALESCE(SUM(fare)  FILTER (WHERE status='completed' AND created_at >= date_trunc('month',NOW())),0) AS month_revenue,
          COALESCE(ROUND(AVG(fare) FILTER (WHERE status='completed'),2),0)                                 AS avg_fare
        FROM rides`),
      pool.query(`
        SELECT r.id, r.status, r.fare, r.created_at,
               p.name AS passenger_name, d.name AS driver_name,
               r.pickup_address, r.destination_address, r.vehicle_type
        FROM rides r
        LEFT JOIN users p ON p.id = r.passenger_id
        LEFT JOIN users d ON d.id = r.driver_id
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
  try {
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Change user role ─────────────────────────────────
router.patch('/users/:id/role', ...guard, async (req, res) => {
  const { role } = req.body;
  if (!['passenger','driver','admin'].includes(role))
    return res.status(400).json({ error: 'Invalid role' });
  try {
    const result = await pool.query(
      `UPDATE users SET role=$1 WHERE id=$2 RETURNING id,name,email,role`,
      [role, req.params.id]
    );
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

// ── Rides list ───────────────────────────────────────
router.get('/rides', ...guard, async (req, res) => {
  const { status, search } = req.query;
  let q = `
    SELECT r.*, p.name AS passenger_name, d.name AS driver_name
    FROM rides r
    LEFT JOIN users p ON p.id = r.passenger_id
    LEFT JOIN users d ON d.id = r.driver_id
    WHERE 1=1`;
  const params = [];
  if (status && status !== 'all') { params.push(status); q += ` AND r.status=$${params.length}`; }
  if (search) {
    params.push(`%${search}%`);
    q += ` AND (p.name ILIKE $${params.length} OR r.pickup_address ILIKE $${params.length} OR r.destination_address ILIKE $${params.length})`;
  }
  q += ' ORDER BY r.created_at DESC LIMIT 100';
  try {
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Monthly analytics ────────────────────────────────
router.get('/analytics', ...guard, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        TO_CHAR(date_trunc('month', created_at), 'Mon YYYY') AS month,
        date_trunc('month', created_at)                       AS month_date,
        COUNT(*) FILTER (WHERE status='completed')            AS rides,
        COALESCE(SUM(fare) FILTER (WHERE status='completed'),0) AS revenue,
        COUNT(*) FILTER (WHERE status='cancelled')            AS cancelled
      FROM rides
      WHERE created_at >= NOW() - INTERVAL '6 months'
      GROUP BY date_trunc('month', created_at)
      ORDER BY month_date ASC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Drivers with stats ───────────────────────────────
router.get('/drivers', ...guard, async (req, res) => {
  const { search } = req.query;
  let q = `
    SELECT
      u.id, u.name, u.email, u.created_at,
      COUNT(r.id)  FILTER (WHERE r.status='completed')                          AS total_rides,
      COALESCE(SUM(r.fare) FILTER (WHERE r.status='completed'), 0)              AS total_earned,
      ROUND(AVG(r.driver_rating) FILTER (WHERE r.driver_rating IS NOT NULL), 1) AS avg_rating,
      COUNT(r.id)  FILTER (WHERE r.status IN ('matched','arrived','in_progress')) AS active_rides,
      MAX(r.updated_at)                                                          AS last_active
    FROM users u
    LEFT JOIN rides r ON r.driver_id = u.id
    WHERE u.role = 'driver'`;
  const params = [];
  if (search) { params.push(`%${search}%`); q += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`; }
  q += ' GROUP BY u.id ORDER BY total_rides DESC NULLS LAST';
  try {
    const result = await pool.query(q, params);
    res.json(result.rows);
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
    const vals  = users.rows.map((_, i) => `($${i*4+1},$${i*4+2},$${i*4+3},$${i*4+4})`).join(',');
    const flat  = users.rows.flatMap(u => [u.id, title, message, type]);
    await pool.query(`INSERT INTO notifications (user_id,title,message,type) VALUES ${vals}`, flat);
    res.json({ sent: users.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
