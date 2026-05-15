/**
 * /api/sync — Triggered by Vercel Cron every 5 minutes.
 *
 * Pulls latest data from Anedya → pushes to Supabase.
 * First run does a full historical backfill (may take a few minutes).
 * Subsequent runs are incremental (seconds).
 *
 * Vercel Cron config is in vercel.json.
 * Can also be triggered manually: POST /api/sync
 *
 * Security: Protected by CRON_SECRET header (Vercel sets this automatically).
 */

import { NextRequest, NextResponse } from "next/server";
import { runSync } from "@/lib/sync";

// Vercel Hobby caps functions at 60s. The full Anedya→Supabase sync runs
// far longer, so the scheduled sync runs in GitHub Actions (no time cap),
// not via this endpoint. This route is kept for small manual/incremental
// triggers only.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Verify cron secret in production
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runSync();
    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    console.error("[/api/sync] Fatal error:", err);
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}

// Also support POST for manual triggers
export async function POST(request: NextRequest) {
  return GET(request);
}
