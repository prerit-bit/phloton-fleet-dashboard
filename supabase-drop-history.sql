-- ============================================================================
-- Phloton — STEP 6 of the Anedya-direct migration: drop the history store.
--
-- ⛔ GATED: run only after ≥1 week of green burn-in on the Anedya-direct
-- charts/exports (shipped 2026-08-10). Until then sensor_readings is
-- harmless dead weight — nothing reads it, nothing writes it.
--
-- After this runs, Supabase holds only auth + unit_snapshots + alert state
-- (~5-10 MB steady-state) and no table in the project can grow into the
-- free-tier quota. The failure class that bricked two projects is extinct.
-- ============================================================================

-- 1. Views first (they depend on the table).
DROP VIEW IF EXISTS sensor_readings_5min;
DROP VIEW IF EXISTS sensor_readings_hourly;

-- 2. The table that ate two projects.
DROP TABLE IF EXISTS sensor_readings;

-- 3. Retention machinery (nothing left to retain).
DROP FUNCTION IF EXISTS public.phloton_retention_step();

-- 4. Re-point the nightly cron: vacuum job referenced sensor_readings;
--    replace with a sync_log trim (the one remaining slow-growing table).
SELECT cron.unschedule('vacuum-sensor-readings');
SELECT cron.schedule('trim-sync-log', '0 4 * * *',
  $$DELETE FROM sync_log WHERE started_at < NOW() - INTERVAL '30 days'; VACUUM ANALYZE sync_log$$);

-- 5. Verify the end state.
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_total;
SELECT jobname, schedule, active FROM cron.job;
