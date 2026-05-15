"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import type { UnitSnapshot } from "@/lib/anedya";
import { getFleetSnapshotFromSupabase } from "@/lib/supabase-data";
import UnitCard from "@/components/UnitCard";
import FleetStats from "@/components/FleetStats";
import { downloadFile } from "@/lib/export";

// Leaflet must be loaded client-side only
const FleetMap = dynamic(() => import("@/components/FleetMap"), { ssr: false });

const REFRESH_INTERVAL = 30_000; // 30 seconds

export default function DashboardPage() {
  const [units, setUnits] = useState<UnitSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [filter, setFilter] = useState<"all" | "online" | "offline" | "alert">("all");

  const handleFleetCsv = useCallback(() => {
    if (units.length === 0) return;
    const header = "Unit,Status,Flask Temp (°C),Battery SoC (%),Battery Voltage (V),Ambient Temp (°C),Fault,Latitude,Longitude,Last Updated (IST)";
    const rows = units.map((u) => {
      const lastUpdated = u.lastUpdated
        ? new Date(u.lastUpdated * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
        : "";
      return [
        u.unitNumber,
        u.online ? "Online" : u.online === false ? "Offline" : "Unknown",
        u.flaskTemp?.toFixed(1) ?? "",
        u.batterySoC?.toFixed(0) ?? "",
        u.batteryVoltage?.toFixed(1) ?? "",
        u.ambientTemp?.toFixed(1) ?? "",
        u.faultStatus ?? "",
        u.location?.lat ?? "",
        u.location?.lng ?? "",
        lastUpdated,
      ].join(",");
    });
    const csv = [header, ...rows].join("\n");
    const date = new Date().toISOString().slice(0, 10);
    downloadFile(csv, `phloton_fleet_snapshot_${date}.csv`);
  }, [units]);

  const fetchData = useCallback(async () => {
    try {
      // Supabase only: RLS scopes this to the units the signed-in user
      // owns. The direct-Anedya path is intentionally NOT used here — it
      // would bypass RLS and expose the entire fleet.
      const data = await getFleetSnapshotFromSupabase();
      setUnits(data);
      setLastRefresh(new Date());
    } catch (err) {
      console.error("Failed to fetch fleet data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Filter units
  const filtered = units.filter((u) => {
    if (filter === "online") return u.online === true;
    if (filter === "offline") return u.online === false;
    if (filter === "alert")
      return u.flaskTemp !== null && (u.flaskTemp < 2 || u.flaskTemp > 8);
    return true;
  });

  const filterOptions: { key: typeof filter; label: string; count: number }[] = [
    { key: "all", label: "All Units", count: units.length },
    { key: "online", label: "Online", count: units.filter((u) => u.online).length },
    { key: "offline", label: "Offline", count: units.filter((u) => u.online === false).length },
    {
      key: "alert",
      label: "Alerts",
      count: units.filter(
        (u) => u.flaskTemp !== null && (u.flaskTemp < 2 || u.flaskTemp > 8)
      ).length,
    },
  ];

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-teal-200 border-t-teal-500" />
          <p className="text-sm text-navy-200">Loading fleet data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy-800">Devices</h1>
          <p className="text-sm text-navy-200">
            Real-time monitoring of your Phloton cold chain units
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-xs text-navy-200">
              Updated{" "}
              {lastRefresh.toLocaleTimeString("en-IN", {
                timeZone: "Asia/Kolkata",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          )}
          <button
            onClick={handleFleetCsv}
            className="rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm font-medium text-navy-800 shadow-sm transition hover:bg-navy-50 active:scale-95"
          >
            Export CSV
          </button>
          <button
            onClick={fetchData}
            className="rounded-lg bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-teal-600 active:scale-95"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Stats row */}
      <FleetStats units={units} />

      {/* Map */}
      <div>
        <h2 className="mb-3 text-lg font-semibold text-navy-800">Fleet Map</h2>
        <FleetMap units={units} />
      </div>

      {/* Filter tabs + Unit grid */}
      <div>
        <div className="mb-4 flex items-center gap-2">
          {filterOptions.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setFilter(opt.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                filter === opt.key
                  ? "bg-teal-500 text-white shadow-sm"
                  : "bg-white text-navy-200 border border-navy-100 hover:bg-navy-50"
              }`}
            >
              {opt.label}
              <span
                className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] ${
                  filter === opt.key
                    ? "bg-white/20 text-white"
                    : "bg-navy-50 text-navy-200"
                }`}
              >
                {opt.count}
              </span>
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-xl border border-navy-100 bg-white p-12 text-center">
            {units.length === 0 ? (
              <p className="text-navy-200">
                No devices are assigned to your account yet. Contact{" "}
                <a
                  href="mailto:prerit@phloton.com"
                  className="text-teal-600 hover:underline"
                >
                  prerit@phloton.com
                </a>{" "}
                to get access.
              </p>
            ) : (
              <p className="text-navy-200">No units match this filter.</p>
            )}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((unit) => (
              <UnitCard key={unit.unitNumber} unit={unit} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
