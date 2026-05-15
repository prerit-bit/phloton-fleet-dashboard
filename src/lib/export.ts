/**
 * CSV and PDF export utilities for Phloton Fleet Dashboard
 */

import type { UnitSnapshot, HistoricalPoint } from "./anedya";

// ─── CSV Export ───────────────────────────────────────────────────────────────

/**
 * Converts multi-variable historical data into a single merged CSV string.
 * Columns: Timestamp, Var1, Var2, ...
 * Rows are aligned by timestamp (nearest minute).
 */
export function buildCsvFromHistory(
  variableData: Record<string, HistoricalPoint[]>,
  unitNumber: number
): string {
  // Collect all unique timestamps (rounded to minute)
  const varNames = Object.keys(variableData);
  if (varNames.length === 0) return "";

  // Build a map: timestamp → { var1: val, var2: val, ... }
  const rows = new Map<string, Record<string, number | null>>();

  for (const varName of varNames) {
    for (const pt of variableData[varName]) {
      // Round to minute for alignment
      const d = new Date(pt.datetime);
      d.setSeconds(0, 0);
      const key = d.toISOString();

      if (!rows.has(key)) {
        rows.set(key, {});
      }
      rows.get(key)![varName] = pt.value;
    }
  }

  // Sort by timestamp
  const sortedKeys = Array.from(rows.keys()).sort();

  // Build CSV
  const header = ["Timestamp (IST)", ...varNames].join(",");
  const csvRows = sortedKeys.map((ts) => {
    const row = rows.get(ts)!;
    const istTime = new Date(ts).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const vals = varNames.map((v) =>
      row[v] !== undefined && row[v] !== null ? row[v]!.toFixed(2) : ""
    );
    return [istTime, ...vals].join(",");
  });

  return [header, ...csvRows].join("\n");
}

/**
 * Triggers a browser file download from a string.
 */
export function downloadFile(
  content: string,
  filename: string,
  mimeType: string = "text/csv"
) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── PDF Report ───────────────────────────────────────────────────────────────

// Helper: build an SVG sparkline from data points
function buildSparkline(
  points: HistoricalPoint[],
  width: number,
  height: number,
  color: string,
  thresholds?: { low: number; high: number; bandColor: string }
): string {
  if (points.length < 2) return "";
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const padding = 4;
  const w = width - padding * 2;
  const h = height - padding * 2;

  const pts = values.map((v, i) => {
    const x = padding + (i / (values.length - 1)) * w;
    const y = padding + h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const pathD = pts.map((p, i) => (i === 0 ? `M${p}` : `L${p}`)).join(" ");

  // Fill area
  const fillPts = [...pts, `${(padding + w).toFixed(1)},${(padding + h).toFixed(1)}`, `${padding.toFixed(1)},${(padding + h).toFixed(1)}`];
  const fillD = fillPts.map((p, i) => (i === 0 ? `M${p}` : `L${p}`)).join(" ") + "Z";

  // Threshold band
  let bandSvg = "";
  if (thresholds) {
    const yLow = padding + h - ((thresholds.low - min) / range) * h;
    const yHigh = padding + h - ((thresholds.high - min) / range) * h;
    const clampLow = Math.max(padding, Math.min(padding + h, yLow));
    const clampHigh = Math.max(padding, Math.min(padding + h, yHigh));
    bandSvg = `<rect x="${padding}" y="${clampHigh.toFixed(1)}" width="${w}" height="${(clampLow - clampHigh).toFixed(1)}" fill="${thresholds.bandColor}" opacity="0.15" rx="2"/>`;
  }

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    ${bandSvg}
    <path d="${fillD}" fill="${color}" opacity="0.1"/>
    <path d="${pathD}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// Helper: SVG donut gauge
function buildGauge(value: number, max: number, color: string, label: string, size: number = 80): string {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const r = (size / 2) - 8;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  const cx = size / 2;
  const cy = size / 2;

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#E5E7EB" stroke-width="6"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="6"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
      stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="14" font-weight="700" fill="#1a1a2e">${value.toFixed(value >= 10 ? 0 : 1)}</text>
    <text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="8" fill="#6B7280">${label}</text>
  </svg>`;
}

// Helper: compute health score
function computeHealthScore(unit: UnitSnapshot, tempData: HistoricalPoint[], battData: HistoricalPoint[]): number {
  let score = 100;
  // Temperature compliance (-40 max)
  if (tempData.length > 0) {
    const excursions = tempData.filter((p) => p.value < 2 || p.value > 8);
    const excPct = excursions.length / tempData.length;
    score -= Math.min(40, excPct * 60);
  }
  // Battery health (-25 max)
  if (unit.batterySoC !== null) {
    if (unit.batterySoC < 10) score -= 25;
    else if (unit.batterySoC < 20) score -= 15;
    else if (unit.batterySoC < 40) score -= 5;
  }
  // Voltage (-15 max)
  if (unit.batteryVoltage !== null && unit.batteryVoltage < 11.5) score -= 15;
  // Fault (-10)
  if (unit.faultStatus !== null && unit.faultStatus !== 0) score -= 10;
  // Offline (-10)
  if (!unit.online) score -= 10;
  return Math.max(0, Math.round(score));
}

/**
 * Generates a rich, visually compelling unit report.
 */
export function generateUnitReport(
  unit: UnitSnapshot,
  variableData: Record<string, HistoricalPoint[]>
) {
  const tempAlert = unit.flaskTemp !== null && (unit.flaskTemp < 2 || unit.flaskTemp > 8);

  const now = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Key variable data
  const tempData = variableData["Flask Avg Temperature"] || variableData["Flask Top Temperature"] || [];
  const battSocData = variableData["Battery SoC"] || [];
  const battVoltData = variableData["Battery Voltage"] || [];
  const heatSinkData = variableData["Heat Sink Temperature"] || [];
  const tecCurrentData = variableData["TEC Current"] || [];
  const battCurrentData = variableData["Battery Current"] || [];
  const pcbTempData = variableData["PCB Temperature"] || [];
  const coldSinkData = variableData["Cold Sink Temperature"] || [];

  // Excursion analysis
  const excursions = tempData.filter((p) => p.value < 2 || p.value > 8);
  const excursionPct = tempData.length > 0 ? (excursions.length / tempData.length) * 100 : 0;
  const compliancePct = 100 - excursionPct;

  // Health score
  const healthScore = computeHealthScore(unit, tempData, battSocData);
  const healthColor = healthScore >= 80 ? "#00C9A7" : healthScore >= 60 ? "#F59E0B" : "#EF4444";
  const healthLabel = healthScore >= 80 ? "Good" : healthScore >= 60 ? "Fair" : "Critical";

  // Stats helper
  const getStats = (points: HistoricalPoint[]) => {
    if (points.length === 0) return null;
    const vals = points.map((p) => p.value);
    const validVals = vals.filter(v => v > -200); // filter out sensor errors like -273
    const useVals = validVals.length > 0 ? validVals : vals;
    return {
      avg: useVals.reduce((a, b) => a + b, 0) / useVals.length,
      min: Math.min(...useVals),
      max: Math.max(...useVals),
      latest: vals[vals.length - 1],
      count: vals.length,
      firstTime: new Date(points[0].datetime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", month: "short", day: "numeric", year: "numeric" }),
      lastTime: new Date(points[points.length - 1].datetime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", month: "short", day: "numeric", year: "numeric" }),
    };
  };

  const tempStats = getStats(tempData);
  const battStats = getStats(battSocData);
  const voltStats = getStats(battVoltData);
  const heatStats = getStats(heatSinkData);

  // Sparklines
  const tempSparkline = buildSparkline(tempData, 320, 80, "#00C9A7", { low: 2, high: 8, bandColor: "#00C9A7" });
  const battSparkline = buildSparkline(battSocData, 320, 80, "#3B82F6");
  const voltSparkline = buildSparkline(battVoltData, 320, 80, "#8B5CF6");
  const heatSparkline = buildSparkline(heatSinkData, 320, 80, "#F59E0B");

  // Smart insights
  const insights: string[] = [];
  if (tempStats) {
    if (compliancePct >= 95) insights.push(`Temperature compliance is excellent at ${compliancePct.toFixed(1)}% — the cold chain is well-maintained.`);
    else if (compliancePct >= 80) insights.push(`Temperature compliance is ${compliancePct.toFixed(1)}%. There are ${excursions.length} excursion events that need review.`);
    else insights.push(`Temperature compliance is low at ${compliancePct.toFixed(1)}% with ${excursions.length} excursions. Immediate attention required to maintain cold chain integrity.`);
  }
  if (battStats) {
    if (battStats.avg > 60) insights.push(`Battery health is strong with an average SoC of ${battStats.avg.toFixed(0)}%.`);
    else if (battStats.avg > 30) insights.push(`Battery SoC averages ${battStats.avg.toFixed(0)}% — monitor for potential depletion during extended off-grid use.`);
    else insights.push(`Battery SoC is critically low at ${battStats.avg.toFixed(0)}% average. Charging or battery replacement is recommended.`);
  }
  if (voltStats && voltStats.min < 11.0) {
    insights.push(`Battery voltage has dropped to ${voltStats.min.toFixed(1)}V — below the 11.5V recommended minimum. Check charging circuit.`);
  }
  if (heatStats && heatStats.max > 50) {
    insights.push(`Heat sink temperature peaked at ${heatStats.max.toFixed(1)}°C. Ensure adequate ventilation around the unit.`);
  }
  if (unit.faultStatus !== null && unit.faultStatus !== 0) {
    insights.push(`Active fault code ${unit.faultStatus} detected. Inspect device and check TEC/fan subsystems.`);
  }

  // Group remaining variables for detailed table
  const detailedVars = Object.entries(variableData)
    .filter(([name]) => !["Flask Avg Temperature", "Battery SoC", "Battery Voltage", "Heat Sink Temperature"].includes(name))
    .map(([name, points]) => {
      const s = getStats(points);
      return s ? { name, ...s } : null;
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  const html = `<!DOCTYPE html>
<html>
<head>
<title>Phloton Unit ${unit.unitNumber} — Comprehensive Report</title>
<style>
  @page { size: A4; margin: 12mm 15mm; }
  @media print { .page-break { page-break-before: always; } }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; line-height: 1.5; font-size: 12px; }

  /* Header bar */
  .header-bar { background: linear-gradient(135deg, #1a1a2e 0%, #2d2d5e 100%); color: white; padding: 20px 28px; display: flex; justify-content: space-between; align-items: center; }
  .header-bar h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.3px; }
  .header-bar .subtitle { font-size: 11px; color: rgba(255,255,255,0.6); margin-top: 2px; }
  .header-bar .right { text-align: right; }
  .header-bar .date { font-size: 10px; color: rgba(255,255,255,0.5); }
  .status-pill { display: inline-block; padding: 3px 12px; border-radius: 20px; font-size: 11px; font-weight: 600; margin-top: 4px; }
  .status-online { background: #00C9A7; color: white; }
  .status-offline { background: #EF4444; color: white; }

  .content { padding: 20px 28px; }

  /* Executive Summary */
  .exec-row { display: flex; gap: 16px; margin-bottom: 20px; }
  .health-card { flex: 0 0 140px; background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 16px; text-align: center; }
  .health-card .label { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #6B7280; font-weight: 600; }
  .health-card .score { font-size: 28px; font-weight: 800; margin: 4px 0; }
  .health-card .verdict { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .gauges-row { flex: 1; display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .gauge-card { background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 10px; text-align: center; }
  .gauge-card .g-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #6B7280; font-weight: 600; margin-bottom: 4px; }
  .gauge-card .g-value { font-size: 22px; font-weight: 700; }
  .gauge-card .g-sub { font-size: 9px; color: #9CA3AF; margin-top: 2px; }

  /* Insights */
  .insights { background: linear-gradient(135deg, #EFF6FF 0%, #F0FDF4 100%); border: 1px solid #DBEAFE; border-radius: 12px; padding: 14px 18px; margin-bottom: 20px; }
  .insights h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #3B82F6; margin-bottom: 8px; font-weight: 700; }
  .insights ul { list-style: none; }
  .insights li { font-size: 11px; color: #374151; padding: 3px 0; padding-left: 16px; position: relative; line-height: 1.5; }
  .insights li::before { content: ""; position: absolute; left: 0; top: 9px; width: 6px; height: 6px; border-radius: 50%; background: #3B82F6; }

  /* Section */
  .section { margin-bottom: 18px; }
  .section-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #1a1a2e; border-bottom: 2px solid #00C9A7; padding-bottom: 4px; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }
  .section-title .dot { width: 8px; height: 8px; border-radius: 50%; }

  /* Chart cards */
  .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
  .chart-card { border: 1px solid #E5E7EB; border-radius: 12px; padding: 14px; background: white; }
  .chart-card .c-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .chart-card .c-title { font-size: 11px; font-weight: 600; color: #374151; }
  .chart-card .c-badge { font-size: 9px; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
  .chart-card .c-stats { display: flex; gap: 12px; margin-top: 6px; font-size: 9px; color: #6B7280; }
  .chart-card .c-stats span { display: flex; align-items: center; gap: 3px; }
  .chart-card .c-stats .dot { width: 5px; height: 5px; border-radius: 50%; display: inline-block; }

  /* Compliance bar */
  .compliance { border: 1px solid #E5E7EB; border-radius: 12px; padding: 14px 18px; margin-bottom: 20px; }
  .compliance-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .compliance-title { font-size: 11px; font-weight: 700; color: #374151; }
  .compliance-pct { font-size: 20px; font-weight: 800; }
  .bar-track { height: 10px; background: #F3F4F6; border-radius: 5px; overflow: hidden; margin-bottom: 6px; }
  .bar-fill { height: 100%; border-radius: 5px; transition: width 0.3s; }
  .compliance-detail { font-size: 10px; color: #6B7280; }

  /* Table */
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th { background: #F9FAFB; padding: 8px 10px; text-align: left; font-weight: 700; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #6B7280; border-bottom: 2px solid #E5E7EB; }
  td { padding: 7px 10px; border-bottom: 1px solid #F3F4F6; color: #374151; }
  tr:hover td { background: #F9FAFB; }
  .td-name { font-weight: 600; color: #1a1a2e; }
  .td-bar { width: 50px; }
  .mini-bar-track { height: 4px; background: #F3F4F6; border-radius: 2px; overflow: hidden; }
  .mini-bar-fill { height: 100%; border-radius: 2px; }

  /* Footer */
  .footer-bar { background: #F9FAFB; border-top: 1px solid #E5E7EB; padding: 12px 28px; display: flex; justify-content: space-between; align-items: center; margin-top: 20px; }
  .footer-bar .f-brand { font-size: 10px; font-weight: 600; color: #374151; }
  .footer-bar .f-note { font-size: 9px; color: #9CA3AF; }

  .ok { color: #00C9A7; } .warn { color: #F59E0B; } .danger { color: #EF4444; } .blue { color: #3B82F6; }
</style>
</head>
<body>

<!-- Header -->
<div class="header-bar">
  <div>
    <h1>Phloton Unit ${unit.unitNumber}</h1>
    <div class="subtitle">Comprehensive Device Report — Enhanced Innovations Pvt Ltd</div>
  </div>
  <div class="right">
    <div class="date">${now}</div>
    <div class="status-pill ${unit.online ? "status-online" : "status-offline"}">${unit.online ? "Online" : "Offline"}</div>
  </div>
</div>

<div class="content">

  <!-- Executive Summary Row -->
  <div class="exec-row">
    <div class="health-card">
      <div class="label">Unit Health</div>
      <div class="score" style="color:${healthColor}">${healthScore}</div>
      <div class="verdict" style="color:${healthColor}">${healthLabel}</div>
      ${buildGauge(healthScore, 100, healthColor, "/100", 70)}
    </div>
    <div class="gauges-row">
      <div class="gauge-card">
        <div class="g-label">Flask Temp</div>
        <div class="g-value ${tempAlert ? "danger" : "ok"}">${unit.flaskTemp !== null ? unit.flaskTemp.toFixed(1) + "°" : "--"}</div>
        <div class="g-sub">Safe: 2–8°C</div>
      </div>
      <div class="gauge-card">
        <div class="g-label">Battery</div>
        <div class="g-value ${unit.batterySoC !== null && unit.batterySoC < 20 ? "warn" : "ok"}">${unit.batterySoC !== null ? unit.batterySoC.toFixed(0) + "%" : "--"}</div>
        <div class="g-sub">State of Charge</div>
      </div>
      <div class="gauge-card">
        <div class="g-label">Voltage</div>
        <div class="g-value ${unit.batteryVoltage !== null && unit.batteryVoltage < 11.5 ? "warn" : "blue"}">${unit.batteryVoltage !== null ? unit.batteryVoltage.toFixed(1) + "V" : "--"}</div>
        <div class="g-sub">Nominal: 12–16.8V</div>
      </div>
      <div class="gauge-card">
        <div class="g-label">Ambient</div>
        <div class="g-value ${unit.ambientTemp !== null && unit.ambientTemp > 45 ? "warn" : "ok"}">${unit.ambientTemp !== null ? unit.ambientTemp.toFixed(1) + "°" : "--"}</div>
        <div class="g-sub">Heat Sink</div>
      </div>
    </div>
  </div>

  <!-- Smart Insights -->
  ${insights.length > 0 ? `
  <div class="insights">
    <h3>Key Insights</h3>
    <ul>
      ${insights.map((i) => `<li>${i}</li>`).join("")}
    </ul>
  </div>
  ` : ""}

  <!-- Temperature Compliance -->
  <div class="compliance">
    <div class="compliance-header">
      <div class="compliance-title">Cold Chain Compliance (2–8°C)</div>
      <div class="compliance-pct ${compliancePct >= 90 ? "ok" : compliancePct >= 70 ? "warn" : "danger"}">${compliancePct.toFixed(1)}%</div>
    </div>
    <div class="bar-track">
      <div class="bar-fill" style="width:${compliancePct.toFixed(1)}%;background:${compliancePct >= 90 ? "#00C9A7" : compliancePct >= 70 ? "#F59E0B" : "#EF4444"}"></div>
    </div>
    <div class="compliance-detail">
      ${tempData.length > 0
        ? `${tempData.length.toLocaleString()} readings analyzed over ${tempStats ? tempStats.firstTime + " — " + tempStats.lastTime : "the monitoring period"}. ${excursions.length.toLocaleString()} readings outside safe zone.`
        : "No temperature data available."}
    </div>
  </div>

  <!-- Trend Charts -->
  <div class="section-title"><div class="dot" style="background:#00C9A7"></div> Historical Trends</div>
  <div class="chart-grid">
    <div class="chart-card">
      <div class="c-header">
        <div class="c-title">Flask Temperature</div>
        <div class="c-badge" style="background:${tempAlert ? "#FEE2E2" : "#ECFDF5"};color:${tempAlert ? "#991B1B" : "#065F46"}">${tempAlert ? "ALERT" : "NORMAL"}</div>
      </div>
      ${tempSparkline}
      <div class="c-stats">
        <span><div class="dot" style="background:#00C9A7"></div> Avg: ${tempStats ? tempStats.avg.toFixed(1) : "--"}°C</span>
        <span><div class="dot" style="background:#3B82F6"></div> Min: ${tempStats ? tempStats.min.toFixed(1) : "--"}°C</span>
        <span><div class="dot" style="background:#EF4444"></div> Max: ${tempStats ? tempStats.max.toFixed(1) : "--"}°C</span>
      </div>
    </div>
    <div class="chart-card">
      <div class="c-header">
        <div class="c-title">Battery State of Charge</div>
        <div class="c-badge" style="background:${battStats && battStats.avg < 20 ? "#FEF3C7" : "#EFF6FF"};color:${battStats && battStats.avg < 20 ? "#92400E" : "#1E40AF"}">${battStats && battStats.avg < 20 ? "LOW" : "OK"}</div>
      </div>
      ${battSparkline}
      <div class="c-stats">
        <span><div class="dot" style="background:#3B82F6"></div> Avg: ${battStats ? battStats.avg.toFixed(0) : "--"}%</span>
        <span><div class="dot" style="background:#10B981"></div> Max: ${battStats ? battStats.max.toFixed(0) : "--"}%</span>
        <span><div class="dot" style="background:#EF4444"></div> Min: ${battStats ? battStats.min.toFixed(0) : "--"}%</span>
      </div>
    </div>
    <div class="chart-card">
      <div class="c-header">
        <div class="c-title">Battery Voltage</div>
        <div class="c-badge" style="background:#F5F3FF;color:#5B21B6">${voltStats ? voltStats.latest.toFixed(1) + "V" : "--"}</div>
      </div>
      ${voltSparkline}
      <div class="c-stats">
        <span><div class="dot" style="background:#8B5CF6"></div> Avg: ${voltStats ? voltStats.avg.toFixed(1) : "--"}V</span>
        <span><div class="dot" style="background:#10B981"></div> Max: ${voltStats ? voltStats.max.toFixed(1) : "--"}V</span>
        <span><div class="dot" style="background:#EF4444"></div> Min: ${voltStats ? voltStats.min.toFixed(1) : "--"}V</span>
      </div>
    </div>
    <div class="chart-card">
      <div class="c-header">
        <div class="c-title">Heat Sink Temperature</div>
        <div class="c-badge" style="background:${heatStats && heatStats.max > 50 ? "#FEF3C7" : "#FFF7ED"};color:${heatStats && heatStats.max > 50 ? "#92400E" : "#9A3412"}">${heatStats ? heatStats.max.toFixed(0) + "°C peak" : "--"}</div>
      </div>
      ${heatSparkline}
      <div class="c-stats">
        <span><div class="dot" style="background:#F59E0B"></div> Avg: ${heatStats ? heatStats.avg.toFixed(1) : "--"}°C</span>
        <span><div class="dot" style="background:#EF4444"></div> Max: ${heatStats ? heatStats.max.toFixed(1) : "--"}°C</span>
        <span><div class="dot" style="background:#3B82F6"></div> Min: ${heatStats ? heatStats.min.toFixed(1) : "--"}°C</span>
      </div>
    </div>
  </div>

  <!-- Detailed Sensor Data -->
  ${detailedVars.length > 0 ? `
  <div class="page-break"></div>
  <div class="section-title"><div class="dot" style="background:#3B82F6"></div> Detailed Sensor Data</div>
  <table>
    <thead>
      <tr>
        <th>Sensor</th>
        <th>Latest</th>
        <th>Average</th>
        <th>Min</th>
        <th>Max</th>
        <th>Readings</th>
        <th>Data Period</th>
      </tr>
    </thead>
    <tbody>
      ${detailedVars.map((v) => `
      <tr>
        <td class="td-name">${v.name}</td>
        <td>${v.latest.toFixed(2)}</td>
        <td>${v.avg.toFixed(2)}</td>
        <td>${v.min.toFixed(2)}</td>
        <td>${v.max.toFixed(2)}</td>
        <td>${v.count.toLocaleString()}</td>
        <td>${v.firstTime} — ${v.lastTime}</td>
      </tr>
      `).join("")}
    </tbody>
  </table>
  ` : ""}

  ${unit.faultStatus !== null && unit.faultStatus !== 0 ? `
  <div style="margin-top:16px;background:#FEF2F2;border:1px solid #FECACA;border-radius:12px;padding:14px 18px;">
    <div style="font-weight:700;font-size:12px;color:#991B1B;margin-bottom:4px;">Active Fault — Code ${unit.faultStatus}</div>
    <div style="font-size:11px;color:#7F1D1D;">This unit is reporting an active hardware fault. Inspect TEC module, fan assemblies, and wiring harness. Check the fault code reference in the service manual.</div>
  </div>
  ` : ""}

  ${unit.location ? `
  <div style="margin-top:16px;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:12px;padding:14px 18px;">
    <div style="font-weight:700;font-size:11px;color:#374151;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Device Location</div>
    <div style="font-size:12px;color:#1a1a2e;">
      <strong>${unit.location.lat.toFixed(6)}° N, ${unit.location.lng.toFixed(6)}° E</strong>
      <span style="font-size:10px;color:#9CA3AF;margin-left:8px;">— Last reported GPS coordinates</span>
    </div>
  </div>
  ` : ""}
</div>

<!-- Footer -->
<div class="footer-bar">
  <div class="f-brand">Phloton Fleet Dashboard — Enhanced Innovations Pvt Ltd</div>
  <div class="f-note">Auto-generated report. For real-time data, refer to the fleet dashboard.</div>
</div>

</body>
</html>`;

  const win = window.open("", "_blank");
  if (win) {
    win.document.write(html);
    win.document.close();
    setTimeout(() => win.print(), 600);
  }
}
