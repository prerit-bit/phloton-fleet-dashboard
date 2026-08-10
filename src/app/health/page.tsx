"use client";

/**
 * Fleet Health — daily device-health scores from the physics-anchored
 * statistical model (health/ pipeline). Reads the 29-row unit_health table;
 * RLS scopes customers to their own units, admins see the fleet.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase/client";

type Concern = { severity: "high" | "medium" | "low"; text: string };
type HealthRow = {
  unit_number: number;
  health_score: number | null;
  status: "ok" | "watch" | "degraded" | "action" | "no_data";
  computed_at: string;
  last_data_day: string | null;
  active_days: number | null;
  concerns: Concern[];
  indicators: Record<string, any>;
};

const STATUS_META: Record<HealthRow["status"], { label: string; pill: string; dot: string }> = {
  ok:       { label: "Nominal",       pill: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  watch:    { label: "Watch",         pill: "bg-amber-50 text-amber-700 border-amber-200",       dot: "bg-amber-500" },
  degraded: { label: "Degraded",      pill: "bg-orange-50 text-orange-700 border-orange-200",    dot: "bg-orange-500" },
  action:   { label: "Action needed", pill: "bg-red-50 text-red-700 border-red-200",             dot: "bg-red-500" },
  no_data:  { label: "No data",       pill: "bg-gray-50 text-gray-500 border-gray-200",          dot: "bg-gray-400" },
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

function scoreColor(s: number | null): string {
  if (s === null) return "text-gray-400";
  if (s >= 85) return "text-emerald-600";
  if (s >= 70) return "text-amber-600";
  if (s >= 50) return "text-orange-600";
  return "text-red-600";
}

export default function HealthPage() {
  const [rows, setRows] = useState<HealthRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!supabase) { setError("client unavailable"); return; }
      const { data, error } = await supabase
        .from("unit_health")
        .select("*")
        .order("health_score", { ascending: true });
      if (error) setError(error.message);
      else setRows((data ?? []) as HealthRow[]);
    })();
  }, []);

  const computedAt = rows?.[0]?.computed_at;

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
          watched three ways: drift against the unit's <em>own</em> historical baseline, deviation from the
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
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-navy-200">Units — points of concern</h2>
        {error && <p className="text-sm text-red-600">Failed to load health data: {error}</p>}
        {!rows && !error && <p className="text-sm text-navy-200">Loading…</p>}
        {rows && rows.length === 0 && (
          <p className="text-sm text-navy-200">The health engine hasn't published yet — first run lands after the next daily job.</p>
        )}
        <div className="grid gap-3">
          {rows?.map((r) => {
            const meta = STATUS_META[r.status] ?? STATUS_META.no_data;
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
