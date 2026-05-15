"use client";

import { useEffect, useRef } from "react";
import type { UnitSnapshot } from "@/lib/anedya";

// We dynamically import Leaflet to avoid SSR issues
let L: typeof import("leaflet") | null = null;

export default function FleetMap({ units }: { units: UnitSnapshot[] }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);

  useEffect(() => {
    if (!mapRef.current) return;

    // Dynamically import leaflet (client-only)
    import("leaflet").then((leaflet) => {
      L = leaflet;

      if (mapInstanceRef.current) {
        // Update existing markers
        updateMarkers(units);
        return;
      }

      // Default center: India
      const map = L.map(mapRef.current!, {
        center: [20.5937, 78.9629],
        zoom: 5,
        zoomControl: true,
        attributionControl: false,
      });

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
      }).addTo(map);

      mapInstanceRef.current = map;
      updateMarkers(units);

      // Fit bounds if we have locations
      const located = units.filter((u) => u.location);
      if (located.length > 0) {
        const bounds = L.latLngBounds(
          located.map((u) => [u.location!.lat, u.location!.lng] as [number, number])
        );
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
      }
    });

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, []);

  // Update markers when units data changes
  useEffect(() => {
    if (mapInstanceRef.current && L) {
      updateMarkers(units);
    }
  }, [units]);

  function updateMarkers(units: UnitSnapshot[]) {
    if (!L || !mapInstanceRef.current) return;

    // Clear old markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    units.forEach((unit) => {
      if (!unit.location) return;

      const isOnline = unit.online === true;
      const tempAlert =
        unit.flaskTemp !== null && (unit.flaskTemp < 2 || unit.flaskTemp > 8);

      const markerColor = tempAlert
        ? "#EF4444"
        : isOnline
        ? "#00C9A7"
        : "#9CA3AF";

      const icon = L!.divIcon({
        className: "custom-marker",
        html: `
          <div style="
            width: 32px; height: 32px;
            background: ${markerColor};
            border: 3px solid white;
            border-radius: 50%;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            display: flex; align-items: center; justify-content: center;
            color: white; font-weight: 700; font-size: 11px;
            font-family: system-ui;
          ">${unit.unitNumber}</div>
        `,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      });

      const temp = unit.flaskTemp !== null ? `${unit.flaskTemp.toFixed(1)}°C` : "--";
      const battery = unit.batterySoC !== null ? `${unit.batterySoC.toFixed(0)}%` : "--";
      const statusClass = isOnline ? "online" : "offline";
      const statusLabel = isOnline ? "Online" : "Offline";

      const popup = `
        <div class="unit-popup" style="min-width: 140px; font-family: system-ui;">
          <h3>Unit ${unit.unitNumber}</h3>
          <span class="status ${statusClass}">${statusLabel}</span>
          <div style="margin-top: 8px; font-size: 12px; color: #6B7280; line-height: 1.6;">
            <div><strong>Flask:</strong> ${temp}</div>
            <div><strong>Battery:</strong> ${battery}</div>
          </div>
          <a href="/unit/${unit.unitNumber}" style="
            display: block; margin-top: 8px; text-align: center;
            padding: 4px 8px; background: #00C9A7; color: white;
            border-radius: 6px; text-decoration: none; font-size: 11px; font-weight: 600;
          ">View Details</a>
        </div>
      `;

      const marker = L!
        .marker([unit.location.lat, unit.location.lng], { icon })
        .addTo(mapInstanceRef.current!)
        .bindPopup(popup);

      markersRef.current.push(marker);
    });
  }

  return (
    <div
      ref={mapRef}
      className="h-[400px] w-full rounded-xl border border-navy-100 overflow-hidden shadow-sm"
      style={{ zIndex: 0 }}
    />
  );
}
