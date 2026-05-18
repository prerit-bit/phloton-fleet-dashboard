/**
 * Full historical sync entrypoint (5-min GitHub Actions job).
 *
 * Syncs Anedya → Supabase (sensor_readings + snapshots) and geocodes.
 * Alert evaluation lives in the 1-min snapshot job ONLY — this workflow
 * and the snapshot workflow now run in independent concurrency groups,
 * so evaluating alerts in both would race on alert state.
 */

import { runSync } from "../src/lib/sync";
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
