"use client";

/**
 * Fleet Health — daily device-health scores from the physics-anchored
 * statistical model (health/ pipeline). Reads the 29-row unit_health table;
 * RLS scopes customers to their own units, admins see the fleet.
 *
 * Charts render the evidence behind each flag: the indicator's own history,
 * the unit's baseline, the alarm threshold, and the day drift was detected.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase/client";
import {
  Bar, BarChart, Cell, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid,
} from "recharts";

type Concern = { severity: "high" | "medium" | "low"; text: string };
type SeriesSpec = {
  label: string; unit: string;
  points: { d: string; v: number }[];
  baseline: number | null; threshold: number | null;
  direction: number | null; flagged_on: string | null;
};
type HealthRow = {
  unit_number: number;
  health_score: number | null;
  status: "ok" | "watch" | "degraded" | "action" | "no_data";
  computed_at: string;
  last_data_day: string | null;
  active_days: number | null;
  concerns: Concern[];
  indicators: {
    fleet_z?: Record<string, number>;
    runways?: Record<string, { days_to_threshold: number; slope_per_day: number }>;
    series?: Record<string, SeriesSpec>;
    [k: string]: any;
  };
};

const STATUS_META: Record<HealthRow["status"], { label: string; pill: string; dot: string; bar: string }> = {
  ok:       { label: "Nominal",       pill: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500", bar: "#10B981" },
  watch:    { label: "Watch",         pill: "bg-amber-50 text-amber-700 border-amber-200",       dot: "bg-amber-500",   bar: "#F59E0B" },
  degraded: { label: "Degraded",      pill: "bg-orange-50 text-orange-700 border-orange-200",    dot: "bg-orange-500",  bar: "#F97316" },
  action:   { label: "Action needed", pill: "bg-red-50 text-red-700 border-red-200",             dot: "bg-red-500",     bar: "#EF4444" },
  no_data:  { label: "No data",       pill: "bg-gray-50 text-gray-500 border-gray-200",          dot: "bg-gray-400",    bar: "#9CA3AF" },
};
const SEV_DOT: Record<Concern["severity"], string> = {
  high: "bg-red-500", medium: "bg-amber-500", low: "bg-gray-400",
};

const INDICATORS = [
  { name: "Insulation holding time (τ)", how: "How many hours the flask takes to warm toward ambient with the cooler off — measured from overnight warm-ups using Newton's law of cooling.", why: "A falling τ means the vacuum insulation or lid seal is degrading: every watt of cooling buys less holdover." },
  { name: "Cooling effort per °C", how: "How hard the TEC must work (duty fraction) for each degree of lift between ambient and flask, measured during steady holds.", why: "Rising effort at the same conditions means the thermoelectric module or its thermal interfaces are aging." },
  { name: "Heatsink rise over ambient", how: "How far the hot-side heatsink sits above ambient while cooling.", why: "A climbing rise points at fan wear or dust — the hot side is where cooling efficiency dies first." },
  { name: "Battery internal resistance", how: "Voltage sag each time the TEC kicks on (~70 natural load-step tests per active day), giving R = ΔV/ΔI.", why: "Internal resistance is the classic early marker of lithium-ion aging — it rises long before capacity visibly fades." },
  { name: "Telemetry coverage", how: "Fraction of each day the unit actually reported, and its longest silent gap.", why: "In our own history, units faded for weeks before going permanently dark — coverage decay predicted both losses." },
  { name: "Sensor sanity", how: "Share of raw readings that are physically impossible, frozen, or missing entirely — checked per sensor, before any filtering.", why: "A cold-chain device with a lying or absent temperature sensor is a compliance blind spot even if cooling works." },
  { name: "Excursion minutes", how: "Minutes per active day the flask sat above 8 °C while the unit was trying to cool.", why: "The customer-facing failure: payload out of the 2–8 °C band." },
];

const TIERS = [
  { range: "85–100", label: "Nominal", cls: "text-emerald-700", desc: "tracking the fleet norm on every indicator" },
  { range: "70–84", label: "Watch", cls: "text-amber-700", desc: "one indicator off-norm or drifting — review, no action forced" },
  { range: "50–69", label: "Degraded", cls: "text-orange-700", desc: "clear off-norm behaviour — inspect at next opportunity" },
  { range: "< 50", label: "Action needed", cls: "text-red-700", desc: "multiple indicators failing or a critical fault signature" },
];


/** Axis label + plain-language reading guide, per indicator. */
const HI_META: Record<string, { axis: string; worse: "up" | "down"; pct?: boolean; read: string }> = {
  tau_hr: {
    axis: "Hours", worse: "down",
    read: "How long the flask holds its cold once the cooler stops. A falling line means insulation or the lid seal is degrading — every watt of cooling buys less holdover than it used to.",
  },
  hs_rise: {
    axis: "°C above ambient", worse: "up",
    read: "How much hotter the heatsink runs than the surrounding air while cooling. Climbing means the fan is wearing or the fins are dusty. Below zero is physically impossible — the hot side cannot be colder than the room — and points at a miswired sensor.",
  },
  r_int: {
    axis: "Ohms (Ω)", worse: "up",
    read: "Battery internal resistance, read from the voltage sag each time the cooler switches on. A rising line is the classic early sign of pack ageing — it shows up long before you notice lost runtime.",
  },
  duty_per_dT: {
    axis: "Duty fraction per °C", worse: "up",
    read: "How hard the cooler has to work for each degree it holds below ambient. Rising means the thermoelectric module or its thermal paste is losing efficiency: same job, more power.",
  },
  coverage: {
    axis: "% of day reported", worse: "down", pct: true,
    read: "How much of the day the unit actually sent data. A falling line means the modem is fading — this is the indicator that flagged both units we permanently lost, weeks before they went dark.",
  },
  sensor_bad_frac: {
    axis: "% of readings bad", worse: "up", pct: true,
    read: "Share of the day's readings that were physically impossible, out of range, or frozen at one value. A rising line means a sensor is failing — the unit may still cool fine while reporting numbers you cannot trust.",
  },
  excursion_min: {
    axis: "Minutes per day", worse: "up",
    read: "Minutes per day the payload sat above 8 °C while the unit was trying to cool. This is the failure a customer actually experiences, so it is scored on outcome rather than cause.",
  },
};

function scoreColor(s: number | null): string {
  if (s === null) return "text-gray-400";
  if (s >= 85) return "text-emerald-600";
  if (s >= 70) return "text-amber-600";
  if (s >= 50) return "text-orange-600";
  return "text-red-600";
}
const shortDate = (d: string) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" });

/** Which indicators carry the story for this unit — flagged, trending, or off-norm. */
function chartedIndicators(r: HealthRow): [string, SeriesSpec][] {
  const series = r.indicators?.series ?? {};
  const z = r.indicators?.fleet_z ?? {};
  const runways = r.indicators?.runways ?? {};
  const scored = Object.entries(series).map(([k, s]) => {
    let w = 0;
    if (runways[k]) w += 100 - Math.min(runways[k].days_to_threshold, 99);
    if (s.flagged_on) w += 40;
    const zz = z[k];
    if (zz !== undefined) w += Math.min(Math.abs(zz), 6) * 10;
    return { k, s, w };
  });
  return scored.filter((x) => x.w > 0).sort((a, b) => b.w - a.w).slice(0, 4)
    .map((x) => [x.k, x.s] as [string, SeriesSpec]);
}

function IndicatorChart({ hiKey, spec }: { hiKey: string; spec: SeriesSpec }) {
  const meta = HI_META[hiKey];
  const scale = meta?.pct ? 100 : 1;
  const vals = spec.points.map((p) => p.v * scale);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.25, Math.abs(hi || 1) * 0.05, 0.05);
  let dMin = lo - pad, dMax = hi + pad;

  // Only draw the alarm line if it sits near the data — otherwise it would
  // flatten the very drift we're trying to show. Named in the caption instead.
  const thr = spec.threshold === null || spec.threshold === undefined ? null : spec.threshold * scale;
  const thrInView =
    thr !== null && thr !== undefined && thr >= dMin - (dMax - dMin) && thr <= dMax + (dMax - dMin);
  if (thrInView && thr !== null && thr !== undefined) {
    dMin = Math.min(dMin, thr - pad); dMax = Math.max(dMax, thr + pad);
  }
  const base = spec.baseline === null || spec.baseline === undefined ? null : spec.baseline * scale;
  const data = spec.points.map((p) => ({ ...p, v: p.v * scale, label: shortDate(p.d) }));
  const unitSuffix = meta?.pct ? "%" : spec.unit ? ` ${spec.unit}` : "";

  return (
    <div className="rounded-lg border border-navy-100 p-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-navy-800">{spec.label}</span>
        <span className="text-[10px] text-navy-200">
          now {vals[vals.length - 1].toFixed(meta?.pct ? 1 : 2)}{unitSuffix}
          {meta && <span className="ml-1">· {meta.worse === "up" ? "higher is worse" : "lower is worse"}</span>}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={130}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: 2, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#94A3B8" }} interval="preserveStartEnd" minTickGap={24} />
          <YAxis domain={[dMin, dMax]} tick={{ fontSize: 9, fill: "#94A3B8" }} width={58}
            tickFormatter={(v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2))}
            label={{ value: meta?.axis ?? spec.unit ?? "", angle: -90, position: "insideLeft",
                     style: { fontSize: 9, fill: "#64748B", textAnchor: "middle" } }} />
          <Tooltip
            contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #E2E8F0" }}
            formatter={(v: any) => [`${Number(v).toFixed(meta?.pct ? 1 : 3)}${unitSuffix}`, spec.label]}
          />
          {base !== null && base !== undefined && (
            <ReferenceLine y={base} stroke="#64748B" strokeDasharray="4 3" strokeWidth={1}
              label={{ value: "baseline", position: "insideTopLeft", fontSize: 8, fill: "#64748B" }} />
          )}
          {thrInView && (
            <ReferenceLine y={thr as number} stroke="#EF4444" strokeDasharray="5 3" strokeWidth={1}
              label={{ value: "alarm", position: "insideTopRight", fontSize: 8, fill: "#EF4444" }} />
          )}
          {spec.flagged_on && (
            <ReferenceLine x={shortDate(spec.flagged_on)} stroke="#F59E0B" strokeDasharray="3 3" strokeWidth={1}
              label={{ value: "drift", position: "top", fontSize: 8, fill: "#F59E0B" }} />
          )}
          <Line type="monotone" dataKey="v" stroke="#0EA5E9" strokeWidth={1.8} dot={{ r: 1.5 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      {!thrInView && thr !== null && (
        <p className="mt-1 text-[10px] text-navy-200">Alarm level {thr}{unitSuffix} — beyond this chart&apos;s range</p>
      )}
      {meta && <p className="mt-2 text-[11px] leading-relaxed text-navy-200">{meta.read}</p>}
    </div>
  );
}

export default function HealthPage() {
  const [rows, setRows] = useState<HealthRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});

  useEffect(() => {
    (async () => {
      if (!supabase) { setError("client unavailable"); return; }
      const { data, error } = await supabase
        .from("unit_health").select("*").order("health_score", { ascending: true });
      if (error) setError(error.message);
      else {
        const rs = (data ?? []) as HealthRow[];
        setRows(rs);
        // charts expanded by default for anything that needs attention
        const o: Record<number, boolean> = {};
        rs.forEach((r) => { if (r.status === "action" || r.status === "degraded") o[r.unit_number] = true; });
        setOpen(o);
      }
    })();
  }, []);

  const computedAt = rows?.[0]?.computed_at;
  const scored = (rows ?? []).filter((r) => r.health_score !== null);
  const fleetData = scored.map((r) => ({
    unit: `U${r.unit_number}`, score: r.health_score as number,
    fill: STATUS_META[r.status]?.bar ?? "#9CA3AF",
  }));

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">Fleet Health</h1>
          <p className="mt-1 text-sm text-navy-200">
            Daily device-health assessment from telemetry physics — updated{" "}
            {computedAt ? new Date(computedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "…"}
          </p>
        </div>
        <Link href="/" className="rounded-lg border border-navy-100 bg-white px-4 py-2 text-sm font-medium text-navy-800 hover:bg-gray-50">
          ← Fleet overview
        </Link>
      </div>

      {/* Fleet ranking chart */}
      {fleetData.length > 0 && (
        <section className="mb-6 rounded-2xl border border-navy-100 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-bold uppercase tracking-wide text-navy-200">Fleet health ranking</h2>
          <p className="mt-1 text-xs text-navy-200">
            Each bar is one unit; taller is healthier. Bar colour repeats the action tier, and the dashed lines are the
            tier boundaries — a bar below the red line needs attention now, below amber needs review. Units with no
            telemetry in the window aren&apos;t scored and don&apos;t appear here.
          </p>
          <div className="mt-4">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={fleetData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                <XAxis dataKey="unit" tick={{ fontSize: 10, fill: "#64748B" }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#94A3B8" }} width={58}
                  label={{ value: "Health score (0–100)", angle: -90, position: "insideLeft",
                           style: { fontSize: 10, fill: "#64748B", textAnchor: "middle" } }} />
                <Tooltip cursor={{ fill: "#F8FAFC" }} contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #E2E8F0" }}
                  formatter={(v: any) => [`${v} / 100`, "Health score"]} />
                <ReferenceLine y={85} stroke="#10B981" strokeDasharray="4 3" strokeWidth={1}
                  label={{ value: "nominal", position: "right", fontSize: 8, fill: "#10B981" }} />
                <ReferenceLine y={70} stroke="#F59E0B" strokeDasharray="4 3" strokeWidth={1}
                  label={{ value: "watch", position: "right", fontSize: 8, fill: "#F59E0B" }} />
                <ReferenceLine y={50} stroke="#EF4444" strokeDasharray="4 3" strokeWidth={1}
                  label={{ value: "action", position: "right", fontSize: 8, fill: "#EF4444" }} />
                <Bar dataKey="score" radius={[4, 4, 0, 0]}>
                  {fleetData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      {/* What the score signifies */}
      <section className="mb-6 rounded-2xl border border-navy-100 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-bold uppercase tracking-wide text-navy-200">What the score signifies</h2>
        <p className="mt-2 text-sm text-navy-800">
          Each unit gets a <span className="font-semibold">0–100 score describing its current state</span>: how far its
          measured physics sit from the fleet norm, combined across every indicator below. The score is deliberately
          not a black box — every deduction is traceable to a named indicator, and the concerns listed against each
          unit are exactly those deductions in plain language. Trends and countdowns ("runways") capture where a unit
          is <span className="font-semibold">heading</span>, which is why a currently-calm unit can still carry warnings.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {TIERS.map((t) => (
            <div key={t.label} className="rounded-lg border border-navy-100 p-3">
              <div className={`text-lg font-bold ${t.cls}`}>{t.range}</div>
              <div className="text-sm font-semibold text-navy-800">{t.label}</div>
              <div className="mt-1 text-xs text-navy-200">{t.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* How health is measured */}
      <section className="mb-6 rounded-2xl border border-navy-100 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-bold uppercase tracking-wide text-navy-200">How we measure it</h2>
        <p className="mt-2 text-sm text-navy-800">
          Seven physical health indicators are computed for every unit, every day, from its raw telemetry. Each is
          watched three ways: drift against the unit&apos;s <em>own</em> historical baseline, deviation from the
          <em> fleet</em> norm, and its trend extrapolated to an alarm level. In backtesting over six months of fleet
          history, this approach flagged both units that later went permanently offline — 24 days and 4 days in
          advance — and independently rediscovered every known hardware defect in the fleet.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {INDICATORS.map((ind) => (
            <div key={ind.name} className="rounded-lg border border-navy-100 p-4">
              <div className="text-sm font-semibold text-navy-800">{ind.name}</div>
              <p className="mt-1 text-xs text-navy-200"><span className="font-medium text-navy-800">Measured:</span> {ind.how}</p>
              <p className="mt-1 text-xs text-navy-200"><span className="font-medium text-navy-800">Predicts:</span> {ind.why}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Per-unit health */}
      <section>
        <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-navy-200">Units — points of concern</h2>
        <p className="mb-3 text-xs text-navy-200">
          Each chart plots one health indicator over time for that unit. The{" "}
          <span className="font-medium text-navy-800">horizontal axis is the date</span>; the{" "}
          <span className="font-medium text-navy-800">vertical axis is labelled with what is being measured</span> —
          hours, °C, ohms, minutes or a percentage. The grey dashed line is that unit&apos;s{" "}
          <span className="font-medium text-navy-800">own baseline</span> (its normal, learned from its early history),
          the red dashed line is the <span className="font-medium text-red-600">alarm level</span> where we act, and the
          amber line marks the day <span className="font-medium text-amber-600">drift</span> was first detected. The
          gap between the trace and the grey line is how far this device has moved from its own normal.
        </p>
        {error && <p className="text-sm text-red-600">Failed to load health data: {error}</p>}
        {!rows && !error && <p className="text-sm text-navy-200">Loading…</p>}
        {rows && rows.length === 0 && (
          <p className="text-sm text-navy-200">The health engine hasn&apos;t published yet — first run lands after the next daily job.</p>
        )}
        <div className="grid gap-3">
          {rows?.map((r) => {
            const meta = STATUS_META[r.status] ?? STATUS_META.no_data;
            const charts = chartedIndicators(r);
            const isOpen = !!open[r.unit_number];
            return (
              <div key={r.unit_number} className="rounded-xl border border-navy-100 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} />
                  <Link href={`/unit/${r.unit_number}`} className="text-sm font-bold text-navy-800 hover:underline">
                    Unit {r.unit_number}
                  </Link>
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${meta.pill}`}>{meta.label}</span>
                  <span className={`ml-auto text-2xl font-bold ${scoreColor(r.health_score)}`}>
                    {r.health_score ?? "—"}
                  </span>
                </div>
                <div className="mt-1 text-xs text-navy-200">
                  {r.last_data_day ? `last data ${r.last_data_day} · ${r.active_days} analysed day(s)` : "no telemetry in the analysis window"}
                </div>
                {r.concerns?.length > 0 ? (
                  <ul className="mt-3 space-y-1.5">
                    {r.concerns.map((c, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-navy-800">
                        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEV_DOT[c.severity] ?? SEV_DOT.low}`} />
                        {c.text}
                      </li>
                    ))}
                  </ul>
                ) : r.status !== "no_data" ? (
                  <p className="mt-3 text-sm text-emerald-700">No concerns detected — all indicators on fleet norm.</p>
                ) : null}

                {charts.length > 0 && (
                  <>
                    <button
                      onClick={() => setOpen((p) => ({ ...p, [r.unit_number]: !isOpen }))}
                      className="mt-3 text-xs font-medium text-teal-600 hover:underline"
                    >
                      {isOpen ? "Hide evidence charts" : `Show evidence charts (${charts.length})`}
                    </button>
                    {isOpen && (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        {charts.map(([k, spec]) => <IndicatorChart key={k} hiKey={k} spec={spec} />)}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <p className="mt-6 text-xs text-navy-200">
        Method: physics-anchored statistical model (EWMA drift control charts, robust fleet z-scores with MAD floors,
        Theil–Sen trend runways) over daily indicators extracted from raw Anedya telemetry. Not a machine-learning
        black box — every flag is explainable and every threshold is a physical quantity.
      </p>
    </main>
  );
}
