/**
 * Nightly retention job:
 *   1. Archive every UTC day's raw sensor_readings (older than 7 days)
 *      to Google Drive as `phloton-raw-YYYY-MM-DD.csv.gz`.
 *   2. Call public.phloton_retention_step() to aggregate those raw rows
 *      into hourly buckets and delete the originals.
 *
 * Idempotent: a day's file is uploaded only if it doesn't already exist
 * in the target folder, so reruns are safe.
 *
 * Env (all from GitHub Actions secrets):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   GDRIVE_SA_JSON         — full service-account JSON key
 *   GDRIVE_FOLDER_ID       — Drive folder ID, shared with the SA email
 */

import { google } from "googleapis";
import { gzip as gzipCb } from "zlib";
import { promisify } from "util";
import { supabaseAdmin } from "../src/lib/supabase";

const gzip = promisify(gzipCb);
const PAGE = 1000;
const RAW_RETENTION_DAYS = 7;

function dayISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfUTCDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

async function main() {
  const sb = supabaseAdmin;
  if (!sb) throw new Error("Supabase service role key not configured.");

  const credsJson = process.env.GDRIVE_SA_JSON;
  const folderId = process.env.GDRIVE_FOLDER_ID;
  if (!credsJson || !folderId) {
    throw new Error(
      "GDRIVE_SA_JSON and GDRIVE_FOLDER_ID must be set in env."
    );
  }
  const credentials = JSON.parse(credsJson);

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  const drive = google.drive({ version: "v3", auth });

  // 1. Find oldest raw row eligible for archive (older than 7d).
  const cutoff = startOfUTCDay(
    new Date(Date.now() - RAW_RETENTION_DAYS * 86_400_000)
  );
  const { data: oldest } = await sb
    .from("sensor_readings")
    .select("recorded_at")
    .lt("recorded_at", cutoff.toISOString())
    .order("recorded_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!oldest) {
    console.log("Nothing older than 7 days to archive.");
    // Still run the retention step in case sync_log needs trimming.
    const { data: r } = await sb.rpc("phloton_retention_step");
    console.log("phloton_retention_step:", JSON.stringify(r));
    return;
  }

  // 2. Iterate UTC days from oldest to (today - 7d), archiving each.
  let archivedDays = 0;
  let skippedDays = 0;
  let totalRows = 0;
  for (
    let d = startOfUTCDay(new Date(oldest.recorded_at));
    d < cutoff;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const dayStart = new Date(d);
    const dayEnd = new Date(d);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const filename = `phloton-raw-${dayISO(dayStart)}.csv.gz`;

    // 2a. Skip if already in Drive.
    const list = await drive.files.list({
      q: `name = '${filename}' and '${folderId}' in parents and trashed = false`,
      fields: "files(id, name)",
      pageSize: 1,
    });
    if (list.data.files && list.data.files.length > 0) {
      skippedDays++;
      continue;
    }

    // 2b. Page through all rows for this day.
    const rows: any[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await sb
        .from("sensor_readings")
        .select(
          "unit_number, node_id, variable_key, variable_name, value, recorded_at"
        )
        .gte("recorded_at", dayStart.toISOString())
        .lt("recorded_at", dayEnd.toISOString())
        .order("recorded_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      rows.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    if (rows.length === 0) continue;

    // 2c. Build CSV, gzip, upload.
    const header =
      "unit_number,node_id,variable_key,variable_name,value,recorded_at";
    const lines = rows.map((r) =>
      [
        r.unit_number,
        r.node_id,
        r.variable_key,
        JSON.stringify(r.variable_name ?? ""),
        r.value,
        r.recorded_at,
      ].join(",")
    );
    const gz = await gzip(Buffer.from([header, ...lines].join("\n")));

    const { Readable } = await import("stream");
    await drive.files.create({
      requestBody: {
        name: filename,
        parents: [folderId],
        mimeType: "application/gzip",
      },
      media: { mimeType: "application/gzip", body: Readable.from(gz) },
    });

    archivedDays++;
    totalRows += rows.length;
    console.log(
      `Archived ${dayISO(dayStart)}: ${rows.length} rows → ${filename} (${gz.length} bytes)`
    );
  }

  console.log(
    `Archive summary: ${archivedDays} day(s) uploaded, ${skippedDays} already in Drive, ${totalRows} rows total.`
  );

  // 3. Aggregate raw >7d into hourly + delete originals (transactional).
  const { data: r, error: rpcErr } = await sb.rpc("phloton_retention_step");
  if (rpcErr) throw rpcErr;
  console.log("phloton_retention_step:", JSON.stringify(r));
}

main().catch((err) => {
  console.error("Retention failed:", err);
  process.exit(1);
});
