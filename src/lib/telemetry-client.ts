/**
 * Client-side bulk history fetch through /api/telemetry — feeds CSV export
 * and the report generator. Replaces getAllHistoricalDataFromSupabase.
 *
 * Loops the numeric variables with a small concurrency pool; each request is
 * short (hourly aggregates), so no serverless-timeout risk and every window
 * benefits from the route's cache. History depth = Anedya retention: asking
 * for a year returns what exists (~6 months today).
 */
import { getAllVariables, type HistoricalPoint } from "./anedya";

const POOL = 4;

export async function fetchAllHistoryViaApi(
  unitNumber: number,
  fromTime: number,
  toTime: number
): Promise<Record<string, HistoricalPoint[]>> {
  const vars = getAllVariables().filter(
    (v) => v.identifier !== "location" && v.identifier !== "deviceStatus"
  );
  const out: Record<string, HistoricalPoint[]> = {};

  let cursor = 0;
  const lanes = Array.from({ length: Math.min(POOL, vars.length) }, async () => {
    while (cursor < vars.length) {
      const v = vars[cursor++];
      try {
        const res = await fetch(
          `/api/telemetry?unit=${unitNumber}&key=${v.key}` +
            `&from=${fromTime}&to=${toTime}&bucket=hourly`
        );
        if (!res.ok) continue;
        const points: HistoricalPoint[] = (await res.json()).points ?? [];
        if (points.length > 0) out[v.name] = points;
      } catch {
        // one variable failing must not sink the whole export
      }
    }
  });
  await Promise.all(lanes);
  return out;
}
