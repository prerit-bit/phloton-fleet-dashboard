"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  getAllVariables,
  type UnitSnapshot,
  type HistoricalPoint,
} from "@/lib/anedya";
import {
  getUnitSnapshotFromSupabase,
  getHistoricalDataFromSupabase,
  getAllHistoricalDataFromSupabase,
} from "@/lib/supabase-data";
import { buildCsvFromHistory, downloadFile, generateUnitReport } from "@/lib/export";
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
  ReferenceLine,
} from "recharts";

const REFRESH_INTERVAL = 30_000;

type TimeRange = "1h" | "6h" | "24h" | "7d" | "30d" | "all";

const RANGE_SECONDS: Record<TimeRange, number> = {
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
  "all": 365 * 86400,
};

const CHART_COLORS = [
  "#00C9A7", "#3B82F6", "#F59E0B", "#8B5CF6", "#EF4444",
  "#EC4899", "#14B8A6", "#F97316", "#6366F1", "#10B981",
  "#06B6D4", "#D946EF", "#84CC16", "#0EA5E9", "#A855F7",
  "#E11D48", "#059669", "#7C3AED", "#DC2626", "#2563EB",
];

// ─── Gauge circle ─────────────────────────────────────────────────────────────

function GaugeCircle({ value, max, label, unit, color, alert }: {
  value: number | null; max: number; label: string; unit: string; color: string; alert?: boolean;
}) {
  const pct = value !== null ? Math.min(100, (value / max) * 100) : 0;
  const r = 40;
  const circumference = 2 * Math.PI * r;
  const strokeDashoffset = circumference - (pct / 100) * circumference;
  const display = value !== null ? value.toFixed(1) : "--";

  return (
    <div className="flex flex-col items-center">
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#E5E7EB" strokeWidth="8" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={alert ? "#EF4444" : color}
          strokeWidth="8" strokeDasharray={circumference} strokeDashoffset={strokeDashoffset}
          strokeLinecap="round" transform="rotate(-90 50 50)" className="transition-all duration-700" />
        <text x="50" y="46" textAnchor="middle" fill={alert ? "#EF4444" : "#1A1A2E"} fontSize="18" fontWeight="700">{display}</text>
        <text x="50" y="62" textAnchor="middle" fill="#6B7280" fontSize="10">{unit}</text>
      </svg>
      <span className="mt-1 text-xs font-medium text-navy-200">{label}</span>
    </div>
  );
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function formatChartTime(iso: string, range: TimeRange): string {
  const d = new Date(iso);
  if (range === "1h" || range === "6h" || range === "24h") {
    return d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  }
  if (range === "7d") {
    return d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" }) +
      " " + d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "2-digit" });
}

function formatTooltipTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" })
    + "  " + d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Determine a reasonable filter for sensor errors per variable
function filterSensorErrors(points: HistoricalPoint[], varName: string): HistoricalPoint[] {
  const name = varName.toLowerCase();
  // Temperature variables: filter out < -10 (aggregated averages with -273 mixed in go very negative)
  if (name.includes("temp") || name.includes("heat") || name.includes("cold") || name.includes("pcb")) {
    return points.filter((p) => p.value > -10 && p.value < 120);
  }
  // Battery SoC: 0-100%
  if (name.includes("soc")) {
    return points.filter((p) => p.value >= 0 && p.value <= 100);
  }
  // Voltage: 0-20V
  if (name.includes("voltage")) {
    return points.filter((p) => p.value >= 0 && p.value <= 20);
  }
  // Current: filter extreme
  if (name.includes("current")) {
    return points.filter((p) => p.value > -10 && p.value < 10);
  }
  // DutyCycle: 0-4096
  if (name.includes("duty")) {
    return points.filter((p) => p.value >= 0 && p.value <= 5000);
  }
  // Status: 0 or 1
  if (name.includes("status") && !name.includes("fault")) {
    return points.filter((p) => p.value >= 0 && p.value <= 1);
  }
  return points;
}

// ─── Variable chart component ─────────────────────────────────────────────────

function VariableChart({ name, data, timeRange, color, unitLabel, refLines }: {
  name: string;
  data: { time: string; fullTime: string; value: number }[];
  timeRange: TimeRange;
  color: string;
  unitLabel?: string;
  refLines?: { y: number; label: string; color: string }[];
}) {
  const needsAngle = timeRange === "7d" || timeRange === "30d" || timeRange === "all";
  const gradientId = `grad-${name.replace(/\s+/g, "-")}`;

  return (
    <div className="rounded-xl border border-navy-100 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
          <h3 className="text-sm font-semibold text-navy-800">{name}</h3>
        </div>
        <span className="text-[10px] text-navy-200">{data.length.toLocaleString()} points</span>
      </div>
      {data.length > 0 ? (
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.25} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
            <XAxis
              dataKey="time" tick={{ fontSize: 9, fill: "#6B7280" }}
              interval="preserveStartEnd"
              angle={needsAngle ? -35 : 0}
              textAnchor={needsAngle ? "end" : "middle"}
              height={needsAngle ? 50 : 30}
            />
            <YAxis tick={{ fontSize: 10, fill: "#6B7280" }} domain={["auto", "auto"]} width={45} />
            <Tooltip
              content={({ active, payload }: any) => {
                if (!active || !payload || payload.length === 0) return null;
                const d = payload[0]?.payload;
                return (
                  <div className="rounded-lg border border-navy-100 bg-white px-3 py-2 shadow-lg min-w-[200px]">
                    <p className="text-[10px] text-navy-200 mb-0.5">{d?.fullTime}</p>
                    <p className="text-base font-bold text-navy-800">
                      {typeof d?.value === "number" ? d.value.toFixed(2) : "--"}
                      {unitLabel && <span className="ml-1 text-xs font-normal text-navy-200">{unitLabel}</span>}
                    </p>
                  </div>
                );
              }}
              cursor={{ stroke: color, strokeWidth: 1, strokeDasharray: "4 4" }}
            />
            {refLines?.map((rl, i) => (
              <ReferenceLine key={i} y={rl.y} stroke={rl.color} strokeDasharray="6 3" strokeWidth={1}
                label={{ value: rl.label, position: "left", fontSize: 9, fill: rl.color }} />
            ))}
            <Area type="monotone" dataKey="value" stroke={color} fill={`url(#${gradientId})`}
              strokeWidth={1.5} dot={false}
              activeDot={{ r: 4, stroke: color, strokeWidth: 2, fill: "white" }} />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex h-[240px] items-center justify-center text-sm text-navy-200">No data available</div>
      )}
    </div>
  );
}

// ─── Available variables (excluding non-numeric) ──────────────────────────────

const AVAILABLE_VARS = getAllVariables().filter(
  (v) => v.identifier !== "location" && v.identifier !== "deviceStatus"
);

// Variable units for display
const VAR_UNITS: Record<string, string> = {
  "Battery SoC": "%",
  "Battery Voltage": "V",
  "Flask Avg Temperature": "°C",
  "Heat Sink Temperature": "°C",
  "Fault Status": "",
  "TEC Current": "A",
  "HS Fan Current": "A",
  "CS Fan Current": "A",
  "PCB Temperature": "°C",
  "Flask Top Temperature": "°C",
  "Cold Sink Temperature": "°C",
  "Flask Down Temperature": "°C",
  "TEC Status": "",
  "HS Fan Status": "",
  "CS Fan Status": "",
  "TEC DutyCycle": "",
  "HS Fan DutyCycle": "",
  "CS Fan DutyCycle": "",
  "Battery Current": "A",
};

// Reference lines per variable
const VAR_REFLINES: Record<string, { y: number; label: string; color: string }[]> = {
  "Flask Avg Temperature": [{ y: 2, label: "2°C", color: "#00C9A7" }, { y: 8, label: "8°C", color: "#00C9A7" }],
  "Flask Top Temperature": [{ y: 2, label: "2°C", color: "#00C9A7" }, { y: 8, label: "8°C", color: "#00C9A7" }],
  "Flask Down Temperature": [{ y: 2, label: "2°C", color: "#00C9A7" }, { y: 8, label: "8°C", color: "#00C9A7" }],
  "Battery SoC": [{ y: 20, label: "20%", color: "#F59E0B" }],
};

// Default selected variables
const DEFAULT_SELECTED = ["Battery SoC", "Battery Voltage", "Flask Avg Temperature", "Heat Sink Temperature"];

// ─── Main page ────────────────────────────────────────────────────────────────

export default function UnitDetailPage() {
  const params = useParams();
  const unitNumber = parseInt(params.id as string);

  const [unit, setUnit] = useState<UnitSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRange>("24h");
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);

  // Variable selection & data
  const [selectedVars, setSelectedVars] = useState<string[]>(DEFAULT_SELECTED);
  const [varData, setVarData] = useState<Record<string, HistoricalPoint[]>>({});
  const [chartLoading, setChartLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState("");
  const [showVarPicker, setShowVarPicker] = useState(false);

  // Fetch unit snapshot from Supabase only. RLS returns nothing for a unit
  // the signed-in user does not own — that is the per-user ownership guard.
  const fetchSnapshot = useCallback(async () => {
    try {
      const snapshot = await getUnitSnapshotFromSupabase(unitNumber);
      setUnit(snapshot);
      setAccessDenied(!snapshot);
      return snapshot;
    } catch (err) {
      console.error("Failed to fetch unit data:", err);
      setAccessDenied(true);
      return null;
    } finally {
      setLoading(false);
    }
  }, [unitNumber]);

  // Fetch chart data for selected variables
  const fetchChartData = useCallback(async () => {
    setChartLoading(true);
    setLoadingProgress("");
    try {
      const now = Math.floor(Date.now() / 1000);
      const fromTime = now - RANGE_SECONDS[timeRange];
      // Raw points only for 1h (rarely exceeds the 10k cap). Anything
      // wider uses the hourly aggregation view — otherwise chatty
      // variables (Battery SoC, Battery Current) silently truncate the
      // window to the newest ~1-2 h of dense raw data.
      const useHourlyAgg = timeRange !== "1h";

      const results: { name: string; data: HistoricalPoint[] }[] = [];

      // Supabase only: a single RLS-scoped query per variable. The direct
      // Anedya path is intentionally removed — it would bypass RLS.
      for (let vi = 0; vi < selectedVars.length; vi++) {
        const varName = selectedVars[vi];
        setLoadingProgress(`${varName} (${vi + 1}/${selectedVars.length})`);
        const varConfig = AVAILABLE_VARS.find((v) => v.name === varName);
        if (!varConfig) { results.push({ name: varName, data: [] }); continue; }

        let data = await getHistoricalDataFromSupabase(
          unitNumber, varConfig.key, fromTime, now, useHourlyAgg
        );
        data = filterSensorErrors(data, varName);

        // Downsample if needed — but ALWAYS preserve the first and last
        // points so the chart's "latest value" reflects the freshest raw
        // reading (otherwise a different stride per range made 6h and
        // 24h look like they had different last values).
        if (data.length > 4000) {
          const step = Math.ceil(data.length / 4000);
          const lastIdx = data.length - 1;
          data = data.filter(
            (_, i) => i % step === 0 || i === lastIdx
          );
        }
        results.push({ name: varName, data });
      }

      const newData: Record<string, HistoricalPoint[]> = {};
      for (const r of results) {
        newData[r.name] = r.data;
      }
      setVarData(newData);
    } catch (err) {
      console.error("Failed to fetch chart data:", err);
    } finally {
      setChartLoading(false);
      setLoadingProgress("");
    }
  }, [selectedVars, timeRange]);

  // Initial load
  useEffect(() => {
    fetchSnapshot().then((snap) => {
      if (snap) fetchChartData();
    });
  }, []);

  // Re-fetch when time range or selected variables change
  useEffect(() => {
    if (unit) {
      fetchChartData();
    }
  }, [timeRange, selectedVars]);

  // Auto-refresh snapshot only (not chart data, too heavy)
  useEffect(() => {
    const interval = setInterval(fetchSnapshot, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchSnapshot]);

  const handleCsvExport = useCallback(async () => {
    if (!unit) return;
    setExporting("csv");
    try {
      const now = Math.floor(Date.now() / 1000);
      const fromTime = now - 365 * 86400;
      const allData = await getAllHistoricalDataFromSupabase(
        unitNumber, fromTime, now
      );
      const csv = buildCsvFromHistory(allData, unitNumber);
      if (csv) {
        const date = new Date().toISOString().slice(0, 10);
        downloadFile(csv, `phloton_unit_${unitNumber}_data_${date}.csv`);
      }
    } catch (err) {
      console.error("CSV export failed:", err);
    } finally {
      setExporting(null);
    }
  }, [unit, unitNumber]);

  const handlePdfReport = useCallback(async () => {
    if (!unit) return;
    setExporting("pdf");
    try {
      const now = Math.floor(Date.now() / 1000);
      const fromTime = now - 365 * 86400;
      const allData = await getAllHistoricalDataFromSupabase(
        unitNumber, fromTime, now
      );
      generateUnitReport(unit, allData);
    } catch (err) {
      console.error("PDF report failed:", err);
    } finally {
      setExporting(null);
    }
  }, [unit, unitNumber]);

  const toggleVar = (varName: string) => {
    setSelectedVars((prev) =>
      prev.includes(varName) ? prev.filter((v) => v !== varName) : [...prev, varName]
    );
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-teal-200 border-t-teal-500" />
          <p className="text-sm text-navy-200">Loading unit data...</p>
        </div>
      </div>
    );
  }

  if (accessDenied || !unit) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="max-w-md rounded-2xl border border-navy-100 bg-white p-10 text-center">
          <h1 className="text-lg font-bold text-navy-800">
            Unit {Number.isNaN(unitNumber) ? "" : unitNumber} not available
          </h1>
          <p className="mt-2 text-sm text-navy-200">
            This unit isn’t assigned to your account, or it doesn’t exist.
            If you believe this is a mistake, contact{" "}
            <a
              href="mailto:prerit@phloton.com"
              className="text-teal-600 hover:underline"
            >
              prerit@phloton.com
            </a>
            .
          </p>
          <a
            href="/"
            className="mt-6 inline-block rounded-lg bg-teal-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-teal-600"
          >
            Back to your devices
          </a>
        </div>
      </div>
    );
  }

  const tempAlert = unit.flaskTemp !== null && (unit.flaskTemp < 2 || unit.flaskTemp > 8);

  const rangeLabels: Record<TimeRange, string> = {
    "1h": "1 Hour", "6h": "6 Hours", "24h": "24 Hours",
    "7d": "7 Days", "30d": "30 Days", "all": "Lifetime",
  };

  return (
    <div className="space-y-6">
      {/* Back + Header + Actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a href="/" className="flex h-9 w-9 items-center justify-center rounded-lg border border-navy-100 bg-white text-navy-200 transition hover:bg-navy-50">
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </a>
          <div>
            <h1 className="text-2xl font-bold text-navy-800">Phloton Unit {unitNumber}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <div className={`h-2 w-2 rounded-full ${unit.online ? "bg-emerald-400" : "bg-red-400"}`} />
              <span className="text-sm text-navy-200">{unit.online ? "Online" : "Offline"}</span>
              {unit.faultStatus !== null && unit.faultStatus !== 0 && (
                <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">Fault: {unit.faultStatus}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleCsvExport} disabled={exporting !== null}
            className="flex items-center gap-1.5 rounded-lg border border-navy-100 bg-white px-3 py-2 text-xs font-medium text-navy-800 shadow-sm transition hover:bg-navy-50 disabled:opacity-50">
            {exporting === "csv" ? <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-teal-200 border-t-teal-500" /> :
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>}
            {exporting === "csv" ? "Exporting..." : "Download CSV"}
          </button>
          <button onClick={handlePdfReport} disabled={exporting !== null}
            className="flex items-center gap-1.5 rounded-lg bg-teal-500 px-3 py-2 text-xs font-medium text-white shadow-sm transition hover:bg-teal-600 disabled:opacity-50">
            {exporting === "pdf" ? <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" /> :
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>}
            {exporting === "pdf" ? "Generating..." : "PDF Report"}
          </button>
        </div>
      </div>

      {/* Gauges */}
      <div className="rounded-xl border border-navy-100 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-navy-800 uppercase tracking-wide">Live Readings</h2>
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <GaugeCircle value={unit.batterySoC} max={100} label="Battery SoC" unit="%" color="#00C9A7" />
          <GaugeCircle value={unit.batteryVoltage} max={16.8} label="Battery Voltage" unit="V" color="#3B82F6" />
          <GaugeCircle value={unit.flaskTemp} max={15} label="Flask Temperature" unit="°C" color="#00C9A7" alert={tempAlert} />
          <GaugeCircle value={unit.ambientTemp} max={55} label="Ambient Temperature" unit="°C" color="#F59E0B" />
        </div>
      </div>

      {/* Time range + Variable selector */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          {(["1h", "6h", "24h", "7d", "30d", "all"] as const).map((range) => (
            <button key={range}
              onClick={() => setTimeRange(range)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                timeRange === range ? "bg-teal-500 text-white" : "bg-white text-navy-200 border border-navy-100 hover:bg-navy-50"
              }`}>
              {range === "all" ? "All" : range}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-navy-200">{rangeLabels[timeRange]}</span>
          <button
            onClick={() => setShowVarPicker(!showVarPicker)}
            className="flex items-center gap-1.5 rounded-lg border border-navy-100 bg-white px-3 py-1.5 text-xs font-medium text-navy-800 shadow-sm transition hover:bg-navy-50"
          >
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
            </svg>
            Variables ({selectedVars.length})
          </button>
        </div>
      </div>

      {/* Variable picker dropdown */}
      {showVarPicker && (
        <div className="rounded-xl border border-navy-100 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-navy-800">Select Variables to Chart</h3>
            <div className="flex gap-2">
              <button onClick={() => setSelectedVars(AVAILABLE_VARS.map((v) => v.name))}
                className="text-[11px] text-teal-600 font-medium hover:underline">Select All</button>
              <button onClick={() => setSelectedVars(DEFAULT_SELECTED)}
                className="text-[11px] text-navy-200 font-medium hover:underline">Reset</button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {AVAILABLE_VARS.map((v, i) => {
              const isSelected = selectedVars.includes(v.name);
              return (
                <button key={v.key} onClick={() => toggleVar(v.name)}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium transition ${
                    isSelected
                      ? "bg-teal-50 border border-teal-200 text-teal-800"
                      : "bg-navy-50 border border-navy-100 text-navy-200 hover:bg-white"
                  }`}>
                  <div className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ background: isSelected ? CHART_COLORS[i % CHART_COLORS.length] : "#D1D5DB" }} />
                  {v.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Loading indicator */}
      {chartLoading && (
        <div className="flex items-center justify-center gap-2 py-4">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-teal-200 border-t-teal-500" />
          <span className="text-sm text-navy-200">
            Loading {loadingProgress || `${selectedVars.length} variable${selectedVars.length > 1 ? "s" : ""}`}
          </span>
        </div>
      )}

      {/* Charts grid */}
      {!chartLoading && (
        <div className={`grid gap-4 ${selectedVars.length === 1 ? "" : "lg:grid-cols-2"}`}>
          {selectedVars.map((varName, idx) => {
            const points = varData[varName] || [];
            const chartData = points.map((p) => ({
              time: formatChartTime(p.datetime, timeRange),
              fullTime: formatTooltipTime(p.datetime),
              value: p.value,
            }));
            const varIdx = AVAILABLE_VARS.findIndex((v) => v.name === varName);
            const color = CHART_COLORS[(varIdx >= 0 ? varIdx : idx) % CHART_COLORS.length];

            return (
              <VariableChart
                key={varName}
                name={varName}
                data={chartData}
                timeRange={timeRange}
                color={color}
                unitLabel={VAR_UNITS[varName]}
                refLines={VAR_REFLINES[varName]}
              />
            );
          })}
        </div>
      )}

      {selectedVars.length === 0 && !chartLoading && (
        <div className="rounded-xl border border-navy-100 bg-white p-12 text-center">
          <p className="text-navy-200 text-sm">No variables selected. Click <strong>Variables</strong> above to pick which sensor data to view.</p>
        </div>
      )}

      {/* Map */}
      {unit.location && (
        <div className="rounded-xl border border-navy-100 bg-white p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold text-navy-800">Device Location</h3>
          <div className="h-[300px] rounded-lg overflow-hidden">
            <SingleUnitMapInline lat={unit.location.lat} lng={unit.location.lng} unitNumber={unitNumber} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Map component ────────────────────────────────────────────────────────────

function SingleUnitMapInline({ lat, lng, unitNumber }: { lat: number; lng: number; unitNumber: number }) {
  useEffect(() => {
    let mapInstance: any = null;
    import("leaflet").then((L) => {
      const container = document.getElementById(`unit-map-${unitNumber}`);
      if (!container) return;
      mapInstance = L.map(container, { center: [lat, lng], zoom: 14, attributionControl: false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(mapInstance);
      const icon = L.divIcon({
        className: "custom-marker",
        html: `<div style="width:32px;height:32px;background:#00C9A7;border:3px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:11px;font-family:system-ui;">${unitNumber}</div>`,
        iconSize: [32, 32], iconAnchor: [16, 16],
      });
      L.marker([lat, lng], { icon }).addTo(mapInstance);
    });
    return () => { if (mapInstance) mapInstance.remove(); };
  }, [lat, lng, unitNumber]);

  return <div id={`unit-map-${unitNumber}`} className="h-full w-full" />;
}
