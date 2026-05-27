const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/driver/requests — all pending rides available to accept
router.get('/requests', authenticate, authorize('driver'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.name AS passenger_name
       FROM rides r
       LEFT JOIN users u ON u.id = r.passenger_id
       WHERE r.status = 'pending'
         AND r.driver_id IS NULL
       ORDER BY r.created_at DESC
       LIMIT 30`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/driver/active — driver's current active ride
router.get('/active', authenticate, authorize('driver'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.name AS passenger_name, u.email AS passenger_email
       FROM rides r
       LEFT JOIN users u ON u.id = r.passenger_id
       WHERE r.driver_id = $1
         AND r.status IN ('matched','arrived','in_progress')
       ORDER BY r.updated_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/driver/rides/:id/accept — driver accepts a pending ride
router.patch('/rides/:id/accept', authenticate, authorize('driver'), async (req, res) => {
  try {
    const check = await pool.query(
      `SELECT id FROM rides WHERE driver_id=$1 AND status IN ('matched','arrived','in_progress') LIMIT 1`,
      [req.user.id]
    );
    if (check.rows.length) {
      return res.status(400).json({ error: 'You already have an active ride' });
    }
    const result = await pool.query(
      `UPDATE rides SET status='matched', driver_id=$1, updated_at=NOW()
       WHERE id=$2 AND status='pending' AND driver_id IS NULL
       RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ride no longer available' });
    const ride = result.rows[0];
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,$4)`,
      [ride.passenger_id, 'Driver found!', 'Your driver is on the way to pick you up.', 'driver_matched']
    );
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/driver/rides/:id/status — advance ride status
router.patch('/rides/:id/status', authenticate, authorize('driver'), async (req, res) => {
  const NEXT = { matched: 'arrived', arrived: 'in_progress', in_progress: 'completed' };
  const NOTIFY = {
    arrived:     { title: 'Driver arrived',  msg: 'Your driver has arrived at the pickup location.' },
    in_progress: { title: 'Ride started',    msg: 'Your ride has started. Enjoy the trip!' },
    completed:   { title: 'Ride completed',  msg: 'Your ride is complete. Thank you for riding with Jih!' },
  };
  try {
    const rideRes = await pool.query(
      `SELECT * FROM rides WHERE id=$1 AND driver_id=$2`,
      [req.params.id, req.user.id]
    );
    const ride = rideRes.rows[0];
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    const next = NEXT[ride.status];
    if (!next) return res.status(400).json({ error: 'Cannot advance this ride' });
    const result = await pool.query(
      `UPDATE rides SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [next, ride.id]
    );
    if (NOTIFY[next]) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,$4)`,
        [ride.passenger_id, NOTIFY[next].title, NOTIFY[next].msg, 'ride_status']
      );
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/driver/history — completed/cancelled rides for this driver
router.get('/history', authenticate, authorize('driver'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.name AS passenger_name
       FROM rides r
       LEFT JOIN users u ON u.id = r.passenger_id
       WHERE r.driver_id = $1
         AND r.status IN ('completed','cancelled')
       ORDER BY r.updated_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/driver/stats — earnings summary
router.get('/stats', authenticate, authorize('driver'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*)                        FILTER (WHERE status='completed')                                                          AS total_rides,
         COALESCE(SUM(fare)              FILTER (WHERE status='completed'), 0)                                                      AS total_earned,
         COUNT(*)                        FILTER (WHERE status='completed' AND updated_at >= NOW() - INTERVAL '1 day')               AS today_rides,
         COALESCE(SUM(fare)              FILTER (WHERE status='completed' AND updated_at >= NOW() - INTERVAL '1 day'), 0)           AS today_earned,
         COUNT(*)                        FILTER (WHERE status='completed' AND updated_at >= date_trunc('month', NOW()))             AS month_rides,
         COALESCE(SUM(fare)              FILTER (WHERE status='completed' AND updated_at >= date_trunc('month', NOW())), 0)         AS month_earned,
         ROUND(AVG(driver_rating)        FILTER (WHERE driver_rating IS NOT NULL), 1)                                               AS avg_rating,
         COUNT(driver_rating)            FILTER (WHERE driver_rating IS NOT NULL)                                                   AS rating_count
       FROM rides WHERE driver_id=$1`,
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
