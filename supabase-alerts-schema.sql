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
