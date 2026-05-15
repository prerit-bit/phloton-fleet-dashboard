/**
 * Anedya IoT Platform API Client
 * Mirrors the Python anedya_cloud.py from the Streamlit dashboard.
 *
 * All data flows:
 *   - POST https://api.anedya.io/v1/...
 *   - Auth: Bearer <API_KEY>
 *   - Body: JSON with node IDs and variable identifiers
 */

const BASE_URL = "https://api.anedya.io/v1";

function getApiKey(): string {
  return process.env.NEXT_PUBLIC_ANEDYA_API_KEY || "";
}

function getNodesConfig(): Record<string, string> {
  try {
    return JSON.parse(process.env.NEXT_PUBLIC_NODES_ID || "{}");
  } catch {
    return {};
  }
}

function getVariablesConfig(): Record<
  string,
  { identifier: string; name: string }
> {
  try {
    return JSON.parse(process.env.NEXT_PUBLIC_VARIABLES_IDENTIFIER || "{}");
  } catch {
    return {};
  }
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface UnitStatus {
  unitNumber: number;
  nodeId: string;
  online: boolean | null;
}

export interface LatestDataResult {
  isSuccess: boolean;
  data: number | Record<string, number> | null;
  timestamp: number | null;
}

export interface UnitSnapshot {
  unitNumber: number;
  nodeId: string;
  online: boolean | null;
  batterySoC: number | null;
  batteryVoltage: number | null;
  flaskTemp: number | null;
  ambientTemp: number | null;
  faultStatus: number | string | null;
  location: { lat: number; lng: number } | null;
  lastUpdated: number | null;
}

export interface HistoricalPoint {
  datetime: string;
  value: number;
}

// ─── Low-level API calls ───────────────────────────────────────────────────

async function apiPost(endpoint: string, body: object): Promise<any> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (!res.ok) {
    console.error(`Anedya API error: ${res.status} on ${endpoint}`);
    return null;
  }

  return res.json();
}

// ─── Device Status ─────────────────────────────────────────────────────────

export async function getDeviceStatus(nodeId: string): Promise<boolean | null> {
  const data = await apiPost("/health/status", {
    nodes: [nodeId],
    lastContactThreshold: 900,
  });

  if (!data || data.errcode !== 0) return null;
  const nodeData = data.data?.[nodeId];
  return nodeData?.online ?? null;
}

// ─── Latest Data ───────────────────────────────────────────────────────────

export async function getLatestData(
  nodeId: string,
  variableIdentifier: string
): Promise<LatestDataResult> {
  const data = await apiPost("/data/latest", {
    nodes: [nodeId],
    variable: variableIdentifier,
  });

  if (!data || !data.data || !data.data[nodeId]) {
    return { isSuccess: false, data: null, timestamp: null };
  }

  return {
    isSuccess: true,
    data: data.data[nodeId].value,
    timestamp: data.data[nodeId].timestamp,
  };
}

// ─── Historical Data ───────────────────────────────────────────────────────

export async function getHistoricalData(
  nodeId: string,
  variableIdentifier: string,
  fromTime: number,
  toTime: number
): Promise<HistoricalPoint[]> {
  const data = await apiPost("/data/getData", {
    variable: variableIdentifier,
    nodes: [nodeId],
    from: fromTime,
    to: toTime,
    limit: 10000,
    order: "asc",
  });

  if (!data?.data) return [];

  const points: HistoricalPoint[] = [];
  for (const [, entries] of Object.entries(data.data)) {
    for (const entry of entries as any[]) {
      points.push({
        datetime: new Date(entry.timestamp * 1000).toISOString(),
        value: entry.value,
      });
    }
  }

  return points.sort(
    (a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime()
  );
}

/**
 * Paginated fetch — calls getHistoricalData in monthly chunks to bypass
 * the 10,000-point API limit and retrieve the complete dataset.
 */
export async function getHistoricalDataPaginated(
  nodeId: string,
  variableIdentifier: string,
  fromTime: number,
  toTime: number
): Promise<HistoricalPoint[]> {
  const CHUNK = 30 * 86400; // 30 days per chunk
  const allPoints: HistoricalPoint[] = [];
  let cursor = fromTime;

  while (cursor < toTime) {
    const chunkEnd = Math.min(cursor + CHUNK, toTime);
    const chunk = await getHistoricalData(nodeId, variableIdentifier, cursor, chunkEnd);
    allPoints.push(...chunk);
    // If we got exactly 10k, the chunk might be incomplete — move cursor to last point
    if (chunk.length >= 10000) {
      const lastTs = Math.floor(new Date(chunk[chunk.length - 1].datetime).getTime() / 1000) + 1;
      cursor = lastTs;
    } else {
      cursor = chunkEnd;
    }
  }

  return allPoints;
}

// ─── Aggregated Data ───────────────────────────────────────────────────────

/**
 * Fetches aggregated data using the Anedya aggregation API.
 * Tries millisecond timestamps first (which the API may require for long ranges),
 * then falls back to seconds if that returns no data.
 */
export async function getAggregatedData(
  nodeId: string,
  variableIdentifier: string,
  fromTime: number,
  toTime: number,
  intervalMins: number = 10
): Promise<HistoricalPoint[]> {
  // Try with millisecond timestamps first
  const fromMs = fromTime * 1000;
  const toMs = toTime * 1000;

  let data = await apiPost("/aggregates/variable/byTime", {
    variable: variableIdentifier,
    from: fromMs,
    to: toMs,
    config: {
      aggregation: { compute: "avg", forEachNode: true },
      interval: { measure: "minute", interval: intervalMins },
      responseOptions: { timezone: "UTC" },
      filter: { nodes: [nodeId], type: "include" },
    },
  });

  // If ms timestamps returned no data, try seconds as fallback
  if (!data?.data || Object.keys(data.data).length === 0) {
    data = await apiPost("/aggregates/variable/byTime", {
      variable: variableIdentifier,
      from: fromTime,
      to: toTime,
      config: {
        aggregation: { compute: "avg", forEachNode: true },
        interval: { measure: "minute", interval: intervalMins },
        responseOptions: { timezone: "UTC" },
        filter: { nodes: [nodeId], type: "include" },
      },
    });
  }

  if (!data?.data) return [];

  const points: HistoricalPoint[] = [];
  for (const [, entries] of Object.entries(data.data)) {
    for (const entry of entries as any[]) {
      // Anedya may return timestamps in ms or seconds — normalize
      const ts = entry.timestamp > 1e12 ? entry.timestamp : entry.timestamp * 1000;
      points.push({
        datetime: new Date(ts).toISOString(),
        value: entry.value,
      });
    }
  }

  return points.sort(
    (a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime()
  );
}

// ─── Fleet Snapshot (all units at once) ────────────────────────────────────

export function getUnitNumbers(): number[] {
  const nodes = getNodesConfig();
  return Object.keys(nodes)
    .map((k) => parseInt(k.replace("node_", "")))
    .sort((a, b) => a - b);
}

export function getNodeId(unitNumber: number): string {
  const nodes = getNodesConfig();
  return nodes[`node_${unitNumber}`] || "";
}

export function getVariableIdentifier(variableKey: string): string {
  const vars = getVariablesConfig();
  return vars[variableKey]?.identifier || "";
}

export function getVariableName(variableKey: string): string {
  const vars = getVariablesConfig();
  return vars[variableKey]?.name || variableKey;
}

/**
 * Fetches a full snapshot for one unit — status, all gauges, GPS.
 * Used to populate the fleet dashboard cards and map markers.
 */
export async function getUnitSnapshot(
  unitNumber: number
): Promise<UnitSnapshot> {
  const nodeId = getNodeId(unitNumber);
  const vars = getVariablesConfig();

  // Fire all requests in parallel
  const [status, soc, voltage, flaskTemp, ambientTemp, fault, location] =
    await Promise.all([
      getDeviceStatus(nodeId),
      getLatestData(nodeId, vars["variable_1"]?.identifier || ""),
      getLatestData(nodeId, vars["variable_2"]?.identifier || ""),
      getLatestData(nodeId, vars["variable_3"]?.identifier || ""),
      getLatestData(nodeId, vars["variable_4"]?.identifier || ""),
      getLatestData(nodeId, vars["variable_5"]?.identifier || ""),
      getLatestData(nodeId, "location"),
    ]);

  const loc = location.isSuccess && location.data
    ? {
        lat: (location.data as Record<string, number>).lat,
        lng: (location.data as Record<string, number>).long,
      }
    : null;

  return {
    unitNumber,
    nodeId,
    online: status,
    batterySoC: soc.isSuccess ? (soc.data as number) : null,
    batteryVoltage: voltage.isSuccess ? (voltage.data as number) : null,
    flaskTemp: flaskTemp.isSuccess ? (flaskTemp.data as number) : null,
    ambientTemp: ambientTemp.isSuccess ? (ambientTemp.data as number) : null,
    faultStatus: fault.isSuccess ? (fault.data as number | string) : null,
    location: loc,
    lastUpdated: ambientTemp.timestamp || soc.timestamp || null,
  };
}

/**
 * Fetches snapshots for ALL units in the fleet.
 */
export async function getFleetSnapshot(): Promise<UnitSnapshot[]> {
  const unitNumbers = getUnitNumbers();
  const snapshots = await Promise.all(
    unitNumbers.map((n) => getUnitSnapshot(n))
  );
  return snapshots;
}

/**
 * Returns all variable keys and their configs for iteration.
 */
export function getAllVariables(): { key: string; identifier: string; name: string }[] {
  const vars = getVariablesConfig();
  return Object.entries(vars).map(([key, val]) => ({
    key,
    identifier: val.identifier,
    name: val.name,
  }));
}

/**
 * Fetches ALL available historical data for a unit across all numeric variables.
 * Returns a map of variable name → HistoricalPoint[].
 */
export async function getAllHistoricalData(
  nodeId: string,
  fromTime: number,
  toTime: number
): Promise<Record<string, HistoricalPoint[]>> {
  const vars = getAllVariables();
  // Skip location and status variables (non-numeric)
  const numericVars = vars.filter(
    (v) => v.identifier !== "location" && v.identifier !== "deviceStatus"
  );

  const results = await Promise.all(
    numericVars.map(async (v) => {
      const data = await getHistoricalData(nodeId, v.identifier, fromTime, toTime);
      return { name: v.name, data };
    })
  );

  const map: Record<string, HistoricalPoint[]> = {};
  for (const r of results) {
    if (r.data.length > 0) {
      map[r.name] = r.data;
    }
  }
  return map;
}
