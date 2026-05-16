/**
 * Anedya → Supabase Sync Service (Smart Aggregation)
 *
 * Storage strategy to fit within Supabase free tier (500MB):
 *   - Data older than 48 hours → stored as HOURLY AVERAGES
 *   - Data from last 48 hours → stored as RAW points (full resolution)
 *
 * This cuts storage by ~60x while keeping charts looking great.
 * Hourly resolution is more than enough for lifetime/monthly views.
 * Raw data gives you full detail for recent zoomed-in views.
 *
 * Estimated storage:
 *   29 units × 19 vars × 8,760 hours/year × ~120 bytes = ~580K rows ≈ 70MB
 *   + 48hrs raw data ≈ 10MB → Total ~80MB, well within 500MB limit.
 */

import { supabaseAdmin } from "./supabase";

// Non-null ref — runSync() guards with a null check before any calls
const supabase = supabaseAdmin!;
import {
  getUnitNumbers,
  getNodeId,
  getAllVariables,
  getHistoricalData,
  getDeviceStatus,
  getLatestData,
  type HistoricalPoint,
} from "./anedya";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SyncResult {
  unitsProcessed: number;
  totalPointsSynced: number;
  errors: string[];
  duration: number;
}

// ─── Aggregation helper ─────────────────────────────────────────────────────

/**
 * Groups raw data points into hourly buckets and averages the values.
 * E.g., 60 one-minute readings → 1 hourly average.
 */
function aggregateToHourly(points: HistoricalPoint[]): HistoricalPoint[] {
  const buckets = new Map<string, { sum: number; count: number }>();

  for (const p of points) {
    const d = new Date(p.datetime);
    // Truncate to hour
    const bucketKey = new Date(
      d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()
    ).toISOString();

    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.sum += p.value;
      existing.count++;
    } else {
      buckets.set(bucketKey, { sum: p.value, count: 1 });
    }
  }

  const result: HistoricalPoint[] = [];
  buckets.forEach(({ sum, count }, datetime) => {
    result.push({ datetime, value: sum / count });
  });

  return result.sort(
    (a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime()
  );
}

// ─── Sync one variable for one unit ──────────────────────────────────────────

async function syncVariable(
  unitNumber: number,
  nodeId: string,
  variableKey: string,
  variableName: string,
  variableIdentifier: string
): Promise<number> {
  // 1. Get last synced timestamp from sync_state
  const { data: stateRow } = await supabase
    .from("sync_state")
    .select("last_synced_timestamp")
    .eq("node_id", nodeId)
    .eq("variable_key", variableKey)
    .single();

  const now = Math.floor(Date.now() / 1000);
  const RAW_WINDOW = 48 * 3600; // 48 hours of raw data
  const rawCutoff = now - RAW_WINDOW;

  // Default: backfill 1 year on first sync
  const lastSynced = stateRow?.last_synced_timestamp || (now - 365 * 86400);

  // Skip if we synced very recently (within 60 seconds)
  if (now - lastSynced < 60) return 0;

  // 2. Fetch data from Anedya in chunks (10k limit per call)
  const CHUNK_SIZE = 30 * 86400; // 30 days
  const allPoints: HistoricalPoint[] = [];
  let cursor = lastSynced;

  while (cursor < now) {
    const chunkEnd = Math.min(cursor + CHUNK_SIZE, now);
    try {
      const chunk = await getHistoricalData(
        nodeId,
        variableIdentifier,
        cursor,
        chunkEnd
      );
      allPoints.push(...chunk);

      // If we hit the 10k limit, there's more data in this chunk
      if (chunk.length >= 10000) {
        const lastTs = Math.floor(
          new Date(chunk[chunk.length - 1].datetime).getTime() / 1000
        );
        cursor = lastTs + 1;
      } else {
        cursor = chunkEnd;
      }
    } catch (err) {
      console.error(
        `Sync error: unit ${unitNumber}, var ${variableKey}, chunk ${cursor}-${chunkEnd}:`,
        err
      );
      cursor = chunkEnd;
    }
  }

  if (allPoints.length === 0) return 0;

  // 3. Split into old (→ aggregate) and recent (→ raw)
  const oldPoints = allPoints.filter(
    (p) => new Date(p.datetime).getTime() / 1000 < rawCutoff
  );
  const recentPoints = allPoints.filter(
    (p) => new Date(p.datetime).getTime() / 1000 >= rawCutoff
  );

  // 4. Aggregate old data into hourly averages
  const hourlyPoints = aggregateToHourly(oldPoints);

  // 5. Combine: hourly aggregates + raw recent data
  const pointsToStore = [...hourlyPoints, ...recentPoints];

  // 6. Deduplicate by timestamp
  const seen = new Set<string>();
  const dedupedPoints = pointsToStore.filter((p) => {
    if (seen.has(p.datetime)) return false;
    seen.add(p.datetime);
    return true;
  });

  // 7. Upsert into sensor_readings in batches of 500
  const BATCH_SIZE = 500;
  let inserted = 0;

  for (let i = 0; i < dedupedPoints.length; i += BATCH_SIZE) {
    const batch = dedupedPoints.slice(i, i + BATCH_SIZE).map((p) => ({
      unit_number: unitNumber,
      node_id: nodeId,
      variable_key: variableKey,
      variable_name: variableName,
      value: p.value,
      recorded_at: p.datetime,
    }));

    const { error } = await supabase
      .from("sensor_readings")
      .upsert(batch, { onConflict: "node_id,variable_key,recorded_at" });

    if (error) {
      console.error(
        `Upsert error: unit ${unitNumber}, var ${variableKey}, batch ${i}:`,
        error.message
      );
    } else {
      inserted += batch.length;
    }
  }

  // 8. Update sync cursor
  const latestTimestamp = Math.floor(
    new Date(allPoints[allPoints.length - 1].datetime).getTime() / 1000
  );

  await supabase.from("sync_state").upsert(
    {
      node_id: nodeId,
      variable_key: variableKey,
      last_synced_timestamp: latestTimestamp,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "node_id,variable_key" }
  );

  const ratio = allPoints.length > 0
    ? Math.round((1 - dedupedPoints.length / allPoints.length) * 100)
    : 0;
  if (allPoints.length > 1000) {
    console.log(
      `  ↳ ${allPoints.length} raw → ${dedupedPoints.length} stored (${ratio}% compression)`
    );
  }

  return inserted;
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

  const loc =
    location.isSuccess && location.data
      ? {
          latitude: (location.data as Record<string, number>).lat,
          longitude: (location.data as Record<string, number>).long,
        }
      : { latitude: null, longitude: null };

  await supabase.from("unit_snapshots").upsert(
    {
      unit_number: unitNumber,
      node_id: nodeId,
      online: status,
      battery_soc: soc.isSuccess ? (soc.data as number) : null,
      battery_voltage: voltage.isSuccess ? (voltage.data as number) : null,
      flask_temp: flaskTemp.isSuccess ? (flaskTemp.data as number) : null,
      ambient_temp: ambientTemp.isSuccess ? (ambientTemp.data as number) : null,
      fault_status: fault.isSuccess ? String(fault.data) : null,
      ...loc,
      last_data_at: ambientTemp.timestamp
        ? new Date(ambientTemp.timestamp * 1000).toISOString()
        : soc.timestamp
          ? new Date(soc.timestamp * 1000).toISOString()
          : null,
      synced_at: new Date().toISOString(),
    },
    { onConflict: "unit_number" }
  );
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
  const vars = getAllVariables();

  // Filter to numeric variables only (skip location, deviceStatus)
  const numericVars = vars.filter(
    (v) => v.identifier !== "location" && v.identifier !== "deviceStatus"
  );

  console.log(
    `[Sync] Starting sync for ${unitNumbers.length} units × ${numericVars.length} variables`
  );
  console.log(
    `[Sync] Strategy: hourly aggregates for data >48h old, raw for recent data`
  );

  // Tunable concurrency (env-overridable without a code change). Defaults
  // chosen to cut a full run from ~17 min to a few min without hammering
  // Anedya: up to UNIT_CC units, each running VAR_CC variable syncs.
  const UNIT_CC = Math.max(1, Number(process.env.SYNC_UNIT_CONCURRENCY ?? 5));
  const VAR_CC = Math.max(1, Number(process.env.SYNC_VAR_CONCURRENCY ?? 4));
  console.log(
    `[Sync] Concurrency: ${UNIT_CC} units × ${VAR_CC} vars in flight`
  );

  await runPool(unitNumbers, UNIT_CC, async (unitNum) => {
    const nodeId = getNodeId(unitNum);
    if (!nodeId) return;

    // A snapshot failure must not block this unit's historical sync.
    try {
      await syncUnitSnapshot(unitNum, nodeId);
      console.log(`[Sync] Unit ${unitNum}: snapshot updated`);
    } catch (err: any) {
      const msg = `Unit ${unitNum} snapshot: ${err.message}`;
      errors.push(msg);
      console.error(`[Sync] Error: ${msg}`);
    }

    if (snapshotOnly) return; // skip historical backfill in fast mode

    await runPool(numericVars, VAR_CC, async (v) => {
      try {
        const points = await syncVariable(
          unitNum,
          nodeId,
          v.key,
          v.name,
          v.identifier
        );
        totalPoints += points;
        if (points > 0) {
          console.log(
            `[Sync] Unit ${unitNum} / ${v.name}: ${points} points stored`
          );
        }
      } catch (err: any) {
        const msg = `Unit ${unitNum} / ${v.name}: ${err.message}`;
        errors.push(msg);
        console.error(`[Sync] Error: ${msg}`);
      }
    });
  });

  const duration = Math.round((Date.now() - startTime) / 1000);

  console.log(
    `[Sync] Complete: ${totalPoints} points stored in ${duration}s (${errors.length} errors)`
  );

  // Update log
  if (logId) {
    await supabase.from("sync_log").update({
      finished_at: new Date().toISOString(),
      status: errors.length > 0 ? "partial" : "success",
      units_synced: unitNumbers.length,
      points_synced: totalPoints,
      error_message: errors.length > 0 ? errors.join("; ") : null,
      details: { duration, variableCount: numericVars.length },
    }).eq("id", logId);
  }

  return {
    unitsProcessed: unitNumbers.length,
    totalPointsSynced: totalPoints,
    errors,
    duration,
  };
}
