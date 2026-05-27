-- ─────────────────────────────────────────────────────
--  Jih Ride-Hailing — full schema
--  Safe to run multiple times (IF NOT EXISTS / ON CONFLICT)
-- ─────────────────────────────────────────────────────

-- Users
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100)  NOT NULL,
  email         VARCHAR(150)  UNIQUE NOT NULL,
  password_hash VARCHAR(255)  NOT NULL,
  role          VARCHAR(20)   NOT NULL DEFAULT 'passenger'
                CHECK (role IN ('passenger', 'driver', 'admin')),
  is_verified   BOOLEAN       DEFAULT FALSE,
  created_at    TIMESTAMP     DEFAULT NOW()
);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token      VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Rides
CREATE TABLE IF NOT EXISTS rides (
  id                  SERIAL PRIMARY KEY,
  passenger_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  driver_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  pickup_address      TEXT    NOT NULL,
  destination_address TEXT    NOT NULL,
  vehicle_type        VARCHAR(20)  NOT NULL DEFAULT 'tuktuk',
  fare                NUMERIC(8,2),
  offered_fare        NUMERIC(8,2),
  distance_km         NUMERIC(6,2),
  duration_min        INTEGER,
  payment_method      VARCHAR(20)  DEFAULT 'cash',
  booking_type        VARCHAR(20)  DEFAULT 'standard',
  ride_type           VARCHAR(10)  DEFAULT 'private',
  status              VARCHAR(20)  NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','matched','arrived','in_progress','completed','cancelled','scheduled')),
  scheduled_at        TIMESTAMP,
  driver_rating       INTEGER      CHECK (driver_rating BETWEEN 1 AND 5),
  notes               TEXT,
  created_at          TIMESTAMP    DEFAULT NOW(),
  updated_at          TIMESTAMP    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rides_passenger ON rides(passenger_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver    ON rides(driver_id);
CREATE INDEX IF NOT EXISTS idx_rides_status    ON rides(status);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title      VARCHAR(255),
  message    TEXT,
  type       VARCHAR(100) DEFAULT 'info',
  is_read    BOOLEAN      DEFAULT FALSE,
  created_at TIMESTAMP    DEFAULT NOW()
);

-- Fare config
CREATE TABLE IF NOT EXISTS fare_config (
  vehicle_type VARCHAR(50)   PRIMARY KEY,
  base_fare    NUMERIC(10,2) DEFAULT 1.00,
  per_km       NUMERIC(10,2) DEFAULT 0.50,
  per_min      NUMERIC(10,2) DEFAULT 0.10,
  min_fare     NUMERIC(10,2) DEFAULT 2.00,
  updated_at   TIMESTAMP     DEFAULT NOW()
);

INSERT INTO fare_config (vehicle_type, base_fare, per_km, per_min, min_fare) VALUES
  ('tuktuk', 1.00, 0.40, 0.08, 1.50),
  ('moto',   0.75, 0.30, 0.06, 1.00),
  ('car',    2.00, 0.70, 0.12, 3.00),
  ('van',    3.00, 1.00, 0.15, 5.00)
ON CONFLICT (vehicle_type) DO NOTHING;

-- Default admin account  (password: Admin@1234)
INSERT INTO users (name, email, password_hash, role, is_verified) VALUES (
  'Admin',
  'admin@jihwolrd.com',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'admin',
  TRUE
) ON CONFLICT (email) DO NOTHING;
