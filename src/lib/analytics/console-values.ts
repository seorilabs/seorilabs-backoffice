import { z } from "zod";

export const consoleMetricFields = ["dau", "newUsers", "avgSessionSec", "iaaImpressions", "iaaEarningKrw", "iapTrxAmountKrw", "iapSettlementKrw", "payingUsers"] as const;
export const consoleFinancialFields = ["iaaImpressions", "iaaEarningKrw", "iapTrxAmountKrw", "iapSettlementKrw", "payingUsers"] as const;
const ad = z.object({ date: z.string(), impression: z.number().finite().int().nonnegative(), estimatedEarning: z.number().finite() }).passthrough();
const object = (value: unknown): Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** 빠진 구획과 OS는 기존 원본을 지우지 않는다. */
export function mergeConsoleRaw(previous: unknown, incoming: unknown): Record<string, unknown> {
  const merged = new Map(Object.entries(object(previous)));
  const next = object(incoming);
  const oldWindow = object(merged.get("window")); const nextWindow = object(next.window);
  if (next.window != null && (nextWindow.start !== oldWindow.start || nextWindow.end !== oldWindow.end)) {
    for (const key of ["referrer", "age", "gender", "os", "appVersion", "retention"]) merged.delete(key);
  }
  for (const [key, value] of Object.entries(next)) {
    if (value == null) continue;
    merged.set(key, key === "iaaByOs" ? { ...object(merged.get(key)), ...Object.fromEntries(Object.entries(object(value)).filter(([, row]) => row != null)) } : value);
  }
  return Object.fromEntries(merged);
}

export function hasConsoleAdObservation(raw: unknown, date: string): boolean {
  return Object.values(object(object(raw).iaaByOs)).some((value) => {
    const row = ad.safeParse(value);
    return row.success && row.data.date === date;
  });
}

/** 같은 날짜의 두 OS가 확인된 경우에만 합계를 만든다. */
export function consoleAdTotal(raw: unknown, date: string) {
  const total = ad.safeParse(object(raw).iaaTotal);
  if (total.success && total.data.date === date) return { iaaImpressions: total.data.impression, iaaEarningKrw: total.data.estimatedEarning };
  const byOs = object(object(raw).iaaByOs);
  const android = ad.safeParse(byOs.ANDROID); const ios = ad.safeParse(byOs.IOS);
  if (!android.success || !ios.success || android.data.date !== date || ios.data.date !== date) return null;
  return { iaaImpressions: android.data.impression + ios.data.impression, iaaEarningKrw: android.data.estimatedEarning + ios.data.estimatedEarning };
}

/** 합계 확인과 별도로 실제 OS별 관측이 있는 지표만 반환한다. */
export function consoleCoveredAdMetrics(raw: unknown, date: string): string[] {
  const byOs = object(object(raw).iaaByOs);
  return ["ANDROID", "IOS"].filter((os) => {
    const row = ad.safeParse(byOs[os]); return row.success && row.data.date === date;
  }).map((os) => `iaa.${os}`);
}

/** 하나라도 미확인이면 부분 합계를 완전한 합계로 표시하지 않는다. */
export function sumConsoleValues(values: readonly (number | null | undefined)[]): number | null {
  if (!values.length || values.some((value) => value == null)) return null;
  const known = values.filter((value): value is number => value != null);
  return known.reduce((sum, value) => sum + value, 0);
}

/** 수집과 과거 원장 복구가 같은 완료 기준을 쓴다. */
export function isCompleteConsoleMetric(row: Partial<Record<typeof consoleFinancialFields[number], number | null>> & { raw?: unknown }): boolean {
  const missing = object(row.raw).missingMetrics;
  return consoleFinancialFields.every((field) => row[field] != null) && (!Array.isArray(missing) || missing.length === 0);
}
