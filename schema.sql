-- schema.sql — Esegui una volta nel Neon SQL Editor.
-- Idempotente: CREATE TABLE IF NOT EXISTS, rieseguibile senza rischi.
-- Usato da: api/sync.js (upsert) e api/activities.js (lettura).

CREATE TABLE IF NOT EXISTS activities (
  id SERIAL PRIMARY KEY,
  activity_id BIGINT UNIQUE NOT NULL,
  name TEXT,
  activity_type TEXT,
  start_time TIMESTAMPTZ,
  distance_m DOUBLE PRECISION DEFAULT 0,
  duration_s DOUBLE PRECISION DEFAULT 0,
  avg_pace_min_km DOUBLE PRECISION,
  avg_hr INT,
  max_hr INT,
  calories INT,
  elevation_gain_m DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activities_start_time
  ON activities (start_time DESC);

CREATE TABLE IF NOT EXISTS daily_metrics (
  id SERIAL PRIMARY KEY,
  date DATE UNIQUE NOT NULL,
  steps INT,
  distance_m DOUBLE PRECISION,
  calories INT,
  resting_hr INT
);

CREATE INDEX IF NOT EXISTS idx_daily_metrics_date
  ON daily_metrics (date DESC);

-- Profili: riga singola (id=1) con le credenziali Garmin impostate
-- dalla sezione Profilo della dashboard. Preferite alle env vars.
CREATE TABLE IF NOT EXISTS profiles (
  id INT PRIMARY KEY DEFAULT 1,
  garmin_email TEXT,
  garmin_password TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT single_profile CHECK (id = 1)
);

-- Token OAuth per riuso sessione (evitano login + MFA a ogni sync).
-- Sicuri da rieseguire anche se la tabella esiste già:
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS oauth1_token TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS oauth2_token TEXT;
