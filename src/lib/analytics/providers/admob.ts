import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { parseMetricDay, metricDaysBetween } from "../metric-day";
import { unifiedMetricRowSchema, type UnifiedMetricKey } from "../unified-metrics";
import type { DatedMetricRow } from "../report-files";

export const ADMOB_BASE = "https://admob.googleapis.com/v1";
export type AdmobRequest = (path: string, body?: unknown) => Promise<unknown>;
export const admobRequest: AdmobRequest = async (path, body) => {
  const raw = process.env.ADMOB_REPORTING_OAUTH_JSON;
  if (!raw) throw new Error("ADMOB_OAUTH_PERMISSION_REQUIRED");
  // Play/Firebase 서비스 계정으로 대체하지 않는다. 기존 사용자 동의의 refresh token만 사용한다.
  const input = z.object({ client_id: z.string().min(1), client_secret: z.string().min(1), refresh_token: z.string().min(1) }).parse(JSON.parse(raw));
  const client = new OAuth2Client(input.client_id, input.client_secret);
  client.setCredentials({ refresh_token: input.refresh_token });
  const token = (await client.getAccessToken()).token;
  const response = await fetch(ADMOB_BASE + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`ADMOB_HTTP_${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("ADMOB_REPORT_LIMIT");
  return JSON.parse(text);
};
const date = (day: string) => { const [year, month, date] = day.split("-").map(Number); return { year, month, day: date }; };
const dateText = (input: { year: number; month: number; day: number }) => `${input.year}-${String(input.month).padStart(2, "0")}-${String(input.day).padStart(2, "0")}`;
const valueSchema = z.object({ integerValue: z.union([z.string(), z.number()]).optional(), microsValue: z.union([z.string(), z.number()]).optional() });
const streamSchema = z.array(z.object({
  header: z.object({ dateRange: z.object({ startDate: z.object({ year: z.number(), month: z.number(), day: z.number() }), endDate: z.object({ year: z.number(), month: z.number(), day: z.number() }) }), localizationSettings: z.object({ currencyCode: z.string().regex(/^[A-Z]{3}$/) }) }).optional(),
  row: z.object({ dimensionValues: z.record(z.object({ value: z.string() })), metricValues: z.record(valueSchema) }).optional(),
  footer: z.object({ matchingRowCount: z.union([z.string(), z.number()]), warnings: z.array(z.unknown()).optional() }).optional(),
}));
export function parseAdmobReport(raw: unknown, input: { appId: string; start: string; end: string; processingDate: string; currency: string }): DatedMetricRow[] {
  const stream = streamSchema.parse(raw), header = stream[0]?.header, footer = stream.at(-1)?.footer;
  const rows = stream.flatMap((part) => part.row ? [part.row] : []);
  if (!header || !footer || stream.length !== rows.length + 2 || rows.length !== Number(footer.matchingRowCount) || footer.warnings?.length) throw new Error("ADMOB_PARTIAL_RESPONSE");
  if (dateText(header.dateRange.startDate) !== input.start || dateText(header.dateRange.endDate) !== input.end || header.localizationSettings.currencyCode !== input.currency) throw new Error("ADMOB_SCOPE_MISMATCH");
  const metrics: Record<string, UnifiedMetricKey> = { AD_REQUESTS: "ad_requests", MATCHED_REQUESTS: "matched_requests", IMPRESSIONS: "ad_impressions", CLICKS: "ad_clicks", ESTIMATED_EARNINGS: "ad_estimated_revenue" };
  return rows.flatMap((cell) => {
    if (cell.dimensionValues.APP?.value !== input.appId) throw new Error("ADMOB_APP_MISMATCH");
    const rawDate = cell.dimensionValues.DATE?.value;
    const day = rawDate && parseMetricDay(`${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`);
    if (!day || day < input.start || day > input.end) throw new Error("ADMOB_DATE_INVALID");
    const dimensions = Object.fromEntries(Object.entries(cell.dimensionValues).filter(([key]) => !["APP", "DATE"].includes(key)).map(([key, value]) => [key, value.value]));
    const values = Object.fromEntries(Object.keys(metrics).map((key) => {
      const rawValue = key === "ESTIMATED_EARNINGS" ? cell.metricValues[key]?.microsValue : cell.metricValues[key]?.integerValue;
      if (rawValue === undefined || !/^\d+$/.test(String(rawValue)) || !Number.isSafeInteger(Number(rawValue))) throw new Error("ADMOB_METRIC_INVALID");
      return [key, Number(rawValue) / (key === "ESTIMATED_EARNINGS" ? 1e6 : 1)];
    }));
    const cells = Object.entries(metrics).map(([key, metric]) => ({ day, row: unifiedMetricRowSchema.parse({ metric, value: values[key], dimensions, currency: key === "ESTIMATED_EARNINGS" ? input.currency : null, state: values[key] === 0 ? "empty" : "observed", valueStatus: metricDaysBetween(input.processingDate, day) < 2 ? "provisional" : key === "ESTIMATED_EARNINGS" ? "estimated" : "analyzable" }) }));
    for (const [metric, numerator, denominator] of [["match_rate", values.MATCHED_REQUESTS, values.AD_REQUESTS], ["show_rate", values.IMPRESSIONS, values.MATCHED_REQUESTS]] as const) {
      const value = denominator > 0 ? 100 * numerator / denominator : null;
      cells.push({ day, row: unifiedMetricRowSchema.parse({ metric, value, numerator, denominator, dimensions, currency: null, state: value === null ? "not_applicable" : value === 0 ? "empty" : "observed", valueStatus: metricDaysBetween(input.processingDate, day) >= 2 ? "analyzable" : "provisional" }) });
    }
    const ecpm = values.IMPRESSIONS > 0 ? 1000 * values.ESTIMATED_EARNINGS / values.IMPRESSIONS : null;
    cells.push({ day, row: unifiedMetricRowSchema.parse({ metric: "ad_ecpm", value: ecpm, numerator: values.ESTIMATED_EARNINGS, denominator: values.IMPRESSIONS, dimensions, currency: input.currency, state: ecpm === null ? "not_applicable" : ecpm === 0 ? "empty" : "observed", valueStatus: metricDaysBetween(input.processingDate, day) < 2 ? "provisional" : "estimated" }) });
    return cells;
  });
}
export async function readAdmob(input: { accountId: string; appId: string; timeZone: string; start: string; end: string; processingDate: string; applicationId?: string }, request: AdmobRequest = admobRequest) {
  const account = z.object({ publisherId: z.string(), reportingTimeZone: z.string(), currencyCode: z.string() }).parse(await request(`/accounts/${input.accountId}`));
  if (account.publisherId !== input.accountId || account.reportingTimeZone !== input.timeZone) throw new Error("ADMOB_ACCOUNT_MISMATCH");
  if (!input.applicationId) throw new Error("ADMOB_APP_IDENTITY_MISSING");
  const appSchema = z.object({ appId: z.string(), platform: z.enum(["ANDROID", "IOS"]), linkedAppInfo: z.object({ appStoreId: z.string() }).optional() });
  let app: z.infer<typeof appSchema> | undefined, token: string | undefined;
  const seen = new Set<string>();
  do {
    if (token && seen.has(token)) throw new Error("ADMOB_PAGINATION_INVALID");
    if (token) seen.add(token);
    const page = z.object({ apps: z.array(appSchema).default([]), nextPageToken: z.string().optional() }).parse(await request(`/accounts/${input.accountId}/apps?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`));
    for (const one of page.apps) if (one.appId === input.appId) { if (app) throw new Error("ADMOB_APP_DUPLICATE"); app = one; }
    token = page.nextPageToken;
  } while (token);
  if (!app) throw new Error("ADMOB_APP_IDENTITY_MISSING");
  if (app.appId !== input.appId || app.linkedAppInfo?.appStoreId !== input.applicationId) throw new Error("ADMOB_APP_IDENTITY_MISMATCH");
  const raw = await request(`/accounts/${input.accountId}/networkReport:generate`, { reportSpec: {
    dateRange: { startDate: date(input.start), endDate: date(input.end) },
    dimensions: ["DATE", "APP", "COUNTRY", "FORMAT", "AD_UNIT"], metrics: ["AD_REQUESTS", "MATCHED_REQUESTS", "IMPRESSIONS", "CLICKS", "ESTIMATED_EARNINGS"],
    dimensionFilters: [{ dimension: "APP", matchesAny: { values: [input.appId] } }],
    localizationSettings: { currencyCode: account.currencyCode, languageCode: "en-US" }, maxReportRows: 100000,
  } });
  return { raw, rows: parseAdmobReport(raw, { ...input, currency: account.currencyCode }) };
}
