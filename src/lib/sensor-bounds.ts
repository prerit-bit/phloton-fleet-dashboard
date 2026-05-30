/**
 * Physical / electrical sanity bounds per sensor.
 *
 * Readings outside these ranges are hardware-impossible (sensor disconnect,
 * ADC glitch, BMS transient, etc.). They must be dropped before they reach
 * the database or a chart — a single 50V spike in a 5-minute bucket blows
 * the chart's y-axis to 50V even though the average looks fine.
 *
 * Single source of truth for both sync-time filtering (`src/lib/sync.ts`)
 * and chart-time filtering (`src/app/unit/[id]/page.tsx`).
 */

export type SensorBounds = { min: number; max: number };

const VOLTAGE: SensorBounds = { min: 7.0, max: 13.0 };
const SOC: SensorBounds = { min: 0, max: 100 };
const CURRENT: SensorBounds = { min: -15, max: 15 };
const TEMP: SensorBounds = { min: -30, max: 80 };
const HEATSINK: SensorBounds = { min: -30, max: 100 };
const DUTY: SensorBounds = { min: 0, max: 4095 };
const STATUS: SensorBounds = { min: 0, max: 1 };

export function getBoundsForVariable(varName: string): SensorBounds | null {
  const n = varName.toLowerCase();
  if (n.includes("voltage")) return VOLTAGE;
  if (n.includes("soc")) return SOC;
  if (n.includes("current")) return CURRENT;
  if (n.includes("duty")) return DUTY;
  // "status" but not "fault status" (fault codes are arbitrary integers)
  if (n.includes("status") && !n.includes("fault")) return STATUS;
  if (n.includes("heat sink") || n.includes("heatsink")) return HEATSINK;
  if (n.includes("temp") || n.includes("cold") || n.includes("pcb") || n.includes("heat"))
    return TEMP;
  return null;
}

export function isValidReading(varName: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const b = getBoundsForVariable(varName);
  if (!b) return true;
  return value >= b.min && value <= b.max;
}

export function filterValidReadings<T extends { value: number }>(
  points: T[],
  varName: string
): T[] {
  return points.filter((p) => isValidReading(varName, p.value));
}

/**
 * Like filterValidReadings, but also strips the min/max envelope on
 * aggregated buckets when either bound is out of physical range — so a
 * single bad raw point inside a bucket doesn't drag the chart envelope
 * with it even after the cleanup of old bad rows.
 */
export function sanitizeChartPoints<
  T extends { value: number; min?: number; max?: number }
>(points: T[], varName: string): T[] {
  const b = getBoundsForVariable(varName);
  if (!b) return points;
  const inRange = (v: number | undefined | null) =>
    v == null || (Number.isFinite(v) && v >= b.min && v <= b.max);
  return points
    .filter((p) => isValidReading(varName, p.value))
    .map((p) => {
      if (inRange(p.min) && inRange(p.max)) return p;
      const { min: _omitMin, max: _omitMax, ...rest } = p;
      return rest as T;
    });
}
