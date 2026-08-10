# Supabase Fresh-Project Rebuild Runbook

Context: the original project (`bbmiirqlhwzlxoanfthy`) hit the free-tier 500MB
disk ceiling (1.6GB `sensor_readings`, mostly index bloat from a 365-day
backfill), entered read-only mode, then wedged with compute pinned at 100%
CPU and never came back up. The DB is a cache of Anedya — nothing
irreplaceable lives in it. This runbook rebuilds on a fresh project with the
root causes fixed.

## What's different this time

1. **30-day backfill, not 365** — `sync.ts` now defaults to
   `SYNC_BACKFILL_DAYS=30`. Expect ~200–400k rows instead of 2.7M.
2. **No redundant index** — `idx_readings_node_var_time` duplicated the
   `uq_reading` unique constraint and cost ~300–400MB. Dropped after setup.
3. **Out-of-bounds filtering at sync time** — already in `sensor-bounds.ts`,
   so hardware-impossible spikes never land in the DB.
4. **Nightly `pg_cron` VACUUM** — scheduled from day one.

## Step 1 — Create the new project

- supabase.com → New project. Same org is fine if it allows creation; if the
  over-quota org blocks it, create a new (free) org first.
- Region: ap-south-1 / closest to existing.
- Note the project URL + anon key + service_role key (Settings → API Keys).

## Step 2 — Run schema files in the SQL Editor, in this order

1. `supabase-schema.sql`        (tables, indexes, hourly view)
2. `supabase-5min-schema.sql`   (5-minute view)
3. `supabase-auth-schema.sql`   (profiles, device_owners, RLS, trigger)
4. `supabase-alerts-schema.sql`
5. `supabase-geocode-schema.sql`
6. `supabase-whatsapp-schema.sql`
7. `supabase-retention-schema.sql`

## Step 3 — Post-schema fixes (one paste)

```sql
-- The unique constraint uq_reading already covers (node_id, variable_key,
-- recorded_at) lookups; this second index was pure disk cost.
DROP INDEX IF EXISTS idx_readings_node_var_time;

-- Nightly vacuum, 30 min after the retention workflow.
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('vacuum-sensor-readings', '0 4 * * *',
                     'VACUUM ANALYZE sensor_readings');
```

## Step 4 — Recreate users

- Auth → Users → invite/create the 3 users (prerit@phloton.com + customers).
- Then in SQL Editor:

```sql
UPDATE public.profiles SET role = 'admin' WHERE email = 'prerit@phloton.com';

-- One row per customer→unit mapping, e.g.:
-- INSERT INTO public.device_owners (user_id, unit_number)
-- SELECT id, 19 FROM auth.users WHERE email = 'customer@example.com';
```

- If Telegram/WhatsApp bot is used: re-set `profiles.telegram_id` /
  `profiles.phone` manually (same values as before).

## Step 5 — Rotate secrets in THREE places

New values: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`. (Anedya + GDrive secrets unchanged.)

1. `.env.local` (local dev)
2. Vercel → project → Settings → Environment Variables (Production) → redeploy
3. GitHub repo → Settings → Secrets and variables → Actions

## Step 6 — First sync + verify

- Push/merge the `SYNC_BACKFILL_DAYS` change BEFORE pointing secrets at the
  new project, or Actions will 365-day-backfill the new DB too.
- Trigger `sync.yml` via workflow_dispatch; expect a few minutes.
- Verify: `SELECT pg_size_pretty(pg_database_size(current_database()));`
  should be well under 200MB. Dashboard login + charts + gauges work.

## Step 7 — Delete the old project (LAST)

Only after Step 6 verifies. Old project → Settings → General → Delete
project. This also releases the org's disk-quota pressure.

Optional deeper history: old raw data lives in Google Drive as
`phloton-raw-YYYY-MM-DD.csv.gz`; a deeper backfill can also be pulled from
Anedya later by re-running sync with `SYNC_BACKFILL_DAYS=180` BEFORE the
cursor exists (it only applies to first sync per node+variable).

---

## Rebuild #3 addendum (July 2026)

Why again: the retention job's oldest-row probe timed out (no recorded_at
index), the error was silently swallowed, and raw 5s rows accumulated to the
quota → project paused, restore blocked (org restricted) — a circular trap
with no free-tier exit. Fixes now baked in:

- `supabase-fresh-all.sql` regenerated with a v2 tail: no duplicate index,
  `idx_readings_recorded_at`, retention cutoff **1 day**, `phloton_db_size_mb`
  RPC, pg_cron vacuum. One paste = fully guarded schema.
- Code (already on main): sync raw window **6 h**, retention **fails loudly**
  on any probe error, and each full sync checks DB size and Telegram-alerts
  the ops chat past `SIZE_ALERT_MB` (default 350).

Rebuild-#3 specific steps:
1. **Create a NEW free org first** — the old org is under service restriction
   and blocks both project creation and restore.
2. New project in that org → SQL editor → paste ALL of `supabase-fresh-all.sql`.
3. Auth → create the users → admin UPDATE + `device_owners` INSERTs (Step 4 of
   the original runbook). Reset `profiles.telegram_id` if bot replies matter.
4. Hand URL + anon + service_role keys to Claude for rotation across
   `.env.local`, GitHub Actions secrets, and Vercel env + redeploy + workflow
   re-enable + first-sync verification.
5. After verification, the old org/project can be deleted entirely.

Planned follow-on (kills the failure class): serve charts from Anedya directly
via an authorized Next.js API route; Supabase keeps only auth + snapshots +
alert state (~10-20 MB steady-state, immune to any quota).
