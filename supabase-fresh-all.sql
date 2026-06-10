
-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  SOURCE: supabase-schema.sql
-- ╚══════════════════════════════════════════════════════════════════╝
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

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  SOURCE: supabase-5min-schema.sql
-- ╚══════════════════════════════════════════════════════════════════╝
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

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  SOURCE: supabase-auth-schema.sql
-- ╚══════════════════════════════════════════════════════════════════╝
-- ============================================================================
-- Phloton Fleet Dashboard — Auth & Per-User Access (Phase 1)
--
-- Run this in the Supabase SQL Editor AFTER supabase-schema.sql.
-- It is additive: it does not drop or modify any sync data, only the
-- wide-open RLS policies that currently expose every unit to everyone.
--
-- Model:
--   - Each customer is a Supabase Auth user (email + password).
--   - profiles.role = 'customer' (default) | 'admin' (sees all units).
--   - device_owners maps a user to the unit_number(s) they may see
--     (many-to-many: one user can own several units).
--   - The Vercel sync uses the service_role key, which BYPASSES RLS,
--     so the sync pipeline keeps working untouched.
-- ============================================================================


-- ─── 1. Profiles (role per auth user) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS profiles (
  user_id    UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email      TEXT,
  role       TEXT NOT NULL DEFAULT 'customer'
               CHECK (role IN ('customer', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-create a profile row whenever a new auth user is created.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill profiles for any users that already exist.
INSERT INTO public.profiles (user_id, email)
SELECT id, email FROM auth.users
ON CONFLICT (user_id) DO NOTHING;


-- ─── 2. Device ownership (user → unit_number, many-to-many) ─────────────────

CREATE TABLE IF NOT EXISTS device_owners (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  unit_number INT  NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_device_owner UNIQUE (user_id, unit_number)
);

CREATE INDEX IF NOT EXISTS idx_device_owners_user ON device_owners (user_id);
CREATE INDEX IF NOT EXISTS idx_device_owners_unit ON device_owners (unit_number);


-- ─── 3. Helper functions (SECURITY DEFINER → no RLS recursion) ──────────────

-- TRUE if the current auth user has the admin role.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = auth.uid() AND role = 'admin'
  );
$$;

-- TRUE if the current auth user owns the given unit (admins own everything).
CREATE OR REPLACE FUNCTION public.owns_unit(p_unit INT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.device_owners
        WHERE user_id = auth.uid() AND unit_number = p_unit
      );
$$;


-- ─── 4. RLS on the new tables ───────────────────────────────────────────────

ALTER TABLE profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_owners ENABLE ROW LEVEL SECURITY;

-- profiles: a user can read their own row; admins can read all.
-- (Writes go through the service_role key, which bypasses RLS.)
DROP POLICY IF EXISTS "own profile read"   ON profiles;
DROP POLICY IF EXISTS "admin profile read" ON profiles;
CREATE POLICY "own profile read" ON profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "admin profile read" ON profiles
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- device_owners: a user can see their own mappings; admins see all.
DROP POLICY IF EXISTS "own ownership read"   ON device_owners;
DROP POLICY IF EXISTS "admin ownership read" ON device_owners;
CREATE POLICY "own ownership read" ON device_owners
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "admin ownership read" ON device_owners
  FOR SELECT TO authenticated
  USING (public.is_admin());


-- ─── 5. Replace the wide-open policies on the data tables ───────────────────
--
-- supabase-schema.sql created `FOR ALL USING (true)` policies that apply to
-- EVERY role (incl. anon + authenticated) — i.e. the whole fleet is public.
-- Drop them and scope reads to owned units. service_role bypasses RLS, so
-- the sync writer is unaffected and needs no policy.

DROP POLICY IF EXISTS "Service role full access" ON sensor_readings;
DROP POLICY IF EXISTS "Service role full access" ON unit_snapshots;
DROP POLICY IF EXISTS "Service role full access" ON sync_state;
DROP POLICY IF EXISTS "Service role full access" ON sync_log;

-- Authenticated users may read only rows for units they own.
DROP POLICY IF EXISTS "owned readings read"  ON sensor_readings;
DROP POLICY IF EXISTS "owned snapshots read" ON unit_snapshots;
CREATE POLICY "owned readings read" ON sensor_readings
  FOR SELECT TO authenticated
  USING (public.owns_unit(unit_number));
CREATE POLICY "owned snapshots read" ON unit_snapshots
  FOR SELECT TO authenticated
  USING (public.owns_unit(unit_number));

-- sync_state / sync_log: no policy → only the service_role (bypass) can
-- touch them. RLS stays enabled (already set in supabase-schema.sql).

-- Lock down direct table grants to the public/anon roles as defense in depth.
REVOKE ALL ON sensor_readings, unit_snapshots, sync_state, sync_log
  FROM anon;
GRANT SELECT ON sensor_readings, unit_snapshots TO authenticated;
GRANT SELECT ON profiles, device_owners        TO authenticated;


-- ─── 6. Make the hourly view respect table RLS ──────────────────────────────
--
-- A normal view runs with the view owner's privileges, which would BYPASS
-- the RLS above. security_invoker makes it run as the querying user so the
-- owns_unit() filter on sensor_readings applies through the view too.

ALTER VIEW sensor_readings_hourly SET (security_invoker = true);

REVOKE ALL ON sensor_readings_hourly FROM anon;
GRANT SELECT ON sensor_readings_hourly TO authenticated;


-- ============================================================================
-- Admin bootstrap (run once, after you create your own user):
--
--   UPDATE public.profiles SET role = 'admin'
--   WHERE email = 'you@phloton.com';
--
-- Provision a customer (after inviting them via Auth → Users):
--
--   INSERT INTO public.device_owners (user_id, unit_number)
--   SELECT id, 19 FROM auth.users WHERE email = 'customer@example.com';
-- ============================================================================

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  SOURCE: supabase-alerts-schema.sql
-- ╚══════════════════════════════════════════════════════════════════╝
-- ============================================================================
-- Phloton — alert engine state + audit log.
-- Run in the Supabase SQL Editor after supabase-auth-schema.sql.
-- Additive. Service-role only (the sync/alert job uses the service key,
-- which bypasses RLS); no client ever reads these.
-- ============================================================================

-- Current state of every (unit, rule) incident. Upserted each evaluation.
--   state: 'pending' (condition seen, sustain timer running)
--        | 'open'    (alerting)
--        | 'cleared' (recovered)
CREATE TABLE IF NOT EXISTS device_alerts (
  unit_number     INT  NOT NULL,
  rule            TEXT NOT NULL,
  severity        TEXT NOT NULL,
  state           TEXT NOT NULL,
  value           DOUBLE PRECISION,
  opened_at       TIMESTAMPTZ,
  cleared_at      TIMESTAMPTZ,
  last_notified_at TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (unit_number, rule)
);

-- Append-only audit trail (cold-chain compliance: who/what/when).
CREATE TABLE IF NOT EXISTS alert_events (
  id          BIGSERIAL PRIMARY KEY,
  unit_number INT  NOT NULL,
  rule        TEXT NOT NULL,
  severity    TEXT NOT NULL,
  event       TEXT NOT NULL,            -- opened | reminder | cleared
  value       DOUBLE PRECISION,
  message     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_events_unit_time
  ON alert_events (unit_number, created_at DESC);

-- RLS on; no policies → only the service role (which bypasses RLS) can
-- touch these. Matches sync_state / sync_log.
ALTER TABLE device_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_events  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON device_alerts, alert_events FROM anon, authenticated;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  SOURCE: supabase-geocode-schema.sql
-- ╚══════════════════════════════════════════════════════════════════╝
-- ============================================================================
-- Phloton — cached reverse-geocoded place name for units.
-- Run in the Supabase SQL Editor (alongside supabase-alerts-schema.sql).
-- Additive; service-role only path (sync writes it).
-- ============================================================================

-- Human-readable area (e.g. "Bengaluru, Karnataka") + the rounded
-- lat/lng key it was geocoded from, so we only re-geocode when the
-- unit's (city-level) location actually moves.
ALTER TABLE public.unit_snapshots
  ADD COLUMN IF NOT EXISTS location_name TEXT,
  ADD COLUMN IF NOT EXISTS geocoded_key  TEXT;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  SOURCE: supabase-whatsapp-schema.sql
-- ╚══════════════════════════════════════════════════════════════════╝
-- ============================================================================
-- Phloton — chat-agent identity mapping (prototype).
-- Maps a WhatsApp number and/or Telegram user id to a Phloton user.
-- Run in the Supabase SQL Editor after supabase-auth-schema.sql.
-- Additive; does not touch existing data.
-- ============================================================================

-- WhatsApp number in E.164 (e.g. +919812345678); Telegram numeric user id.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone       TEXT,
  ADD COLUMN IF NOT EXISTS telegram_id TEXT;

-- Fast lookups when an inbound message arrives.
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_phone
  ON public.profiles (phone)
  WHERE phone IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_telegram
  ON public.profiles (telegram_id)
  WHERE telegram_id IS NOT NULL;

-- ============================================================================
-- Link YOUR accounts for testing (admin → sees all units).
--
-- Telegram: message the bot once; it replies with "Your Telegram ID: <N>".
--   UPDATE public.profiles SET telegram_id = '<N>'
--   WHERE email = 'prerit@phloton.com';
--
-- WhatsApp (when Twilio works): full E.164, no spaces.
--   UPDATE public.profiles SET phone = '+919812345678'
--   WHERE email = 'prerit@phloton.com';
-- ============================================================================

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  SOURCE: supabase-retention-schema.sql
-- ╚══════════════════════════════════════════════════════════════════╝
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

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  POST-SETUP FIXES (fresh-project rebuild, June 2026)
-- ╚══════════════════════════════════════════════════════════════════╝
-- uq_reading already covers (node_id, variable_key, recorded_at);
-- this duplicate index cost ~300-400MB on the old project.
DROP INDEX IF EXISTS idx_readings_node_var_time;

CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('vacuum-sensor-readings', '0 4 * * *',
                     'VACUUM ANALYZE sensor_readings');
