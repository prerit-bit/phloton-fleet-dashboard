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
