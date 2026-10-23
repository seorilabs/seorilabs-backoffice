import type { AppConsoleMetricDaily } from "@prisma/client";
import type { ConsoleDailyMetric } from "../console-source";
import { consoleMetricFields } from "../console-values";
import { prisma } from "@/lib/prisma";
import { toDbDay } from "../metric-day";

type StoredRow = Pick<AppConsoleMetricDaily, typeof consoleMetricFields[number] | "date" | "collectedAt" | "raw">;
function sameNumber(actual: unknown, expected: number): boolean {
  if (actual === expected) return true;
  // DOUBLE을 JSON 숫자로 읽을 때 생기는 끝자리 오차만 허용한다. 0 근처의 실제 값도 보존한다.
  return typeof actual === "number" && Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual - expected) <= 4 * Number.EPSILON * Math.max(Math.abs(actual), Math.abs(expected));
}
function contains(actual: unknown, expected: unknown): boolean {
  if (expected == null) return true;
  if (typeof expected === "number") return sameNumber(actual, expected);
  if (typeof expected !== "object") return actual === expected;
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) => contains((actual as Record<string, unknown>)[key], value));
}

/** 최신 날짜와 별도로, 이번 입력의 날짜, 제공된 값과 저장 시각을 직접 대조한다. */
export function verifyConsoleRows(days: ConsoleDailyMetric[], rows: StoredRow[], capturedAt: Date) {
  const byDay = new Map(rows.map((row) => [row.date.toISOString().slice(0, 10), row]));
  const mismatched = days.filter((day) => {
    const row = byDay.get(day.date);
    return !row || row.collectedAt < capturedAt
      || consoleMetricFields.some((key) => day[key] != null && !sameNumber(row[key], day[key]))
      || !contains(row.raw && typeof row.raw === "object" && !Array.isArray(row.raw) ? row.raw.iaaByOs : null, day.raw?.iaaByOs);
  }).map((day) => day.date);
  return { expected: days.length, verified: days.length - mismatched.length, mismatched };
}

export async function verifyStoredConsoleDays(appId: string, miniAppId: number, days: ConsoleDailyMetric[], now: Date) {
  const rows = await prisma.appConsoleMetricDaily.findMany({
    where: { appId, miniAppId, date: { in: days.map((day) => toDbDay(day.date)) } },
  });
  return verifyConsoleRows(days, rows, now);
}
