-- ============================================================================
-- Phloton — emergency disk slim after the July 2026 quota lockout.
-- Run in the Supabase SQL Editor AS SOON AS the project is writable again
-- (after Pro upgrade / restriction lift). Statements are ordered; run the
-- numbered blocks one at a time and eyeball each result.
--
-- Root cause being fixed: the nightly retention job's oldest-row probe had
-- no usable index, timed out, and the error was read as "nothing to archive"
-- — so raw 5-second rows accumulated unbounded. Code-side fixes (fail-loud
-- retention, 6h raw window in sync) are in the repo; this file fixes the
-- database state and the retention function itself.
-- ============================================================================

-- 0. Session prep + how big are we?
SET statement_timeout = '30min';
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_total,
       pg_size_pretty(pg_total_relation_size('public.sensor_readings')) AS readings;

-- 1. Tighten the retention function: aggregate raw older than 1 DAY (was 7).
CREATE OR REPLACE FUNCTION public.phloton_retention_step()
RETURNS TABLE (buckets_aggregated INT, rows_deleted INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_buckets INT := 0;
  v_deleted INT := 0;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _old_buckets ON COMMIT DROP AS
  SELECT
    unit_number,
    MIN(node_id)       AS node_id,
    variable_key,
    MIN(variable_name) AS variable_name,
    date_trunc('hour', recorded_at) AS bucket,
    AVG(value)         AS avg_val
  FROM sensor_readings
  WHERE recorded_at < NOW() - INTERVAL '1 day'
  GROUP BY unit_number, variable_key, date_trunc('hour', recorded_at)
  HAVING COUNT(*) > 1
      OR (COUNT(*) = 1
          AND date_trunc('hour', MIN(recorded_at)) <> MIN(recorded_at));

  SELECT COUNT(*) INTO v_buckets FROM _old_buckets;

  INSERT INTO sensor_readings (
    unit_number, node_id, variable_key, variable_name,
    value, recorded_at, synced_at
  )
  SELECT
    unit_number, node_id, variable_key, variable_name,
    avg_val, bucket, NOW()
  FROM _old_buckets
  ON CONFLICT (node_id, variable_key, recorded_at)
  DO UPDATE SET value = EXCLUDED.value;

  WITH d AS (
    DELETE FROM sensor_readings sr
    USING _old_buckets ob
    WHERE sr.unit_number  = ob.unit_number
      AND sr.variable_key = ob.variable_key
      AND date_trunc('hour', sr.recorded_at) = ob.bucket
      AND sr.recorded_at < NOW() - INTERVAL '1 day'
      AND sr.recorded_at <> ob.bucket
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted FROM d;

  DELETE FROM sync_log WHERE started_at < NOW() - INTERVAL '30 days';

  RETURN QUERY SELECT v_buckets, v_deleted;
END;
$$;

-- 2. Run it — this is the big one (aggregates + deletes weeks of raw rows).
SELECT * FROM public.phloton_retention_step();

-- 3. Reclaim the disk (exclusive lock ~1-2 min; dashboard briefly blocked).
VACUUM FULL sensor_readings;
VACUUM ANALYZE sync_log;

-- 4. The index the retention probe needed all along (cheap on the slim table).
CREATE INDEX IF NOT EXISTS idx_readings_recorded_at
  ON sensor_readings (recorded_at);

-- 5. Verify: expect well under 200 MB total.
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_total,
       pg_size_pretty(pg_total_relation_size('public.sensor_readings')) AS readings,
       (SELECT COUNT(*) FROM sensor_readings) AS reading_rows;
