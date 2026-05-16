/**
 * Standalone sync + alert entrypoint for the scheduled GitHub Actions job.
 *
 * 1. Sync Anedya → Supabase (no serverless time cap).
 * 2. Evaluate alert rules on the fresh snapshots and notify owners/ops.
 *
 * Alert evaluation is best-effort: a failure there is logged but never
 * fails the workflow (data already synced; we don't want alert plumbing
 * to page anyone). Env vars come from GitHub Actions secrets.
 */

import { runSync } from "../src/lib/sync";
import { evaluateAlerts } from "../src/lib/alerts";
import { backfillLocationNames } from "../src/lib/geocode";
import { supabaseAdmin } from "../src/lib/supabase";

async function main() {
  const r = await runSync();
  console.log("Sync complete:", JSON.stringify(r));

  try {
    if (supabaseAdmin) {
      const n = await backfillLocationNames(supabaseAdmin);
      if (n > 0) console.log(`Geocoded ${n} unit location(s).`);
    }
  } catch (err) {
    console.error("Geocode backfill failed (non-fatal):", err);
  }

  try {
    const a = await evaluateAlerts();
    console.log("Alerts:", JSON.stringify(a));
  } catch (err) {
    console.error("Alert evaluation failed (non-fatal):", err);
  }

  // Only fail the workflow (→ alert email) on a *real* sync problem, not
  // a few transient per-unit snapshot blips that self-heal next cycle.
  const fatal =
    r.unitsProcessed === 0 ||
    (r.totalPointsSynced === 0 && r.errors.length > 0) ||
    r.errors.length > r.unitsProcessed / 2;

  if (r.errors.length > 0 && !fatal) {
    console.warn(
      `Sync OK with ${r.errors.length} transient error(s) — not failing the run.`
    );
  }
  process.exit(fatal ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
