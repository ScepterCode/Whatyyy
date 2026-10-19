import { del, get, list, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { getDeviceKey, getOwnerHash } from "../../../lib/storage/device-capability";
import { parseStoredReport } from "../../../lib/storage/report-storage";

export const runtime = "nodejs";

const REPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REPORT_BYTES = 1_000_000;
const MAX_REPORTS_PER_DEVICE = 5_000;
const PRIVATE_CACHE_HEADERS = { "Cache-Control": "private, no-store" };

function hasBlobConfiguration(): boolean {
  return Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}

function reportPrefix(ownerHash: string): string {
  return `reports/${ownerHash}/`;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: PRIVATE_CACHE_HEADERS });
}

async function readReport(pathname: string) {
  const blob = await get(pathname, { access: "private", useCache: false });
  if (!blob || blob.statusCode !== 200) return null;
  return parseStoredReport(await new Response(blob.stream).json());
}

async function listReportBlobs(prefix: string) {
  const blobs = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, limit: 1_000, cursor });
    blobs.push(...page.blobs);
    if (blobs.length > MAX_REPORTS_PER_DEVICE) {
      throw new Error("This device has too many saved reports to list. Delete all saved reports and try again.");
    }
    cursor = page.hasMore ? page.cursor : undefined;
    if (page.hasMore && !cursor) throw new Error("Report storage returned an incomplete list.");
  } while (cursor);
  return blobs;
}

function authorizedOwner(request: Request): string | null {
  const deviceKey = getDeviceKey(request);
  return deviceKey ? getOwnerHash(deviceKey) : null;
}

export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("mode") === "config") {
    return NextResponse.json({ storage: hasBlobConfiguration() ? "blob" : "local" });
  }
  if (!hasBlobConfiguration()) return jsonError("Private report storage is not configured.", 503);
  const ownerHash = authorizedOwner(request);
  if (!ownerHash) return jsonError("This device’s report-storage key is missing or invalid.", 401);

  try {
    const blobs = await listReportBlobs(reportPrefix(ownerHash));
    const reports = [];
    for (const blob of blobs) {
      const report = await readReport(blob.pathname);
      if (report) reports.push(report);
    }
    reports.sort((left, right) => right.created_at.localeCompare(left.created_at));
    return NextResponse.json({ reports }, { headers: PRIVATE_CACHE_HEADERS });
  } catch (error) {
    console.error("Could not list private reports", error);
    return jsonError(
      error instanceof Error && error.message.includes("too many saved reports")
        ? error.message
        : "Saved reports could not be loaded from private storage.",
      500,
    );
  }
}

export async function POST(request: Request) {
  if (!hasBlobConfiguration()) return jsonError("Private report storage is not configured.", 503);
  const ownerHash = authorizedOwner(request);
  if (!ownerHash) return jsonError("This device’s report-storage key is missing or invalid.", 401);

  let report;
  try {
    const body: unknown = await request.json();
    report = parseStoredReport(body);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "The saved report has an unsupported format.",
      400,
    );
  }
  if (!REPORT_ID_PATTERN.test(report.id)) return jsonError("The report ID is invalid.", 400);
  const body = JSON.stringify(report);
  if (new TextEncoder().encode(body).byteLength > MAX_REPORT_BYTES) {
    return jsonError("This report is too large to save.", 413);
  }

  try {
    await put(`${reportPrefix(ownerHash)}${report.id}.json`, body, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
    return NextResponse.json({ saved: true }, { headers: PRIVATE_CACHE_HEADERS });
  } catch (error) {
    console.error("Could not save private report", error);
    return jsonError("This report could not be saved to private storage.", 502);
  }
}

export async function DELETE(request: Request) {
  if (!hasBlobConfiguration()) return jsonError("Private report storage is not configured.", 503);
  const ownerHash = authorizedOwner(request);
  if (!ownerHash) return jsonError("This device’s report-storage key is missing or invalid.", 401);
  const url = new URL(request.url);
  const all = url.searchParams.get("all") === "1";
  const id = url.searchParams.get("id");
  if (!all && (!id || !REPORT_ID_PATTERN.test(id))) return jsonError("The report ID is invalid.", 400);

  try {
    const paths = all
      ? (await listReportBlobs(reportPrefix(ownerHash))).map((blob) => blob.pathname)
      : [`${reportPrefix(ownerHash)}${id}.json`];
    if (paths.length) await del(paths);
    return NextResponse.json({ deleted: true }, { headers: PRIVATE_CACHE_HEADERS });
  } catch (error) {
    console.error("Could not delete private reports", error);
    return jsonError("Saved reports could not be deleted from private storage.", 502);
  }
}
