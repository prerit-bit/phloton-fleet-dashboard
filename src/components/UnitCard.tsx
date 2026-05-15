"use client";

import type { UnitSnapshot } from "@/lib/anedya";

function GaugeMini({
  value,
  label,
  unit,
  min,
  max,
  colorClass,
}: {
  value: number | null;
  label: string;
  unit: string;
  min: number;
  max: number;
  colorClass: string;
}) {
  const pct = value !== null ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  const display = value !== null ? value.toFixed(1) : "--";

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[10px] font-medium text-navy-200 uppercase tracking-wide">
        {label}
      </span>
      <div className="relative h-1.5 w-full rounded-full bg-navy-100 overflow-hidden">
        <div
          className={`absolute left-0 top-0 h-full rounded-full ${colorClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-sm font-semibold text-navy-800">
        {display}
        <span className="text-[10px] font-normal text-navy-200 ml-0.5">{unit}</span>
      </span>
    </div>
  );
}

export default function UnitCard({ unit }: { unit: UnitSnapshot }) {
  const statusColor = unit.online
    ? "bg-emerald-400"
    : unit.online === false
    ? "bg-red-400"
    : "bg-gray-300";

  const statusText = unit.online ? "Online" : unit.online === false ? "Offline" : "Unknown";

  const lastSeen = unit.lastUpdated
    ? new Date(unit.lastUpdated * 1000).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "short",
      })
    : "--";

  // Temperature alert
  const tempAlert =
    unit.flaskTemp !== null && (unit.flaskTemp < 2 || unit.flaskTemp > 8);

  return (
    <a
      href={`/unit/${unit.unitNumber}`}
      className="group block rounded-xl border border-navy-100 bg-white p-4 shadow-sm transition hover:shadow-md hover:border-teal-200"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50 text-teal-600 font-bold text-sm">
            {unit.unitNumber}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-navy-800">
              Unit {unit.unitNumber}
            </h3>
            <p className="text-[10px] text-navy-200">{lastSeen}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div className={`h-2 w-2 rounded-full ${statusColor}`} />
          <span className="text-xs text-navy-200">{statusText}</span>
        </div>
      </div>

      {/* Temperature highlight */}
      {unit.flaskTemp !== null && (
        <div
          className={`mb-3 rounded-lg px-3 py-2 text-center ${
            tempAlert
              ? "bg-red-50 border border-red-200"
              : "bg-teal-50 border border-teal-100"
          }`}
        >
          <span className="text-[10px] uppercase tracking-wide text-navy-200">
            Flask Temp
          </span>
          <p
            className={`text-2xl font-bold ${
              tempAlert ? "text-red-600" : "text-teal-600"
            }`}
          >
            {unit.flaskTemp.toFixed(1)}
            <span className="text-sm font-normal ml-0.5">°C</span>
          </p>
        </div>
      )}

      {/* Mini gauges */}
      <div className="grid grid-cols-3 gap-3">
        <GaugeMini
          value={unit.batterySoC}
          label="Battery"
          unit="%"
          min={0}
          max={100}
          colorClass="bg-emerald-400"
        />
        <GaugeMini
          value={unit.batteryVoltage}
          label="Voltage"
          unit="V"
          min={10}
          max={16.8}
          colorClass="bg-blue-400"
        />
        <GaugeMini
          value={unit.ambientTemp}
          label="Ambient"
          unit="°C"
          min={0}
          max={55}
          colorClass="bg-amber-400"
        />
      </div>

      {/* Fault indicator */}
      {unit.faultStatus !== null && unit.faultStatus !== 0 && (
        <div className="mt-3 rounded-md bg-red-50 px-2 py-1 text-center text-[11px] font-medium text-red-600">
          Fault: {unit.faultStatus}
        </div>
      )}
    </a>
  );
}
