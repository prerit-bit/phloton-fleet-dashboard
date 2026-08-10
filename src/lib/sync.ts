/**
 * Anedya → Supabase Sync Service — snapshots only.
 *
 * History no longer lives in Supabase at all: charts and exports read
 * Anedya directly through /api/telemetry (Aug 2026). This job now keeps
 * only unit_snapshots fresh (fleet cards, gauges, alerts, bot) plus the
 * disk-size guard. The per-variable historical sync — the code whose
 * growth bricked two free-tier projects — is gone; sensor_readings gets
 * dropped entirely once the Anedya-direct path finishes burn-in.
 */

import { supabaseAdmin } from "./supabase";

// Non-null ref — runSync() guards with a null check before any calls
const supabase = supabaseAdmin!;
import {
  getUnitNumbers,
  getNodeId,
  getAllVariables,
  getDeviceStatus,
  getLatestData,
} from "./anedya";
import { isValidReading } from "./sensor-bounds";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SyncResult {
  unitsProcessed: number;
  totalPointsSynced: number;
  errors: string[];
  duration: number;
}

// ─── Sync unit snapshot (live readings + status) ─────────────────────────────

async function syncUnitSnapshot(unitNumber: number, nodeId: string) {
  const vars = getAllVariables();

  const [status, soc, voltage, flaskTemp, ambientTemp, fault, location] =
    await Promise.all([
      getDeviceStatus(nodeId),
      getLatestData(nodeId, vars.find((v) => v.key === "variable_1")?.identifier || ""),
      getLatestData(nodeId, vars.find((v) => v.key === "variable_2")?.identifier || ""),
      getLatestData(nodeId, vars.find((v) => v.key === "variable_3")?.identifier || ""),
      getLatestData(nodeId, vars.find((v) => v.key === "variable_4")?.identifier || ""),
      getLatestData(nodeId, vars.find((v) => v.key === "variable_5")?.identifier || ""),
      getLatestData(nodeId, "location"),
    ]);

  // Field plan: values come from Anedya /data/latest; anything failed or
  // out-of-bounds is OMITTED from the upsert so we never clobber a
  // previously-good snapshot value with null.
  const plan: {
    col: string;
    key: string;
    res: typeof soc;
    str?: boolean;
  }[] = [
    { col: "battery_soc", key: "variable_1", res: soc },
    { col: "battery_voltage", key: "variable_2", res: voltage },
    { col: "flask_temp", key: "variable_3", res: flaskTemp },
    { col: "ambient_temp", key: "variable_4", res: ambientTemp },
    { col: "fault_status", key: "variable_5", res: fault, str: true },
  ];

  const row: Record<string, any> = {
    unit_number: unitNumber,
    node_id: nodeId,
    synced_at: new Date().toISOString(),
  };
  const tsMs: number[] = [];

  for (const p of plan) {
    // Drop the live reading if it's outside physical bounds (string fields
    // like fault_status are not numeric, so they're never filtered here).
    const liveValid =
      p.str ||
      (typeof p.res.data === "number" && isValidReading(p.col, p.res.data));

    if (p.res.isSuccess && p.res.data != null && liveValid) {
      row[p.col] = p.str ? String(p.res.data) : (p.res.data as number);
      if (typeof p.res.timestamp === "number" && p.res.timestamp > 0)
        tsMs.push(p.res.timestamp * 1000);
    }
    // On a failed/invalid read the column is simply omitted, preserving the
    // previous snapshot value. (The old sensor_readings fallback is gone —
    // that table is being retired with the Anedya-direct migration.)
  }

  // Location only if Anedya returned it; otherwise omit (preserve prior).
  if (location.isSuccess && location.data) {
    row.latitude = (location.data as Record<string, number>).lat;
    row.longitude = (location.data as Record<string, number>).long;
  }

  if (tsMs.length) {
    const newest = Math.max(...tsMs);
    row.last_data_at = new Date(newest).toISOString();
    // Online: trust Anedya status when we have it; otherwise derive from
    // data freshness (reported within the last 30 min).
    row.online =
      typeof status === "boolean"
        ? status
        : Date.now() - newest < 30 * 60_000;
  } else if (typeof status === "boolean") {
    row.online = status;
  }

  await supabase
    .from("unit_snapshots")
    .upsert(row, { onConflict: "unit_number" });
}

// ─── Bounded concurrency pool ────────────────────────────────────────────────

/**
 * Runs `worker` over `items` with at most `limit` promises in flight.
 * JS is single-threaded, so the shared cursor / accumulators mutated by
 * workers are race-free (no await between read and increment of cursor).
 */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const lanes = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        await worker(items[idx]);
      }
    }
  );
  await Promise.all(lanes);
}

// ─── Main sync orchestrator ──────────────────────────────────────────────────

export async function runSync(
  opts: { snapshotOnly?: boolean } = {}
): Promise<SyncResult> {
  // snapshotOnly: refresh only unit_snapshots (latest values the bot &
  // alerts read) — skips the heavy per-variable historical backfill.
  // Finishes in seconds, light on Anedya → safe to run every minute.
  const snapshotOnly = opts.snapshotOnly === true;
  if (!supabase) {
    throw new Error("Supabase service role key not configured");
  }

  const startTime = Date.now();
  const errors: string[] = [];
  let totalPoints = 0;

  // Log sync start
  const { data: logRow } = await supabase
    .from("sync_log")
    .insert({
      started_at: new Date().toISOString(),
      status: "running",
    })
    .select("id")
    .single();
  const logId = logRow?.id;

  const unitNumbers = getUnitNumbers();
  console.log(`[Sync] Snapshot refresh for ${unitNumbers.length} units`);
  const UNIT_CC = Math.max(1, Number(process.env.SYNC_UNIT_CONCURRENCY ?? 5));

  await runPool(unitNumbers, UNIT_CC, async (unitNum) => {
    const nodeId = getNodeId(unitNum);
    if (!nodeId) return;

    try {
      await syncUnitSnapshot(unitNum, nodeId);
      console.log(`[Sync] Unit ${unitNum}: snapshot updated`);
    } catch (err: any) {
      const msg = `Unit ${unitNum} snapshot: ${err.message}`;
      errors.push(msg);
      console.error(`[Sync] Error: ${msg}`);
    }

  });

  const duration = Math.round((Date.now() - startTime) / 1000);

  console.log(
    `[Sync] Complete: ${totalPoints} points stored in ${duration}s (${errors.length} errors)`
  );

  // Disk-size guard — the July 2026 lockout gave zero warning because nothing
  // watched pg_database_size. Full runs check it; past SIZE_ALERT_MB we ping
  // the ops Telegram (damped to ~hourly via the minutes window).
  if (!snapshotOnly) {
    try {
      const { data: sizeMb } = await supabase.rpc("phloton_db_size_mb");
      if (typeof sizeMb === "number") {
        console.log(`[Sync] DB size: ${sizeMb} MB`);
        const limit = Number(process.env.SIZE_ALERT_MB ?? 350);
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chat = process.env.OPS_TELEGRAM_CHAT_ID;
        if (sizeMb > limit && token && chat && new Date().getUTCMinutes() < 5) {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chat,
              text:
                `⚠️ Phloton DB at ${sizeMb} MB (alert threshold ${limit}, ` +
                `free-tier limit 500). Run retention/VACUUM or slim now — ` +
                `at 500 MB Supabase pauses the project with no self-service exit.`,
            }),
          });
        }
      }
    } catch {
      // guard must never break the sync
    }
  }

  // Update log
  if (logId) {
    await supabase.from("sync_log").update({
      finished_at: new Date().toISOString(),
      status: errors.length > 0 ? "partial" : "success",
      units_synced: unitNumbers.length,
      points_synced: totalPoints,
      error_message: errors.length > 0 ? errors.join("; ") : null,
      details: { duration, snapshotOnly },
    }).eq("id", logId);
  }

  return {
    unitsProcessed: unitNumbers.length,
    totalPointsSynced: totalPoints,
    errors,
    duration,
  };
}
