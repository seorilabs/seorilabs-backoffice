import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import { env } from "@/lib/env";
import { parseMetricDay, shiftMetricDay } from "../metric-day";
import { unifiedMetricRowSchema, type UnifiedMetricKey } from "../unified-metrics";
import type { DatedMetricRow } from "../report-files";

export const VITALS_BASE = "https://playdeveloperreporting.googleapis.com/v1beta1";
export type VitalsRequest = (path: string, body?: unknown) => Promise<unknown>;
export const vitalsRequest: VitalsRequest = async (path, body) => {
  if (!env.googlePlayServiceAccountJson()) throw new Error("PLAY_VITALS_PERMISSION_REQUIRED");
  const auth = new GoogleAuth({ credentials: JSON.parse(env.googlePlayServiceAccountJson()), scopes: ["https://www.googleapis.com/auth/playdeveloperreporting"] });
  const token = await auth.getAccessToken();
  const response = await fetch(VITALS_BASE + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`PLAY_VITALS_HTTP_${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("PLAY_VITALS_REPORT_LIMIT");
  return JSON.parse(text);
};
const dateSchema = z.object({ year: z.number().int(), month: z.number().int(), day: z.number().int(), timeZone: z.object({ id: z.literal("America/Los_Angeles") }).optional() });
const dateText = (value: z.infer<typeof dateSchema>) => {
  const day = `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
  if (!parseMetricDay(day)) throw new Error("PLAY_VITALS_DATE_INVALID"); return day;
};
const date = (day: string) => { const [year, month, date] = day.split("-").map(Number); return { year, month, day: date, timeZone: { id: "America/Los_Angeles" } }; };
const rowSchema = z.object({ aggregationPeriod: z.literal("DAILY"), startTime: dateSchema,
  dimensions: z.array(z.object({ dimension: z.string(), stringValue: z.string().optional(), int64Value: z.string().optional() })).default([]),
  metrics: z.array(z.object({ metric: z.string(), decimalValue: z.object({ value: z.string() }) })) });
const metrics: Record<string, UnifiedMetricKey> = { crashRate: "provider_crash_rate", userPerceivedCrashRate: "provider_user_crash_rate", anrRate: "provider_anr_rate", userPerceivedAnrRate: "provider_user_anr_rate", distinctUsers: "provider_rounded_users" };
/** 분모는 반올림된 표본이다. 비율에서 실제 영향 사용자 수를 역산하거나 차원 비율을 평균하지 않는다. */
export function parseVitalsRows(raw: unknown[], start: string, endExclusive: string): DatedMetricRow[] {
  const seen = new Set<string>();
  return raw.flatMap((value) => {
    const row = rowSchema.parse(value), day = dateText(row.startTime);
    if (day < start || day >= endExclusive) throw new Error("PLAY_VITALS_DATE_MISMATCH");
    const dimensions = Object.fromEntries(row.dimensions.map((one) => {
      const value = one.stringValue ?? one.int64Value;
      if (value === undefined) throw new Error("PLAY_VITALS_DIMENSION_INVALID"); return [one.dimension, value];
    }));
    return row.metrics.map((one) => {
      const metric = metrics[one.metric], value = Number(one.decimalValue.value);
      if (!metric || !one.decimalValue.value.trim() || !Number.isFinite(value) || value < 0 || (one.metric !== "distinctUsers" && value > 100) || (one.metric === "distinctUsers" && !Number.isSafeInteger(value))) throw new Error("PLAY_VITALS_METRIC_INVALID");
      const key = JSON.stringify([day, metric, Object.entries(dimensions).sort(([a], [b]) => a.localeCompare(b))]);
      if (seen.has(key)) throw new Error("PLAY_VITALS_ROW_DUPLICATE"); seen.add(key);
      return { day, row: unifiedMetricRowSchema.parse({ metric, value, numerator: null, denominator: null, dimensions, currency: null, state: value === 0 ? "empty" : "observed", valueStatus: "analyzable" }) };
    });
  });
}
export async function readVitals(input: { packageName: string; start: string; end: string }, request: VitalsRequest = vitalsRequest) {
  let token: string | undefined, found = false;
  const pages = new Set<string>();
  do {
    if (token && pages.has(token) || pages.size > 100) throw new Error("PLAY_VITALS_PAGINATION_INVALID");
    if (token) pages.add(token);
    const page = z.object({ apps: z.array(z.object({ name: z.string(), packageName: z.string() })).default([]), nextPageToken: z.string().optional() }).parse(await request(`/apps:search?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`));
    if (page.apps.some((app) => app.packageName === input.packageName && app.name === `apps/${input.packageName}`)) found = true;
    token = page.nextPageToken;
  } while (token);
  if (!found) throw new Error("PLAY_VITALS_APP_IDENTITY_MISSING");
  const reports: Array<{ reportType: string; sourceUri: string; rows: DatedMetricRow[]; raw: unknown; periodEnd: string | null }> = [];
  for (const [set, names] of [["crashRateMetricSet", ["crashRate", "userPerceivedCrashRate", "distinctUsers"]], ["anrRateMetricSet", ["anrRate", "userPerceivedAnrRate", "distinctUsers"]]] as const) {
    const path = `/apps/${input.packageName}/${set}`;
    const metadata = z.object({ name: z.string(), freshnessInfo: z.object({ freshnesses: z.array(z.object({ aggregationPeriod: z.string(), latestEndTime: dateSchema.extend({ timeZone: z.object({ id: z.string() }).optional() }) })) }).optional() }).parse(await request(path));
    if (metadata.name !== `apps/${input.packageName}/${set}`) throw new Error("PLAY_VITALS_APP_IDENTITY_MISMATCH");
    const fresh = metadata.freshnessInfo?.freshnesses.find((one) => one.aggregationPeriod === "DAILY");
    if (!fresh) { reports.push({ reportType: set, sourceUri: VITALS_BASE + path, rows: [], raw: metadata, periodEnd: null }); continue; }
    if (fresh.latestEndTime.timeZone?.id && fresh.latestEndTime.timeZone.id !== "America/Los_Angeles") throw new Error("PLAY_VITALS_TIMEZONE_MISMATCH");
    const available = dateText({ ...fresh.latestEndTime, timeZone: undefined }), requested = shiftMetricDay(input.end, 1), end = available < requested ? available : requested;
    if (end <= input.start) { reports.push({ reportType: set, sourceUri: VITALS_BASE + path, rows: [], raw: metadata, periodEnd: null }); continue; }
    const rows: unknown[] = [], raw: unknown[] = [metadata], seen = new Set<string>();
    let pageToken: string | undefined;
    do {
      if (pageToken && seen.has(pageToken) || seen.size > 100) throw new Error("PLAY_VITALS_PAGINATION_INVALID");
      if (pageToken) seen.add(pageToken);
      const page = z.object({ rows: z.array(z.unknown()).default([]), nextPageToken: z.string().optional() }).parse(await request(path + ":query", { timelineSpec: { aggregationPeriod: "DAILY", startTime: date(input.start), endTime: date(end) }, metrics: names, pageSize: 1000, ...(pageToken ? { pageToken } : {}) }));
      rows.push(...page.rows); raw.push(page);
      if (rows.length > 100_000) throw new Error("PLAY_VITALS_REPORT_LIMIT"); pageToken = page.nextPageToken;
    } while (pageToken);
    reports.push({ reportType: set, sourceUri: VITALS_BASE + path, rows: parseVitalsRows(rows, input.start, end), raw, periodEnd: shiftMetricDay(end, -1) });
  }
  return reports;
}
