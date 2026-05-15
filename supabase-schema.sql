-- ============================================================================
-- Phloton Fleet Dashboard — Supabase Schema
-- Run this in your Supabase SQL Editor to set up the database.
-- ============================================================================

-- 1. Sensor readings — the main time-series table
-- Stores every data point synced from Anedya, deduplicated by (node + variable + time)
CREATE TABLE IF NOT EXISTS sensor_readings (
  id            BIGSERIAL PRIMARY KEY,
  unit_number   INT NOT NULL,
  node_id       TEXT NOT NULL,
  variable_key  TEXT NOT NULL,       -- e.g. "variable_1"
  variable_name TEXT NOT NULL,       -- e.g. "Battery SoC"
  value         DOUBLE PRECISION NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL,
  synced_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint to prevent duplicate readings
ALTER TABLE sensor_readings
  ADD CONSTRAINT uq_reading UNIQUE (node_id, variable_key, recorded_at);

-- Fast lookups by unit + variable + time (the main dashboard query pattern)
CREATE INDEX IF NOT EXISTS idx_readings_unit_var_time
  ON sensor_readings (unit_number, variable_key, recorded_at DESC);

-- For sync cursor lookups
CREATE INDEX IF NOT EXISTS idx_readings_node_var_time
  ON sensor_readings (node_id, variable_key, recorded_at DESC);

-- 2. Unit snapshots — latest status of each unit (gauges, map, fleet cards)
CREATE TABLE IF NOT EXISTS unit_snapshots (
  unit_number     INT PRIMARY KEY,
  node_id         TEXT NOT NULL,
  online          BOOLEAN,
  battery_soc     DOUBLE PRECISION,
  battery_voltage DOUBLE PRECISION,
  flask_temp      DOUBLE PRECISION,
  ambient_temp    DOUBLE PRECISION,
  fault_status    TEXT,
  latitude        DOUBLE PRECISION,
  longitude       DOUBLE PRECISION,
  last_data_at    TIMESTAMPTZ,       -- timestamp of last sensor reading
  synced_at       TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Sync state — tracks where each (node, variable) left off for incremental sync
CREATE TABLE IF NOT EXISTS sync_state (
  node_id              TEXT NOT NULL,
  variable_key         TEXT NOT NULL,
  last_synced_timestamp BIGINT NOT NULL DEFAULT 0,  -- Unix seconds
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (node_id, variable_key)
);

-- 4. Sync log — audit trail for debugging
CREATE TABLE IF NOT EXISTS sync_log (
  id          BIGSERIAL PRIMARY KEY,
  started_at  TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'running',  -- running | success | error
  units_synced INT DEFAULT 0,
  points_synced INT DEFAULT 0,
  error_message TEXT,
  details     JSONB
);

-- ============================================================================
-- Helper: Aggregated data view for fast dashboard charts
-- Returns hourly averages per unit per variable — great for lifetime views
-- ============================================================================
CREATE OR REPLACE VIEW sensor_readings_hourly AS
SELECT
  unit_number,
  variable_key,
  variable_name,
  DATE_TRUNC('hour', recorded_at) AS bucket,
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  COUNT(*) AS point_count
FROM sensor_readings
GROUP BY unit_number, variable_key, variable_name, DATE_TRUNC('hour', recorded_at);

-- ============================================================================
-- Row Level Security (optional but recommended)
-- For now, allow full access via service role key (used by sync + dashboard)
-- ============================================================================
ALTER TABLE sensor_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_log ENABLE ROW LEVEL SECURITY;

-- Service role bypass (the service key used by your app has full access)
CREATE POLICY "Service role full access" ON sensor_readings
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON unit_snapshots
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON sync_state
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON sync_log
  FOR ALL USING (true) WITH CHECK (true);
