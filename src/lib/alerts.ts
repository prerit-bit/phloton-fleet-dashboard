/**
 * Phloton alert engine.
 *
 * Runs right after each sync (fresh snapshots in Supabase). For every
 * (unit, rule) it maintains an incident state machine in `device_alerts`,
 * appends an audit trail to `alert_events`, and pushes Telegram messages
 * to the unit's owners + an ops channel.
 *
 * Safety: cold-start seeds state silently (no blast on first deploy);
 * a fleet-wide "offline" spike is treated as a pipeline outage (one ops
 * message), not 25 device alerts.
 */

import { supabaseAdmin } from "./supabase";
import { locationLine } from "./bot";

const MIN = 60_000;
const REMINDER_MS = 6 * 60 * MIN; // re-notify cadence while still open

type Snap = {
  unit_number: number;
  flask_temp: number | null;
  battery_soc: number | null;
  fault_status: string | null;
  last_data_at: string | null;
  latitude: number | null;
  longitude: number | null;
};

type RuleId =
  | "temp_excursion"
  | "offline"
  | "low_battery"
  | "critical_battery"
  | "fault";

type Severity = "warning" | "critical";

interface Rule {
  id: RuleId;
  severity: Severity;
  sustainMin: number; // 0 = trip immediately
  // tripped: condition is bad now. cleared: recovered (with hysteresis).
  // Anything that's neither = dead-band → hold current state.
  tripped: (s: Snap, ageMs: number) => boolean;
  cleared: (s: Snap, ageMs: number) => boolean;
  label: (s: Snap, ageMs: number) => string;
}

const RULES: Rule[] = [
  {
    id: "temp_excursion",
    severity: "critical",
    sustainMin: 10,
    tripped: (s) => s.flask_temp != null && (s.flask_temp < 2 || s.flask_temp > 8),
    cleared: (s) => s.flask_temp != null && s.flask_temp >= 3 && s.flask_temp <= 7,
    label: (s) => `Flask ${s.flask_temp?.toFixed(1)}°C (safe 2–8°C)`,
  },
  {
    id: "offline",
    severity: "warning",
    sustainMin: 0,
    tripped: (_s, age) => age > 45 * MIN,
    cleared: (_s, age) => age <= 45 * MIN,
    label: (_s, age) => `No data for ${Math.round(age / MIN)} min`,
  },
  {
    id: "low_battery",
    severity: "warning",
    sustainMin: 0,
    tripped: (s) => s.battery_soc != null && s.battery_soc <= 15 && s.battery_soc > 5,
    cleared: (s) => s.battery_soc != null && s.battery_soc >= 20,
    label: (s) => `Battery ${s.battery_soc?.toFixed(0)}%`,
  },
  {
    id: "critical_battery",
    severity: "critical",
    sustainMin: 0,
    tripped: (s) => s.battery_soc != null && s.battery_soc <= 5,
    cleared: (s) => s.battery_soc != null && s.battery_soc >= 10,
    label: (s) => `Battery CRITICAL ${s.battery_soc?.toFixed(0)}%`,
  },
  {
    id: "fault",
    severity: "critical",
    sustainMin: 0,
    tripped: (s) =>
      !!s.fault_status &&
      !["0", "none", "", "null"].includes(String(s.fault_status).toLowerCase()),
    cleared: (s) =>
      !s.fault_status ||
      ["0", "none", "", "null"].includes(String(s.fault_status).toLowerCase()),
    label: (s) => `Fault: ${s.fault_status}`,
  },
];

function nowIST(): string {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function sendTelegram(chatId: string, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export interface AlertResult {
  opened: number;
  reminders: number;
  cleared: number;
  notified: number;
  pipelineOutage: boolean;
  errors: string[];
}

export async function evaluateAlerts(): Promise<AlertResult> {
  const r: AlertResult = {
    opened: 0,
    reminders: 0,
    cleared: 0,
    notified: 0,
    pipelineOutage: false,
    errors: [],
  };
  const sb = supabaseAdmin;
  if (!sb) {
    r.errors.push("supabaseAdmin not configured");
    return r;
  }

  const now = Date.now();

  const [{ data: snaps }, { data: alertRows }, { data: owners }, { data: profs }] =
    await Promise.all([
      sb
        .from("unit_snapshots")
        .select(
          "unit_number, flask_temp, battery_soc, fault_status, last_data_at, latitude, longitude"
        ),
      sb.from("device_alerts").select("*"),
      sb.from("device_owners").select("unit_number, user_id"),
      sb.from("profiles").select("user_id, telegram_id"),
    ]);

  const snapshots = (snaps ?? []) as Snap[];
  const prior = new Map<string, any>();
  for (const a of alertRows ?? []) prior.set(`${a.unit_number}:${a.rule}`, a);

  // Cold start: empty state table → seed silently, never blast on deploy.
  const seedMode = (alertRows ?? []).length === 0;

  // unit_number → [telegram chat ids of owners]
  const tgByUser = new Map<string, string>();
  for (const p of profs ?? [])
    if (p.telegram_id) tgByUser.set(p.user_id, String(p.telegram_id));
  const ownersByUnit = new Map<number, string[]>();
  for (const o of owners ?? []) {
    const tg = tgByUser.get(o.user_id);
    if (!tg) continue;
    const list = ownersByUnit.get(o.unit_number) ?? [];
    list.push(tg);
    ownersByUnit.set(o.unit_number, list);
  }
  const opsChat = process.env.OPS_TELEGRAM_CHAT_ID;

  // Pre-pass: fleet-wide offline spike = pipeline outage, not 25 alerts.
  let offlineCount = 0;
  for (const s of snapshots) {
    const age = s.last_data_at ? now - new Date(s.last_data_at).getTime() : Infinity;
    if (age > 45 * MIN) offlineCount++;
  }
  const suppressOffline =
    snapshots.length > 0 && offlineCount > snapshots.length / 2;
  r.pipelineOutage = suppressOffline;

  const dispatch = async (
    unit: number,
    rule: RuleId,
    text: string
  ): Promise<void> => {
    const set = new Set<string>(ownersByUnit.get(unit) ?? []);
    if (opsChat) set.add(opsChat);
    for (const chat of Array.from(set)) {
      if (await sendTelegram(chat, text)) r.notified++;
    }
  };

  for (const s of snapshots) {
    const age = s.last_data_at
      ? now - new Date(s.last_data_at).getTime()
      : Infinity;
    const locLn = locationLine(s);
    const locSfx = locLn ? `\n${locLn}` : "";

    for (const rule of RULES) {
      if (rule.id === "offline" && suppressOffline) continue;

      const key = `${s.unit_number}:${rule.id}`;
      const prev = prior.get(key);
      const isTripped = rule.tripped(s, age);
      const isCleared = rule.cleared(s, age);
      const value =
        rule.id === "offline"
          ? Math.round(age / MIN)
          : rule.id.includes("battery")
            ? s.battery_soc
            : s.flask_temp;

      const writeState = async (
        state: string,
        fields: Record<string, any> = {}
      ) => {
        await sb.from("device_alerts").upsert(
          {
            unit_number: s.unit_number,
            rule: rule.id,
            severity: rule.severity,
            state,
            value,
            updated_at: new Date().toISOString(),
            ...fields,
          },
          { onConflict: "unit_number,rule" }
        );
      };
      const logEvent = async (event: string, message: string) => {
        await sb.from("alert_events").insert({
          unit_number: s.unit_number,
          rule: rule.id,
          severity: rule.severity,
          event,
          value,
          message,
        });
      };

      if (isTripped) {
        if (seedMode) {
          // Record current bad state without alerting (deploy day).
          await writeState("open", {
            opened_at: new Date().toISOString(),
            last_notified_at: new Date().toISOString(),
          });
          continue;
        }
        if (!prev || prev.state === "cleared") {
          if (rule.sustainMin > 0) {
            await writeState("pending", {
              opened_at: new Date().toISOString(),
            });
          } else {
            const msg =
              `ALERT — Unit ${s.unit_number}\n` +
              `${rule.label(s, age)}\n${nowIST()} IST${locSfx}`;
            await writeState("open", {
              opened_at: new Date().toISOString(),
              last_notified_at: new Date().toISOString(),
            });
            await logEvent("opened", msg);
            await dispatch(s.unit_number, rule.id, msg);
            r.opened++;
          }
        } else if (prev.state === "pending") {
          const pendingMs = now - new Date(prev.opened_at).getTime();
          if (pendingMs >= rule.sustainMin * MIN) {
            const msg =
              `ALERT — Unit ${s.unit_number}\n` +
              `${rule.label(s, age)} (sustained ${rule.sustainMin}m+)\n${nowIST()} IST${locSfx}`;
            await writeState("open", {
              last_notified_at: new Date().toISOString(),
            });
            await logEvent("opened", msg);
            await dispatch(s.unit_number, rule.id, msg);
            r.opened++;
          } else {
            await writeState("pending");
          }
        } else if (prev.state === "open") {
          const sinceNotify = now - new Date(prev.last_notified_at).getTime();
          if (sinceNotify >= REMINDER_MS) {
            const msg =
              `REMINDER — Unit ${s.unit_number} still alerting\n` +
              `${rule.label(s, age)}\n${nowIST()} IST${locSfx}`;
            await writeState("open", {
              last_notified_at: new Date().toISOString(),
            });
            await logEvent("reminder", msg);
            await dispatch(s.unit_number, rule.id, msg);
            r.reminders++;
          } else {
            await writeState("open");
          }
        }
      } else if (isCleared) {
        if (prev && prev.state === "open") {
          const msg =
            `RESOLVED — Unit ${s.unit_number}\n` +
            `${rule.label(s, age)} — back to normal\n${nowIST()} IST`;
          await writeState("cleared", {
            cleared_at: new Date().toISOString(),
          });
          await logEvent("cleared", msg);
          if (!seedMode) {
            await dispatch(s.unit_number, rule.id, msg);
            r.cleared++;
          }
        } else if (prev && prev.state === "pending") {
          // Was never alerted — drop silently.
          await writeState("cleared", {
            cleared_at: new Date().toISOString(),
          });
        }
      }
      // else: hysteresis dead-band → leave state untouched.
    }
  }

  // One ops message for a suspected pipeline outage (deduped via a row).
  if (suppressOffline && opsChat && !seedMode) {
    const key = `-1:pipeline_down`;
    const prev = prior.get(key);
    const sinceNotify = prev?.last_notified_at
      ? now - new Date(prev.last_notified_at).getTime()
      : Infinity;
    if (!prev || prev.state !== "open" || sinceNotify >= REMINDER_MS) {
      const msg =
        `OPS ALERT — possible pipeline outage\n` +
        `${offlineCount}/${snapshots.length} units have no recent data.\n` +
        `Per-unit offline alerts suppressed. ${nowIST()} IST`;
      await sb.from("device_alerts").upsert(
        {
          unit_number: -1,
          rule: "pipeline_down",
          severity: "critical",
          state: "open",
          opened_at: prev?.opened_at ?? new Date().toISOString(),
          last_notified_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "unit_number,rule" }
      );
      if (await sendTelegram(opsChat, msg)) r.notified++;
    }
  } else if (!suppressOffline && opsChat) {
    // Pipeline recovered → close the ops incident (best-effort).
    await sb
      .from("device_alerts")
      .update({ state: "cleared", cleared_at: new Date().toISOString() })
      .eq("unit_number", -1)
      .eq("rule", "pipeline_down")
      .eq("state", "open");
  }

  return r;
}
