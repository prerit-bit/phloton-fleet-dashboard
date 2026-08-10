/**
 * Anedya-direct telemetry proxy — the chart data path.
 *
 * Replaces reads from Supabase sensor_readings (the table whose growth
 * bricked two free-tier projects). Charts now fetch device history straight
 * from Anedya — the time-series store the devices already pay for — with
 * Supabase reduced to auth + snapshots + alert state.
 *
 * Request:  GET /api/telemetry?unit=21&key=variable_2&from=<s>&to=<s>&bucket=raw|5min|hourly
 * Response: { points: [{ datetime: ISO, value: number }] }
 *
 * Auth:  Supabase session cookie (dashboard) or Authorization: Bearer JWT
 *        (tests/tools).
 * Authz: SELECT on unit_snapshots under the CALLER's JWT — RLS's owns_unit()
 *        answers "may this user see this unit" with zero duplicated logic.
 *        Admins see everything, customers only their device_owners rows.
 *
 * Caching: in-memory per-instance Map, populated only after authz passes.
 *        Deliberately NOT CDN-cached (s-maxage): Vercel's shared cache is
 *        keyed by URL and ignores cookies, so a cached hit would skip the
 *        ownership check entirely. Browser gets Cache-Control: private.
 *        Windows that ended in the past cache long (history never changes);
 *        live windows cache 60s.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  getAllVariables,
  getNodeId,
  getHistoricalData,
  getAggregatedData,
  type HistoricalPoint,
} from "@/lib/anedya";
import { filterValidReadings } from "@/lib/sensor-bounds";

export const dynamic = "force-dynamic";

const LIVE_TTL_MS = 60_000;
const PAST_TTL_MS = 6 * 3600_000;
const RAW_MAX_RANGE_S = 6 * 3600; // beyond this, force aggregation
const cache = new Map<string, { at: number; ttl: number; body: string }>();

function cacheGet(key: string): string | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return null;
  }
  return hit.body;
}

function cacheSet(key: string, body: string, ttl: number) {
  if (cache.size > 500) {
    // crude LRU-ish trim: drop oldest fifth
    const entries = Array.from(cache.entries()).sort((a, b) => a[1].at - b[1].at);
    for (const [k] of entries.slice(0, 100)) cache.delete(k);
  }
  cache.set(key, { at: Date.now(), ttl, body });
}

function supabaseForRequest(req: NextRequest) {
  const bearer = req.headers.get("authorization");
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {}, // route handlers don't refresh sessions
      },
      ...(bearer ? { global: { headers: { Authorization: bearer } } } : {}),
    }
  );
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const unit = parseInt(p.get("unit") ?? "");
  const key = p.get("key") ?? "";
  const from = parseInt(p.get("from") ?? "");
  const to = parseInt(p.get("to") ?? "");
  const bucket = p.get("bucket") ?? "raw";

  if (!Number.isFinite(unit) || !key || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }
  const variable = getAllVariables().find((v) => v.key === key);
  const nodeId = getNodeId(unit);
  if (!variable || !nodeId) {
    return NextResponse.json({ error: "unknown unit or variable" }, { status: 404 });
  }

  // ── auth + RLS-backed ownership ────────────────────────────────────────
  const supabase = supabaseForRequest(req);
  const { data: userRes } = await supabase.auth.getUser();
  if (!userRes?.user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { data: owned } = await supabase
    .from("unit_snapshots")
    .select("unit_number")
    .eq("unit_number", unit)
    .maybeSingle();
  if (!owned) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // ── cached? ────────────────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  const isPast = to < now - 2 * 3600;
  const ttl = isPast ? PAST_TTL_MS : LIVE_TTL_MS;
  const cacheKey = `${unit}|${key}|${bucket}|${from}|${to}`;
  const hit = cacheGet(cacheKey);
  if (hit) {
    return new NextResponse(hit, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, max-age=30",
        "X-Cache": "HIT",
      },
    });
  }

  // ── fetch from Anedya ──────────────────────────────────────────────────
  let points: HistoricalPoint[];
  try {
    if (bucket === "raw" && to - from <= RAW_MAX_RANGE_S) {
      points = await getHistoricalData(nodeId, variable.identifier, from, to);
    } else {
      const interval = bucket === "hourly" || to - from > 3 * 86400 ? 60 : 5;
      points = await getAggregatedData(nodeId, variable.identifier, from, to, interval);
    }
  } catch (err: any) {
    return NextResponse.json(
      { error: `anedya fetch failed: ${err?.message ?? "unknown"}` },
      { status: 502 }
    );
  }

  const clean = filterValidReadings(points, variable.name);
  const body = JSON.stringify({ points: clean });
  cacheSet(cacheKey, body, ttl);
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=30",
      "X-Cache": "MISS",
    },
  });
}
