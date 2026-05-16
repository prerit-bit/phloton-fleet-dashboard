/**
 * Fast 1-minute job: refresh only unit_snapshots (the latest values the
 * bot & alerts read) and evaluate alerts. No historical backfill, no
 * geocoding — those stay on the heavier 5-minute run-sync job.
 *
 * Finishes in seconds and is light on Anedya, so a 1-min cadence is safe.
 * Shares a concurrency lock with the full sync so they never overlap.
 */

import { runSync } from "../src/lib/sync";
import { evaluateAlerts } from "../src/lib/alerts";

async function main() {
  const r = await runSync({ snapshotOnly: true });
  console.log("Snapshot sync:", JSON.stringify(r));

  try {
    const a = await evaluateAlerts();
    console.log("Alerts:", JSON.stringify(a));
  } catch (err) {
    console.error("Alert evaluation failed (non-fatal):", err);
  }

  // Snapshot fetches are flaky per-unit; only fail on a real wipeout.
  const fatal = r.unitsProcessed === 0;
  process.exit(fatal ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
