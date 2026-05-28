-- ============================================================================
-- Phloton — retention policy: aggregate raw rows >7 days old into hourly.
--
-- Run in the Supabase SQL Editor. Defines a function the nightly archive
-- job will call via RPC, then runs it ONCE to do the initial cleanup.
--
-- Strategy (transactional, idempotent):
--   1. For every (unit, variable, hour) bucket >7d old, compute AVG of
--      the raw rows and UPSERT a single row at the hour boundary (HH:00:00).
--   2. Delete all other rows in that bucket (the non-aggregate raw rows).
--   3. The unique constraint (node_id, variable_key, recorded_at) keeps
--      the upsert idempotent across runs.
-- ============================================================================

-- 1. The function the nightly job calls every night.
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
  -- Stage candidate buckets in a temp table for two atomic statements.
  CREATE TEMP TABLE IF NOT EXISTS _old_buckets ON COMMIT DROP AS
  SELECT
    unit_number,
    MIN(node_id)       AS node_id,
    variable_key,
    MIN(variable_name) AS variable_name,
    date_trunc('hour', recorded_at) AS bucket,
    AVG(value)         AS avg_val
  FROM sensor_readings
  WHERE recorded_at < NOW() - INTERVAL '7 days'
  GROUP BY unit_number, variable_key, date_trunc('hour', recorded_at)
  HAVING COUNT(*) > 1
      OR (COUNT(*) = 1
          AND date_trunc('hour', MIN(recorded_at)) <> MIN(recorded_at));

  SELECT COUNT(*) INTO v_buckets FROM _old_buckets;

  -- Upsert the canonical HH:00:00 aggregate row.
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

  -- Delete every non-aggregate row inside those buckets.
  WITH d AS (
    DELETE FROM sensor_readings sr
    USING _old_buckets ob
    WHERE sr.unit_number  = ob.unit_number
      AND sr.variable_key = ob.variable_key
      AND date_trunc('hour', sr.recorded_at) = ob.bucket
      AND sr.recorded_at < NOW() - INTERVAL '7 days'
      AND sr.recorded_at <> ob.bucket
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted FROM d;

  -- Trim sync_log too (audit ≠ archive).
  DELETE FROM sync_log WHERE started_at < NOW() - INTERVAL '30 days';

  RETURN QUERY SELECT v_buckets, v_deleted;
END;
$$;

-- Service role can call the function; nothing else needs to.
REVOKE ALL ON FUNCTION public.phloton_retention_step() FROM PUBLIC, anon, authenticated;

-- (No initial cleanup here on purpose — the nightly archive workflow
--  will call this function AFTER it has backed up the raw rows to
--  Google Drive, preserving full-fidelity historical data. Running the
--  function ad-hoc from the SQL editor would aggregate-and-delete raw
--  rows that hadn't been archived yet.)
--
-- After the first archive workflow run completes, you can manually
-- reclaim disk + refresh planner stats from the SQL editor:
--   VACUUM ANALYZE sensor_readings;
--   VACUUM ANALYZE sync_log;
