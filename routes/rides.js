const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

// POST /api/rides — create a ride (passenger)
router.post('/', authenticate, authorize('passenger'), async (req, res) => {
  const {
    pickup_address, destination_address, vehicle_type, fare, distance_km, duration_min,
    payment_method, ride_type, booking_type, offered_fare, hire_description, scheduled_at,
  } = req.body;
  const btype = booking_type || 'standard';
  if (btype === 'standard' && (!pickup_address || !destination_address))
    return res.status(400).json({ error: 'Pickup and destination are required' });
  if (btype === 'full_day' && !pickup_address)
    return res.status(400).json({ error: 'Pickup is required for full day hire' });
  try {
    const status = btype === 'scheduled' ? 'scheduled' : 'pending';
    const result = await pool.query(
      `INSERT INTO rides
        (passenger_id, pickup_address, destination_address, vehicle_type, fare, offered_fare,
         hire_description, distance_km, duration_min, payment_method, ride_type, booking_type,
         scheduled_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.user.id, pickup_address, destination_address || null, vehicle_type || 'tuktuk',
       fare || null, offered_fare || null, hire_description || null,
       distance_km || null, duration_min || null, payment_method || 'cash',
       ride_type || 'private', btype, scheduled_at || null, status]
    );
    // Auto-create notification
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES ($1,$2,$3,$4)`,
      [req.user.id,
       btype === 'scheduled' ? 'Ride Scheduled' : 'Ride Booked',
       btype === 'scheduled'
         ? `Your ride is scheduled for ${scheduled_at}`
         : `Looking for a driver to ${destination_address || 'your destination'}…`,
       'ride_booked']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rides/active — current active ride for passenger
router.get('/active', authenticate, authorize('passenger'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.name AS driver_name, u.email AS driver_email
       FROM rides r
       LEFT JOIN users u ON u.id = r.driver_id
       WHERE r.passenger_id = $1
         AND r.status IN ('pending','matched','arrived','in_progress')
       ORDER BY r.created_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rides/history — past rides for passenger
router.get('/history', authenticate, authorize('passenger'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.name AS driver_name
       FROM rides r
       LEFT JOIN users u ON u.id = r.driver_id
       WHERE r.passenger_id = $1
         AND r.status IN ('completed','cancelled')
       ORDER BY r.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rides/upcoming — pending/scheduled rides
router.get('/upcoming', authenticate, authorize('passenger'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM rides
       WHERE passenger_id = $1
         AND status IN ('pending','matched','arrived','in_progress')
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/rides/:id/cancel — passenger cancels ride
router.patch('/:id/cancel', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE rides SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND passenger_id=$2 AND status IN ('pending','matched')
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ride not found or cannot be cancelled' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/rides/:id/rate — passenger rates driver
router.patch('/:id/rate', authenticate, authorize('passenger'), async (req, res) => {
  const { rating } = req.body;
  if (!rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'Rating must be 1–5' });
  try {
    const result = await pool.query(
      `UPDATE rides SET driver_rating=$1, updated_at=NOW()
       WHERE id=$2 AND passenger_id=$3 AND status='completed'
       RETURNING *`,
      [rating, req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ride not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rides/:id — single ride detail
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.name AS driver_name
       FROM rides r LEFT JOIN users u ON u.id = r.driver_id
       WHERE r.id=$1 AND r.passenger_id=$2`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ride not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
