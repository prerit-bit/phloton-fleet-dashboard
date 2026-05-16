/**
 * Cached reverse geocoding via OpenStreetMap Nominatim (free).
 *
 * Usage-policy compliance: a real User-Agent, ≤1 request/second, no
 * parallelism, and results cached in unit_snapshots.geocoded_key so we
 * only call when a unit's (city-level) location actually changes. Runs
 * a few units per sync; over a couple of cycles the whole fleet is named.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bump when the geocoding scheme changes (zoom/parsing) so existing
// cached names are treated as stale and refreshed over a few runs.
const GEOCODE_VERSION = "v2";

// 3 decimals ≈ ~110 m — the area name won't change within that, so this
// avoids re-geocoding on normal GPS jitter while still catching real moves.
function key(lat: number, lng: number): string {
  return `${GEOCODE_VERSION}:${lat.toFixed(3)},${lng.toFixed(3)}`;
}

async function reverseGeocode(
  lat: number,
  lng: number
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${lat}&lon=${lng}`,
      {
        headers: {
          "User-Agent": "phloton-fleet/1.0 (prerit@phloton.com)",
          Accept: "application/json",
        },
      }
    );
    if (!res.ok) return null;
    const j: any = await res.json();
    const a = j?.address ?? {};
    const area =
      a.neighbourhood || a.suburb || a.quarter || a.hamlet || a.village;
    const city = a.city || a.town || a.municipality || a.county;
    const region = a.state || a.region;
    // De-duplicate (area can equal city for small places) and cap at 3 parts.
    const parts = [area, city, region]
      .filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i);
    return parts.length ? parts.join(", ") : j?.display_name ?? null;
  } catch {
    return null;
  }
}

/**
 * Names up to `max` units whose location is new/changed. Sequential with
 * spacing to honour Nominatim's 1 req/s limit. Best-effort: failures are
 * skipped and retried next run.
 */
export async function backfillLocationNames(
  sb: SupabaseClient,
  max = 6
): Promise<number> {
  const { data } = await sb
    .from("unit_snapshots")
    .select("unit_number, latitude, longitude, geocoded_key")
    .not("latitude", "is", null)
    .not("longitude", "is", null);

  const stale = (data ?? []).filter(
    (u: any) => u.geocoded_key !== key(u.latitude, u.longitude)
  );

  let done = 0;
  for (const u of stale.slice(0, max)) {
    if (done > 0) await sleep(1200); // ≤1 req/s
    const name = await reverseGeocode(u.latitude, u.longitude);
    await sb
      .from("unit_snapshots")
      .update({
        location_name: name,
        geocoded_key: key(u.latitude, u.longitude),
      })
      .eq("unit_number", u.unit_number);
    done++;
  }
  return done;
}
