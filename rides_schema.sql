CREATE TABLE IF NOT EXISTS rides (
  id SERIAL PRIMARY KEY,
  passenger_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  driver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  pickup_address TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  vehicle_type VARCHAR(20) NOT NULL DEFAULT 'tuktuk',
  fare NUMERIC(8,2),
  distance_km NUMERIC(6,2),
  duration_min INTEGER,
  payment_method VARCHAR(20) DEFAULT 'cash',
  ride_type VARCHAR(10) DEFAULT 'private',
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','matched','arrived','in_progress','completed','cancelled')),
  scheduled_at TIMESTAMP,
  driver_rating INTEGER CHECK (driver_rating BETWEEN 1 AND 5),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rides_passenger ON rides(passenger_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver    ON rides(driver_id);
CREATE INDEX IF NOT EXISTS idx_rides_status    ON rides(status);
