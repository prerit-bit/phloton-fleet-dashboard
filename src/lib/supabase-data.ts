/**
 * Supabase Data Layer
 * Mirrors the anedya.ts API surface but reads from the local Supabase database.
 * This makes dashboard loads instant — no chunking, no 10k limits.
 */

import { supabase } from "./supabase/client";
import type { UnitSnapshot, HistoricalPoint } from "./anedya";

// ─── Fleet snapshot from Supabase ────────────────────────────────────────────

export async function getFleetSnapshotFromSupabase(): Promise<UnitSnapshot[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("unit_snapshots")
    .select("*")
    .order("unit_number", { ascending: true });

  if (error || !data) {
    console.error("Supabase fleet snapshot error:", error);
    return [];
  }

  return data.map((row: any) => ({
    unitNumber: row.unit_number,
    nodeId: row.node_id,
    online: row.online,
    batterySoC: row.battery_soc,
    batteryVoltage: row.battery_voltage,
    flaskTemp: row.flask_temp,
    ambientTemp: row.ambient_temp,
    faultStatus: row.fault_status,
    location:
      row.latitude != null && row.longitude != null
        ? { lat: row.latitude, lng: row.longitude }
        : null,
    lastUpdated: row.last_data_at
      ? Math.floor(new Date(row.last_data_at).getTime() / 1000)
      : null,
  }));
}

// ─── Unit snapshot from Supabase ─────────────────────────────────────────────

export async function getUnitSnapshotFromSupabase(
  unitNumber: number
): Promise<UnitSnapshot | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("unit_snapshots")
    .select("*")
    .eq("unit_number", unitNumber)
    .single();

  if (error || !data) return null;

  return {
    unitNumber: data.unit_number,
    nodeId: data.node_id,
    online: data.online,
    batterySoC: data.battery_soc,
    batteryVoltage: data.battery_voltage,
    flaskTemp: data.flask_temp,
    ambientTemp: data.ambient_temp,
    faultStatus: data.fault_status,
    location:
      data.latitude != null && data.longitude != null
        ? { lat: data.latitude, lng: data.longitude }
        : null,
    lastUpdated: data.last_data_at
      ? Math.floor(new Date(data.last_data_at).getTime() / 1000)
      : null,
  };
}

// ─── Historical data from Supabase ───────────────────────────────────────────

/**
 * Fetches historical data for a single variable from Supabase.
 * No chunking needed — a single SQL query handles any time range.
 *
 * For ranges > 7 days, uses the hourly aggregation view for performance.
 * For shorter ranges, returns raw data points.
 */
export async function getHistoricalDataFromSupabase(
  unitNumber: number,
  variableKey: string,
  fromTime: number, // Unix seconds
  toTime: number,   // Unix seconds
  useAggregation: boolean = false
): Promise<HistoricalPoint[]> {
  const fromDate = new Date(fromTime * 1000).toISOString();
  const toDate = new Date(toTime * 1000).toISOString();

  if (!supabase) return [];

  if (useAggregation) {
    // Use hourly aggregation view for long ranges
    const { data, error } = await supabase
      .from("sensor_readings_hourly")
      .select("bucket, avg_value")
      .eq("unit_number", unitNumber)
      .eq("variable_key", variableKey)
      .gte("bucket", fromDate)
      .lte("bucket", toDate)
      .order("bucket", { ascending: true });

    if (error || !data) {
      console.error("Supabase aggregated data error:", error);
      return [];
    }

    return data.map((row: any) => ({
      datetime: row.bucket,
      value: row.avg_value,
    }));
  }

  // Raw data for short ranges.
  // Order DESCENDING + limit 10k = take the NEWEST 10k points within the
  // window when a chatty variable overflows the cap. (Ascending-then-limit
  // silently dropped the most recent readings, making fast-changing
  // variables like Battery SoC look stuck at an old timestamp.) Reverse
  // client-side so the chart still gets ascending order.
  const { data, error } = await supabase
    .from("sensor_readings")
    .select("recorded_at, value")
    .eq("unit_number", unitNumber)
    .eq("variable_key", variableKey)
    .gte("recorded_at", fromDate)
    .lte("recorded_at", toDate)
    .order("recorded_at", { ascending: false })
    .limit(10000);

  if (error || !data) {
    console.error("Supabase historical data error:", error);
    return [];
  }

  return data
    .slice()
    .reverse()
    .map((row: any) => ({
      datetime: row.recorded_at,
      value: row.value,
    }));
}

// ─── All historical data for a unit (for CSV/PDF exports) ────────────────────

export async function getAllHistoricalDataFromSupabase(
  unitNumber: number,
  fromTime: number,
  toTime: number
): Promise<Record<string, HistoricalPoint[]>> {
  const fromDate = new Date(fromTime * 1000).toISOString();
  const toDate = new Date(toTime * 1000).toISOString();

  if (!supabase) return {};

  // Fetch all readings for this unit in one query
  const { data, error } = await supabase
    .from("sensor_readings")
    .select("variable_name, recorded_at, value")
    .eq("unit_number", unitNumber)
    .gte("recorded_at", fromDate)
    .lte("recorded_at", toDate)
    .order("recorded_at", { ascending: true });

  if (error || !data) {
    console.error("Supabase all historical data error:", error);
    return {};
  }

  // Group by variable name
  const map: Record<string, HistoricalPoint[]> = {};
  for (const row of data as any[]) {
    const name = row.variable_name;
    if (!map[name]) map[name] = [];
    map[name].push({
      datetime: row.recorded_at,
      value: row.value,
    });
  }

  return map;
}

// ─── Convenience: check if Supabase has data for a unit ──────────────────────

export async function hasSupabaseData(unitNumber: number): Promise<boolean> {
  if (!supabase) return false;

  const { count, error } = await supabase
    .from("sensor_readings")
    .select("id", { count: "exact", head: true })
    .eq("unit_number", unitNumber)
    .limit(1);

  return !error && (count ?? 0) > 0;
}
