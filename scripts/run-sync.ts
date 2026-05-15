/**
 * Standalone sync entrypoint for the scheduled GitHub Actions job.
 *
 * Runs the same Anedya → Supabase sync as /api/sync, but with no
 * serverless time cap (the full run takes several minutes). Env vars
 * are injected from GitHub Actions secrets.
 */

import { runSync } from "../src/lib/sync";

runSync()
  .then((r) => {
    console.log("Sync complete:", JSON.stringify(r));

    // Only fail the workflow (→ alert email) on a *real* problem, not a
    // few transient per-unit snapshot blips that self-heal next cycle.
    // Real failure = nothing synced, or errors hit >half the fleet.
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
  })
  .catch((err) => {
    console.error("Sync failed:", err);
    process.exit(1);
  });
