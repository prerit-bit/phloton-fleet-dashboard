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
