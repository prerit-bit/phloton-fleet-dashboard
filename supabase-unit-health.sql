-- ============================================================================
-- Phloton — unit_health: daily device-health scores from the tier-1 model.
-- 29 rows, upserted daily by .github/workflows/health.yml. Tiny by design.
-- Run once in the Supabase SQL editor.
-- ============================================================================
CREATE TABLE IF NOT EXISTS unit_health (
  unit_number   INT PRIMARY KEY,
  health_score  INT,                    -- 0-100; NULL = no data to score
  status        TEXT NOT NULL DEFAULT 'no_data'
                CHECK (status IN ('ok','watch','degraded','action','no_data')),
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_data_day DATE,
  active_days   INT,
  concerns      JSONB NOT NULL DEFAULT '[]',   -- [{severity, text}]
  indicators    JSONB NOT NULL DEFAULT '{}'    -- latest HI values + fleet z
);

ALTER TABLE unit_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owned health read" ON unit_health;
CREATE POLICY "owned health read" ON unit_health
  FOR SELECT TO authenticated
  USING (public.owns_unit(unit_number));
REVOKE ALL ON unit_health FROM anon;
GRANT SELECT ON unit_health TO authenticated;
