import { z } from "zod";
import { MAX_DAYS_PER_APP, validateConsoleDay, type ConsoleDailyMetric } from "../console-source";
import { metricDaysBetween, metricDayWindow, parseMetricDay, shiftMetricDay } from "../metric-day";
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
const ZERO_AD = { impression: 0, estimatedEarning: 0 };
const ZERO_PAYMENT = { trxAmount: 0, settlementAmount: 0, pu: 0 };
/**
 * 콘솔은 활동이 없는 날의 광고·결제 행을 응답에서 뺀다. 그래서 응답 자체가 정상이면
 * 행 부재는 그날 활동 0이다. 다만 전날(settledThrough 다음 날)은 새벽 회차에 아직
 * 집계 중일 수 있어 0으로 확정하지 않고 집계 대기(pending)로 둔다. 응답 오류만 missing이다.
 */
export function normalizeConsoleResponses(input: Record<string, unknown>, start: string, end: string, settledThrough = shiftMetricDay(end, -1)) {
  const length = metricDaysBetween(end, start) + 1;
  if (!parseMetricDay(start) || !parseMetricDay(end) || !parseMetricDay(settledThrough) || length < 1 || length > MAX_DAYS_PER_APP) throw new ConsoleSyncError("CONSOLE_WINDOW_INVALID");
  const au = indexRows(input.dau, "au", "dateKey", users, start, end);
  const newAu = indexRows(input.dau, "newAu", "dateKey", users, start, end);
  const session = indexRows(input.session, "metric", "dateKey", value, start, end);
  const android = indexRows(input.android, "dailyReports", "date", ad, start, end);
  const ios = indexRows(input.ios, "dailyReports", "date", ad, start, end);
  const total = indexRows(input.total, "dailyReports", "date", ad, start, end);
  const iap = indexRows(input.iap, "metric", "trxDate", payment, start, end);
  const days: ConsoleDailyMetric[] = []; const missing: { date: string; metrics: string[] }[] = [];
  const pending: { date: string; metrics: string[] }[] = []; const emptyDates: string[] = [];
  for (const date of metricDayWindow(end, length)) {
    const settled = date <= settledThrough;
    const metrics = [!au || !newAu ? "dau" : null, !session ? "session" : null,
      !android ? "iaa.ANDROID" : null, !ios ? "iaa.IOS" : null, !iap ? "iap" : null].filter((v): v is string => v !== null);
    const a = android?.get(date); const i = ios?.get(date); const p = iap?.get(date); const combined = total?.get(date);
    const active = au?.get(date); const fresh = newAu?.get(date); const duration = session?.get(date);
    const absent = settled ? [] : [android && !a ? "iaa.ANDROID" : null, ios && !i ? "iaa.IOS" : null, iap && !p ? "iap" : null].filter((v): v is string => v !== null);
    if (metrics.length) missing.push({ date, metrics });
    if (absent.length) pending.push({ date, metrics: absent });
    if (!a && !i && !p && !active && !fresh && !duration && !combined) {
      if (!metrics.length && !absent.length && total) emptyDates.push(date);
      continue;
    }
    const raw: Row = {};
    if (a || i) raw.iaaByOs = { ...(a ? { ANDROID: { ...a, date } } : {}), ...(i ? { IOS: { ...i, date } } : {}) };
    if (combined) raw.iaaTotal = { ...combined, date };
    if (p) raw.iap = p;
    raw.missingMetrics = metrics;
    raw.pendingMetrics = absent;
    if (date === end) {
      raw.window = { start, end };
      const dau = (input.dau ?? {}) as Row;
      for (const key of ["referrer", "age", "gender", "os", "appVersion"]) if (Array.isArray(dau[key])) raw[key] = dau[key];
    }
    // 확정된 날짜는 응답이 정상인 OS·결제의 행 부재를 0으로 채운다.
    const adOf = (rows: Map<string, Row> | null, row: Row | undefined) => row ?? (settled && rows ? ZERO_AD : undefined);
    const ao = adOf(android, a); const io = adOf(ios, i);
    const adTotal = combined ?? (ao && io ? { impression: (ao.impression as number) + (io.impression as number), estimatedEarning: (ao.estimatedEarning as number) + (io.estimatedEarning as number) } : undefined)
      ?? (settled && total && !a && !i ? ZERO_AD : undefined);
    const pay = p ?? (settled && iap ? ZERO_PAYMENT : undefined);
    const checked = validateConsoleDay({ date, dau: active?.value, newUsers: fresh?.value,
      avgSessionSec: duration?.value, iaaImpressions: adTotal?.impression, iaaEarningKrw: adTotal?.estimatedEarning,
      iapTrxAmountKrw: pay?.trxAmount, iapSettlementKrw: pay?.settlementAmount, payingUsers: pay?.pu, raw });
    if (checked.ok) days.push(checked.day); else missing.push({ date, metrics: checked.fields });
  }
  const invalidResponses = Object.entries({ dau: au && newAu, session, android, ios, total, iap })
    .filter(([key, value]) => input[key] !== undefined && value === null).map(([key]) => key);
  return { days, missing, pending, emptyDates, invalidResponses };
}
