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
    process.exit(r.errors.length > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error("Sync failed:", err);
    process.exit(1);
  });
