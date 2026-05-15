"use client";

import type { UnitSnapshot } from "@/lib/anedya";

function StatCard({
  label,
  value,
  sub,
  colorClass,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  colorClass: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-navy-100 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wide text-navy-200">
          {label}
        </p>
        {icon}
      </div>
      <p className={`mt-1 text-2xl font-bold ${colorClass}`}>{value}</p>
      {sub && <p className="text-[11px] text-navy-200 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function FleetStats({ units }: { units: UnitSnapshot[] }) {
  const total = units.length;
  const online = units.filter((u) => u.online === true).length;
  const offline = total - online;
  const uptimePct = total > 0 ? ((online / total) * 100).toFixed(0) : "--";

  const temps = units.map((u) => u.flaskTemp).filter((t): t is number => t !== null);
  const avgTemp = temps.length > 0 ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
  const minTemp = temps.length > 0 ? Math.min(...temps) : null;
  const maxTemp = temps.length > 0 ? Math.max(...temps) : null;
  const alertCount = temps.filter((t) => t < 2 || t > 8).length;

  const batteries = units.map((u) => u.batterySoC).filter((b): b is number => b !== null);
  const avgBattery = batteries.length > 0
    ? batteries.reduce((a, b) => a + b, 0) / batteries.length
    : null;
  const lowBattery = batteries.filter((b) => b < 20).length;
  const criticalBattery = batteries.filter((b) => b < 10).length;

  // Health score: weighted composite
  const uptimeScore = total > 0 ? (online / total) * 40 : 0;
  const tempScore = temps.length > 0 ? ((temps.length - alertCount) / temps.length) * 30 : 0;
  const battScore = batteries.length > 0 ? ((batteries.length - lowBattery) / batteries.length) * 20 : 0;
  const faultCount = units.filter((u) => u.faultStatus !== null && u.faultStatus !== 0).length;
  const faultScore = total > 0 ? ((total - faultCount) / total) * 10 : 0;
  const healthScore = Math.round(uptimeScore + tempScore + battScore + faultScore);

  const healthColor = healthScore >= 80 ? "text-emerald-500" : healthScore >= 60 ? "text-amber-500" : "text-red-500";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Fleet Uptime"
          value={`${uptimePct}%`}
          sub={`${online}/${total} online`}
          colorClass={offline > 0 ? "text-amber-500" : "text-teal-500"}
        />
        <StatCard
          label="Avg Flask Temp"
          value={avgTemp !== null ? `${avgTemp.toFixed(1)}°C` : "--"}
          sub={minTemp !== null ? `Range: ${minTemp.toFixed(1)}–${maxTemp!.toFixed(1)}°C` : undefined}
          colorClass={alertCount > 0 ? "text-red-500" : "text-teal-500"}
        />
        <StatCard
          label="Temp Excursions"
          value={alertCount.toString()}
          sub="units outside 2–8°C"
          colorClass={alertCount > 0 ? "text-red-500" : "text-emerald-500"}
        />
        <StatCard
          label="Avg Battery"
          value={avgBattery !== null ? `${avgBattery.toFixed(0)}%` : "--"}
          sub={criticalBattery > 0 ? `${criticalBattery} critical (<10%)` : lowBattery > 0 ? `${lowBattery} low (<20%)` : "All healthy"}
          colorClass={criticalBattery > 0 ? "text-red-500" : lowBattery > 0 ? "text-amber-500" : "text-teal-500"}
        />
        <StatCard
          label="Active Faults"
          value={faultCount.toString()}
          sub={faultCount === 0 ? "No faults detected" : `${faultCount} unit${faultCount > 1 ? "s" : ""} affected`}
          colorClass={faultCount > 0 ? "text-red-500" : "text-emerald-500"}
        />
        <StatCard
          label="Fleet Health"
          value={`${healthScore}/100`}
          sub={healthScore >= 80 ? "Good" : healthScore >= 60 ? "Needs attention" : "Critical"}
          colorClass={healthColor}
        />
      </div>
    </div>
  );
}
