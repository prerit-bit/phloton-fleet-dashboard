/**
 * Twilio WhatsApp webhook (prototype, interactive query bot).
 *
 * Flow: Twilio sandbox → POST here → validate signature → resolve sender's
 * phone to a Phloton user → scope to their devices (admins see all) →
 * parse intent → reply via TwiML.
 *
 * Reply-only: no outbound Twilio API call needed (TwiML response carries
 * the message), so the only secret required is TWILIO_AUTH_TOKEN.
 *
 * Public URL once deployed: https://app.phloton.com/api/whatsapp
 */

import { NextRequest } from "next/server";
import twilio from "twilio";
import { supabaseAdmin } from "@/lib/supabase";

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

// The exact public URL Twilio is configured to call (signature is computed
// over it). Set TWILIO_WEBHOOK_URL to avoid any host-header ambiguity.
function webhookUrl(req: NextRequest): string {
  if (process.env.TWILIO_WEBHOOK_URL) return process.env.TWILIO_WEBHOOK_URL;
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  return `${proto}://${host}/api/whatsapp`;
}

function fmtIST(iso: string | null): string {
  if (!iso) return "no data yet";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Snap = {
  unit_number: number;
  online: boolean | null;
  battery_soc: number | null;
  battery_voltage: number | null;
  flask_temp: number | null;
  ambient_temp: number | null;
  fault_status: string | null;
  last_data_at: string | null;
};

function unitLine(s: Snap): string {
  const state = s.online ? "ONLINE" : s.online === false ? "OFFLINE" : "—";
  const t = s.flask_temp != null ? `${s.flask_temp.toFixed(1)}°C` : "—";
  const b = s.battery_soc != null ? `${s.battery_soc.toFixed(0)}%` : "—";
  return `Unit ${s.unit_number}: ${state}, flask ${t}, batt ${b}`;
}

function unitDetail(s: Snap): string {
  return [
    `Unit ${s.unit_number} — ${s.online ? "ONLINE" : s.online === false ? "OFFLINE" : "unknown"}`,
    `Flask temp: ${s.flask_temp != null ? s.flask_temp.toFixed(1) + "°C" : "—"}`,
    `Ambient: ${s.ambient_temp != null ? s.ambient_temp.toFixed(1) + "°C" : "—"}`,
    `Battery: ${s.battery_soc != null ? s.battery_soc.toFixed(0) + "%" : "—"}` +
      `${s.battery_voltage != null ? " (" + s.battery_voltage.toFixed(1) + "V)" : ""}`,
    `Fault: ${s.fault_status && s.fault_status !== "0" ? s.fault_status : "none"}`,
    `Last update: ${fmtIST(s.last_data_at)} IST`,
  ].join("\n");
}

const HELP =
  "Phloton bot. Commands:\n" +
  "• list — your devices\n" +
  "• status — summary of all your units\n" +
  "• <unit#> (e.g. 19) — full detail for one unit\n" +
  "• temp <unit#> / battery <unit#>\n" +
  "• help";

export async function POST(req: NextRequest) {
  // 1. Validate the request really came from Twilio.
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

  // 2. Resolve sender → Phloton user.
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

  // 3. Determine the units this user may see.
  const isAdmin = profile.role === "admin";
  let allowedUnits: number[] | null = null; // null = all (admin)
  if (!isAdmin) {
    const { data: owned } = await supabaseAdmin
      .from("device_owners")
      .select("unit_number")
      .eq("user_id", profile.user_id);
    allowedUnits = (owned ?? []).map((r: any) => r.unit_number);
    if (allowedUnits.length === 0) {
      return twiml(
        "No devices are assigned to your account yet. Contact prerit@phloton.com."
      );
    }
  }

  let q = supabaseAdmin
    .from("unit_snapshots")
    .select(
      "unit_number, online, battery_soc, battery_voltage, flask_temp, ambient_temp, fault_status, last_data_at"
    )
    .order("unit_number", { ascending: true });
  if (allowedUnits) q = q.in("unit_number", allowedUnits);

  const { data: snapsRaw } = await q;
  const snaps = (snapsRaw ?? []) as Snap[];

  // 4. Parse intent.
  const text = body.toLowerCase();
  const numMatch = text.match(/\b(\d{1,3})\b/);
  const askedUnit = numMatch ? parseInt(numMatch[1], 10) : null;

  if (!body || text === "help" || text.startsWith("help")) {
    return twiml(HELP);
  }

  if (askedUnit != null) {
    const s = snaps.find((x) => x.unit_number === askedUnit);
    if (!s) {
      return twiml(
        `Unit ${askedUnit} isn't in your account (or has no data yet).`
      );
    }
    if (text.includes("temp")) {
      return twiml(
        `Unit ${askedUnit} flask temp: ${
          s.flask_temp != null ? s.flask_temp.toFixed(1) + "°C" : "—"
        } (as of ${fmtIST(s.last_data_at)} IST)`
      );
    }
    if (text.includes("batt")) {
      return twiml(
        `Unit ${askedUnit} battery: ${
          s.battery_soc != null ? s.battery_soc.toFixed(0) + "%" : "—"
        }${
          s.battery_voltage != null
            ? " (" + s.battery_voltage.toFixed(1) + "V)"
            : ""
        }`
      );
    }
    return twiml(unitDetail(s));
  }

  if (text.includes("list") || text.includes("device")) {
    if (snaps.length === 0) return twiml("No devices found for your account.");
    return twiml(
      `Your devices (${snaps.length}):\n` +
        snaps.map((s) => `• Unit ${s.unit_number} — ${s.online ? "online" : "offline"}`).join("\n")
    );
  }

  if (text.includes("status") || text.includes("all") || text.includes("summary")) {
    if (snaps.length === 0) return twiml("No devices found for your account.");
    return twiml(snaps.map(unitLine).join("\n"));
  }

  return twiml("Sorry, I didn't get that.\n\n" + HELP);
}

// Twilio sends a GET when verifying the URL in the console.
export async function GET() {
  return new Response("Phloton WhatsApp webhook OK", { status: 200 });
}
