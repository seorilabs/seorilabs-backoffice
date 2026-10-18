import { z } from "zod";

export const consoleMetricFields = ["dau", "newUsers", "avgSessionSec", "iaaImpressions", "iaaEarningKrw", "iapTrxAmountKrw", "iapSettlementKrw", "payingUsers"] as const;
export const consoleFinancialFields = ["iaaImpressions", "iaaEarningKrw", "iapTrxAmountKrw", "iapSettlementKrw", "payingUsers"] as const;
const ad = z.object({ date: z.string(), impression: z.number().finite().int().nonnegative(), estimatedEarning: z.number().finite() }).passthrough();
const object = (value: unknown): Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** 빠진 구획과 OS는 기존 원본을 지우지 않는다. */
export function mergeConsoleRaw(previous: unknown, incoming: unknown): Record<string, unknown> {
  const merged = new Map(Object.entries(object(previous)));
  for (const [key, value] of Object.entries(object(incoming))) {
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
  const byOs = object(object(raw).iaaByOs);
  const android = ad.safeParse(byOs.ANDROID); const ios = ad.safeParse(byOs.IOS);
  if (!android.success || !ios.success || android.data.date !== date || ios.data.date !== date) return null;
  return { iaaImpressions: android.data.impression + ios.data.impression, iaaEarningKrw: android.data.estimatedEarning + ios.data.estimatedEarning };
}

/** 관측된 값만 합산하며 전부 미확인이면 null을 유지한다. */
export function sumConsoleValues(values: readonly (number | null | undefined)[]): number | null {
  const known = values.filter((value): value is number => value != null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}
