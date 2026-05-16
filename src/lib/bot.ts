/**
 * Channel-agnostic Phloton chat-agent core.
 *
 * Both the WhatsApp (Twilio) and Telegram webhooks use this: given a
 * resolved profile, load the units they may see (RLS-equivalent: admins
 * all, else their device_owners) and turn a free-text command into a
 * reply string. Transport/auth lives in each route; logic lives here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type Snap = {
  unit_number: number;
  online: boolean | null;
  battery_soc: number | null;
  battery_voltage: number | null;
  flask_temp: number | null;
  ambient_temp: number | null;
  fault_status: string | null;
  last_data_at: string | null;
  latitude: number | null;
  longitude: number | null;
};

/** Google Maps link + coords, or null if the unit has no location. */
export function locationLine(s: {
  latitude: number | null;
  longitude: number | null;
}): string | null {
  if (s.latitude == null || s.longitude == null) return null;
  const lat = s.latitude.toFixed(5);
  const lng = s.longitude.toFixed(5);
  return `Location: ${lat}, ${lng}\nhttps://maps.google.com/?q=${lat},${lng}`;
}

export type Profile = { user_id: string; role: string | null };

export const HELP =
  "Phloton bot. Commands:\n" +
  "• list — your devices\n" +
  "• status — summary of all your units\n" +
  "• <unit#> (e.g. 19) — full detail for one unit\n" +
  "• temp <unit#> / battery <unit#>\n" +
  "• help";

export function fmtIST(iso: string | null): string {
  if (!iso) return "no data yet";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function unitLine(s: Snap): string {
  const state = s.online ? "ONLINE" : s.online === false ? "OFFLINE" : "—";
  const t = s.flask_temp != null ? `${s.flask_temp.toFixed(1)}°C` : "—";
  const b = s.battery_soc != null ? `${s.battery_soc.toFixed(0)}%` : "—";
  return `Unit ${s.unit_number}: ${state}, flask ${t}, batt ${b}`;
}

function unitDetail(s: Snap): string {
  return [
    `Unit ${s.unit_number} — ${
      s.online ? "ONLINE" : s.online === false ? "OFFLINE" : "unknown"
    }`,
    `Flask temp: ${s.flask_temp != null ? s.flask_temp.toFixed(1) + "°C" : "—"}`,
    `Ambient: ${s.ambient_temp != null ? s.ambient_temp.toFixed(1) + "°C" : "—"}`,
    `Battery: ${s.battery_soc != null ? s.battery_soc.toFixed(0) + "%" : "—"}` +
      `${s.battery_voltage != null ? " (" + s.battery_voltage.toFixed(1) + "V)" : ""}`,
    `Fault: ${s.fault_status && s.fault_status !== "0" ? s.fault_status : "none"}`,
    `Last update: ${fmtIST(s.last_data_at)} IST`,
    locationLine(s) ?? "Location: unknown",
  ].join("\n");
}

/**
 * Units this profile may see. `none` = a non-admin with zero assigned
 * devices (caller should show a "contact us" message).
 */
export async function loadUnitsForProfile(
  admin: SupabaseClient,
  profile: Profile
): Promise<{ snaps: Snap[]; none: boolean }> {
  const isAdmin = profile.role === "admin";
  let allowedUnits: number[] | null = null;

  if (!isAdmin) {
    const { data: owned } = await admin
      .from("device_owners")
      .select("unit_number")
      .eq("user_id", profile.user_id);
    allowedUnits = (owned ?? []).map((r: any) => r.unit_number);
    if (allowedUnits.length === 0) return { snaps: [], none: true };
  }

  let q = admin
    .from("unit_snapshots")
    .select(
      "unit_number, online, battery_soc, battery_voltage, flask_temp, ambient_temp, fault_status, last_data_at, latitude, longitude"
    )
    .order("unit_number", { ascending: true });
  if (allowedUnits) q = q.in("unit_number", allowedUnits);

  const { data } = await q;
  return { snaps: (data ?? []) as Snap[], none: false };
}

/** Pure: command text + visible snapshots → reply text. */
export function answer(text: string, snaps: Snap[]): string {
  const body = (text ?? "").trim();
  const lc = body.toLowerCase();
  const numMatch = lc.match(/\b(\d{1,3})\b/);
  const askedUnit = numMatch ? parseInt(numMatch[1], 10) : null;

  if (!body || lc === "help" || lc.startsWith("help") || lc === "/start") {
    return HELP;
  }

  if (askedUnit != null) {
    const s = snaps.find((x) => x.unit_number === askedUnit);
    if (!s) return `Unit ${askedUnit} isn't in your account (or has no data yet).`;
    if (lc.includes("temp")) {
      return `Unit ${askedUnit} flask temp: ${
        s.flask_temp != null ? s.flask_temp.toFixed(1) + "°C" : "—"
      } (as of ${fmtIST(s.last_data_at)} IST)`;
    }
    if (lc.includes("batt")) {
      return `Unit ${askedUnit} battery: ${
        s.battery_soc != null ? s.battery_soc.toFixed(0) + "%" : "—"
      }${s.battery_voltage != null ? " (" + s.battery_voltage.toFixed(1) + "V)" : ""}`;
    }
    return unitDetail(s);
  }

  if (lc.includes("list") || lc.includes("device")) {
    if (snaps.length === 0) return "No devices found for your account.";
    return (
      `Your devices (${snaps.length}):\n` +
      snaps
        .map((s) => `• Unit ${s.unit_number} — ${s.online ? "online" : "offline"}`)
        .join("\n")
    );
  }

  if (lc.includes("status") || lc.includes("all") || lc.includes("summary")) {
    if (snaps.length === 0) return "No devices found for your account.";
    return snaps.map(unitLine).join("\n");
  }

  return "Sorry, I didn't get that.\n\n" + HELP;
}
