/**
 * Telegram bot webhook (interactive Phloton device agent — prototype).
 *
 * Telegram → POST here (JSON). We validate the secret-token header,
 * resolve the sender's Telegram user id → a Phloton profile, scope to
 * their devices, and reply *in the webhook response* (Telegram supports
 * returning a `sendMessage` method object — no outbound call needed).
 *
 * Public URL once deployed: https://app.phloton.com/api/telegram
 * Link a user:  profiles.telegram_id = '<numeric telegram id>'
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { loadUnitsForProfile, answer, type Profile } from "@/lib/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function reply(chatId: number | string, text: string) {
  // Telegram executes this method from the webhook response body.
  return NextResponse.json({ method: "sendMessage", chat_id: chatId, text });
}

export async function POST(req: NextRequest) {
  // 1. Only Telegram (knows our secret) may call this.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (
    !secret ||
    req.headers.get("x-telegram-bot-api-secret-token") !== secret
  ) {
    return new Response("Forbidden", { status: 403 });
  }

  const update = await req.json().catch(() => null);
  const msg = update?.message ?? update?.edited_message;
  const chatId = msg?.chat?.id;
  const fromId = msg?.from?.id;
  const text: string = msg?.text ?? "";

  // Acknowledge anything we can't act on (no chat, non-text, etc.).
  if (!chatId || !fromId) return NextResponse.json({ ok: true });

  if (!supabaseAdmin) {
    return reply(chatId, "Backend not configured. Please contact support.");
  }

  // 2. Resolve Telegram user → Phloton profile.
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("user_id, role")
    .eq("telegram_id", String(fromId))
    .maybeSingle();

  if (!profile) {
    return reply(
      chatId,
      `This Telegram account isn't linked to Phloton yet.\n\n` +
        `Your Telegram ID: ${fromId}\n` +
        `Ask the admin to register it (then resend your command).`
    );
  }

  // 3. Scope to the units they may see, then answer.
  const { snaps, none } = await loadUnitsForProfile(
    supabaseAdmin,
    profile as Profile
  );
  if (none) {
    return reply(
      chatId,
      "No devices are assigned to your account yet. Contact prerit@phloton.com."
    );
  }

  return reply(chatId, answer(text, snaps));
}

// Health check (handy for confirming the URL is reachable).
export async function GET() {
  return new Response("Phloton Telegram webhook OK", { status: 200 });
}
