-- ============================================================================
-- Phloton — 5-minute aggregation view (finer chart resolution for 6h/24h).
-- Run in the Supabase SQL Editor. Additive; doesn't change existing data.
-- ============================================================================
--
-- date_bin gives exact 5-minute boundaries aligned to a fixed origin, so
-- bucket starts are deterministic across queries.

CREATE OR REPLACE VIEW sensor_readings_5min
WITH (security_invoker = true) AS
SELECT
  unit_number,
  variable_key,
  variable_name,
  date_bin('5 minutes'::interval, recorded_at, TIMESTAMPTZ '2000-01-01 00:00:00Z') AS bucket,
  AVG(value)  AS avg_value,
  MIN(value)  AS min_value,
  MAX(value)  AS max_value,
  COUNT(*)    AS point_count
FROM sensor_readings
GROUP BY
  unit_number, variable_key, variable_name,
  date_bin('5 minutes'::interval, recorded_at, TIMESTAMPTZ '2000-01-01 00:00:00Z');

REVOKE ALL  ON sensor_readings_5min FROM anon;
GRANT SELECT ON sensor_readings_5min TO authenticated;
