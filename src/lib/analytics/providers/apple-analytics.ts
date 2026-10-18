import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { asc, ASC_BASE, asArray, type JsonApiDoc, type JsonApiResource } from "@/lib/app-store/asc-client";
import { APPLE_REPORT_FIELDS, appleReportRows, parseReportFile, type DatedMetricRow } from "../report-files";
import { parseMetricDay } from "../metric-day";

export type AppleRequest = (path: string) => Promise<JsonApiDoc>;
const defaultRequest: AppleRequest = (path) => asc(path, { signal: AbortSignal.timeout(15_000) });

export async function applePages(path: string, request: AppleRequest = defaultRequest): Promise<JsonApiResource[]> {
  const resources: JsonApiResource[] = [], seen = new Set<string>(), ids = new Set<string>();
  while (path) {
    const url = new URL(path, ASC_BASE);
    if (url.origin !== ASC_BASE || !url.pathname.startsWith("/v1/") || seen.has(url.href) || seen.size >= 100) throw new Error("APPLE_PAGINATION_INVALID");
    seen.add(url.href);
    const page = await request(url.pathname + url.search);
    for (const resource of asArray(page.data)) {
      const key = `${resource.type}:${resource.id}`;
      if (ids.has(key)) throw new Error("APPLE_RESOURCE_DUPLICATE");
      ids.add(key); resources.push(resource);
    }
    path = page.links?.next ?? "";
  }
  return resources;
}

export async function downloadAppleSegment(url: string, request = fetch): Promise<Buffer> {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password || !(/(^|\.)(apple\.com|mzstatic\.com|amazonaws\.com)$/.test(target.hostname))) throw new Error("APPLE_DOWNLOAD_HOST_INVALID");
  // 서명된 다운로드 URL에 ASC JWT를 전송하거나 저장하지 않는다.
  const response = await request(target, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`APPLE_DOWNLOAD_${response.status}`);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.length;
    if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new Error("APPLE_SEGMENT_TOO_LARGE"); }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks);
}

export function appleSegmentVersion(segments: JsonApiResource[]) {
  return createHash("sha256").update(JSON.stringify(segments.map((segment) => [segment.id, segment.attributes?.checksum ?? null, segment.attributes?.sizeInBytes ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest("hex");
}

/** 모든 segment가 확인되기 전에는 하나의 날짜 partition도 내보내지 않는다. */
export async function readAppleInstance(input: {
  appId: string; reportType: string; processingDate: string; segments: JsonApiResource[];
}, download = downloadAppleSegment): Promise<{ rows: DatedMetricRow[]; sourceHash: string; bytes: number }> {
  if (!input.segments.length) throw new Error("APPLE_SEGMENTS_NOT_LANDED");
  const rows: DatedMetricRow[] = [], hashes: string[] = [], seenRows = new Set<string>();
  let bytes = 0, expandedBytes = 0;
  for (const segment of input.segments) {
    const attributes = segment.attributes ?? {};
    if (typeof attributes.url !== "string") throw new Error("APPLE_SEGMENT_URL_MISSING");
    const buffer = await download(attributes.url);
    if (typeof attributes.sizeInBytes === "number" && buffer.length !== attributes.sizeInBytes) throw new Error("APPLE_SEGMENT_SIZE_MISMATCH");
    const md5 = createHash("md5").update(buffer);
    const md5Hex = md5.digest("hex"), md5Base64 = Buffer.from(md5Hex, "hex").toString("base64");
    if (typeof attributes.checksum === "string" && attributes.checksum.toLowerCase() !== md5Hex && attributes.checksum !== md5Base64) throw new Error("APPLE_SEGMENT_CHECKSUM_MISMATCH");
    const content = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer, { maxOutputLength: 32 * 1024 * 1024 }) : buffer;
    expandedBytes += content.length;
    if (expandedBytes > 64 * 1024 * 1024) throw new Error("APPLE_INSTANCE_LIMIT");
    const records = parseReportFile(content, "\t");
    for (const record of records) {
      const key = createHash("sha256").update(JSON.stringify(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
      if (seenRows.has(key)) throw new Error("APPLE_SEGMENT_ROW_DUPLICATE");
      seenRows.add(key);
    }
    rows.push(...appleReportRows(input.reportType, records, input.appId, input.processingDate));
    hashes.push(createHash("sha256").update(buffer).digest("hex"));
    bytes += buffer.length;
    if (rows.length > 100_000 || bytes > 64 * 1024 * 1024) throw new Error("APPLE_INSTANCE_LIMIT");
  }
  return { rows, sourceHash: createHash("sha256").update(hashes.sort().join(":" )).digest("hex"), bytes };
}

export async function appleReportCatalog(appId: string, bundleId: string, request: AppleRequest = defaultRequest) {
  const app = asArray((await request(`/v1/apps/${encodeURIComponent(appId)}?fields[apps]=bundleId`)).data)[0];
  if (!app || app.attributes?.bundleId !== bundleId) throw new Error("APPLE_APP_IDENTITY_MISMATCH");
  const requests = await applePages(`/v1/apps/${encodeURIComponent(appId)}/analyticsReportRequests?limit=200`, request);
  if (!requests.length) throw new Error("APPLE_INITIAL_REPORT_REQUEST_REQUIRED");
  const reports: Array<JsonApiResource & { requestId: string }> = [];
  for (const run of requests) {
    if (run.attributes?.stoppedDueToInactivity === true) continue;
    for (const report of await applePages(`/v1/analyticsReportRequests/${encodeURIComponent(run.id)}/reports?limit=200`, request)) {
      if (typeof report.attributes?.name === "string" && report.attributes.name in APPLE_REPORT_FIELDS) reports.push({ ...report, requestId: run.id });
    }
  }
  return reports;
}

export async function appleInstances(reportId: string, request: AppleRequest = defaultRequest) {
  return (await applePages(`/v1/analyticsReports/${encodeURIComponent(reportId)}/instances?filter[granularity]=DAILY&limit=200`, request))
    .filter((instance) => typeof instance.attributes?.processingDate === "string" && parseMetricDay(instance.attributes.processingDate))
    .sort((a, b) => String(b.attributes!.processingDate).localeCompare(String(a.attributes!.processingDate)));
}
