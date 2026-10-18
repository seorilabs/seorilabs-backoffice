import { z } from "zod";
import { MAX_DAYS_PER_APP, validateConsoleDay, type ConsoleDailyMetric } from "../console-source";
import { metricDaysBetween, metricDayWindow, parseMetricDay } from "../metric-day";
import { ConsoleSyncError } from "./oauth";

const count = z.number().finite().int().nonnegative();
const value = z.object({ value: z.number().finite().nonnegative() }).passthrough();
const users = z.object({ value: count }).passthrough();
const ad = z.object({ impression: count, estimatedEarning: z.number().finite() }).passthrough();
const payment = z.object({ trxAmount: z.number().finite(), settlementAmount: z.number().finite(), pu: count }).passthrough();
type Row = Record<string, unknown>;
function dateOf(input: unknown): string | null {
  if (typeof input === "string") return parseMetricDay(input);
  if (!Array.isArray(input) || input.length !== 3 || !input.every(Number.isInteger)) return null;
  return parseMetricDay(input.map((v, i) => String(v).padStart(i === 0 ? 4 : 2, "0")).join("-"));
}
function indexRows(response: unknown, arrayKey: string, dateKey: string, schema: z.ZodTypeAny, start: string, end: string) {
  const outer = z.record(z.unknown()).safeParse(response);
  if (!outer.success || !Array.isArray(outer.data[arrayKey])) return null;
  const rows = new Map<string, Row>();
  for (const input of outer.data[arrayKey] as unknown[]) {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return null;
    const row = parsed.data as Row; const date = dateOf(row[dateKey]);
    if (!date || date < start || date > end || rows.has(date)) return null;
    rows.set(date, row);
  }
  return rows;
}
export function normalizeConsoleResponses(input: Record<string, unknown>, start: string, end: string) {
  const length = metricDaysBetween(end, start) + 1;
  if (!parseMetricDay(start) || !parseMetricDay(end) || length < 1 || length > MAX_DAYS_PER_APP) throw new ConsoleSyncError("CONSOLE_WINDOW_INVALID");
  const au = indexRows(input.dau, "au", "dateKey", users, start, end);
  const newAu = indexRows(input.dau, "newAu", "dateKey", users, start, end);
  const session = indexRows(input.session, "metric", "dateKey", value, start, end);
  const android = indexRows(input.android, "dailyReports", "date", ad, start, end);
  const ios = indexRows(input.ios, "dailyReports", "date", ad, start, end);
  const iap = indexRows(input.iap, "metric", "trxDate", payment, start, end);
  const days: ConsoleDailyMetric[] = []; const missing: { date: string; metrics: string[] }[] = [];
  for (const date of metricDayWindow(end, length)) {
    const metrics = [!au || !newAu ? "dau" : null, !session ? "session" : null,
      !android?.has(date) ? "iaa.ANDROID" : null, !ios?.has(date) ? "iaa.IOS" : null, !iap?.has(date) ? "iap" : null].filter((v): v is string => v !== null);
    if (metrics.length) missing.push({ date, metrics });
    const a = android?.get(date); const i = ios?.get(date); const p = iap?.get(date);
    const active = au?.get(date); const fresh = newAu?.get(date); const duration = session?.get(date);
    if (!a && !i && !p && !active && !fresh && !duration) continue;
    const raw: Row = {};
    if (a || i) raw.iaaByOs = { ...(a ? { ANDROID: { ...a, date } } : {}), ...(i ? { IOS: { ...i, date } } : {}) };
    if (p) raw.iap = p;
    raw.missingMetrics = metrics;
    if (date === end) {
      raw.window = { start, end };
      const dau = (input.dau ?? {}) as Row;
      for (const key of ["referrer", "age", "gender", "os", "appVersion"]) if (Array.isArray(dau[key])) raw[key] = dau[key];
    }
    const checked = validateConsoleDay({ date, dau: active?.value, newUsers: fresh?.value,
      avgSessionSec: duration?.value, iaaImpressions: a && i ? (a.impression as number) + (i.impression as number) : undefined,
      iaaEarningKrw: a && i ? (a.estimatedEarning as number) + (i.estimatedEarning as number) : undefined,
      iapTrxAmountKrw: p?.trxAmount, iapSettlementKrw: p?.settlementAmount, payingUsers: p?.pu, raw });
    if (checked.ok) days.push(checked.day); else missing.push({ date, metrics: checked.fields });
  }
  return { days, missing };
}
