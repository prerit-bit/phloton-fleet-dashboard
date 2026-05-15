/**
 * Twilio WhatsApp webhook (interactive Phloton device agent — prototype).
 *
 * Twilio → POST here → validate signature → resolve sender phone → scope
 * to their devices → reply via TwiML. Shared command logic lives in
 * src/lib/bot.ts (same as the Telegram bot).
 *
 * Reply-only: TwiML response carries the message, so the only secret
 * needed is TWILIO_AUTH_TOKEN.
 *
 * Public URL once deployed: https://app.phloton.com/api/whatsapp
 */

import { NextRequest } from "next/server";
import twilio from "twilio";
import { supabaseAdmin } from "@/lib/supabase";
import { loadUnitsForProfile, answer, type Profile } from "@/lib/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function twiml(message: string): Response {
  const r = new twilio.twiml.MessagingResponse();
  r.message(message);
  return new Response(r.toString(), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

// The exact public URL Twilio is configured to call (signature is
// computed over it). Set TWILIO_WEBHOOK_URL to avoid host-header drift.
function webhookUrl(req: NextRequest): string {
  if (process.env.TWILIO_WEBHOOK_URL) return process.env.TWILIO_WEBHOOK_URL;
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  return `${proto}://${host}/api/whatsapp`;
}

export async function POST(req: NextRequest) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error("[whatsapp] TWILIO_AUTH_TOKEN not set");
    return twiml("Service not configured. Please contact support.");
  }

  const form = await req.formData();
  const params: Record<string, string> = {};
  form.forEach((v, k) => {
    params[k] = String(v);
  });

  const signature = req.headers.get("x-twilio-signature") ?? "";
  const valid = twilio.validateRequest(
    authToken,
    signature,
    webhookUrl(req),
    params
  );
  if (!valid) {
    console.warn("[whatsapp] invalid Twilio signature");
    return new Response("Forbidden", { status: 403 });
  }

  if (!supabaseAdmin) {
    return twiml("Backend not configured. Please contact support.");
  }

  const from = (params.From ?? "").replace("whatsapp:", "").trim();
  const body = (params.Body ?? "").trim();

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("user_id, role")
    .eq("phone", from)
    .maybeSingle();

  if (!profile) {
    return twiml(
      "This WhatsApp number isn't registered for Phloton. " +
        "Contact prerit@phloton.com to get access."
    );
  }

  const { snaps, none } = await loadUnitsForProfile(
    supabaseAdmin,
    profile as Profile
  );
  if (none) {
    return twiml(
      "No devices are assigned to your account yet. Contact prerit@phloton.com."
    );
  }

  return twiml(answer(body, snaps));
}

// Twilio sends a GET when verifying the URL in the console.
export async function GET() {
  return new Response("Phloton WhatsApp webhook OK", { status: 200 });
}
