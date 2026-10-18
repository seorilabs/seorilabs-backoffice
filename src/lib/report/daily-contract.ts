import { z } from "zod";
import { metricDayOf, metricDayStart, shiftMetricDay } from "@/lib/analytics/metric-day";
import { providerSeriesSchema } from "@/lib/analytics/report-query";

export const sourceCoverageSchema = z.object({
  appId: z.string(), slug: z.string(), appName: z.string(),
  source: z.string(), reportType: z.string(), account: z.string().nullable(),
  credentialId: z.string().nullable(),
  state: z.enum(["observed", "empty", "not_landed", "partial", "needs_input", "needs_instrumentation", "failed", "not_applicable"]),
  dataThrough: z.string().nullable(),
  reason: z.string(), remedy: z.string(),
  runId: z.string().nullable(), configRevision: z.number().nullable(),
}).strict();
export type SourceCoverage = z.infer<typeof sourceCoverageSchema>;

export const frozenTrendSchema = z.object({
  date: z.string(), ga4Dau: z.number().nullable(), ga4NewUsers: z.number().nullable(),
  adCompletions: z.number().nullable(), dauAndroid: z.number().nullable(),
  dauIos: z.number().nullable(), dauWeb: z.number().nullable(),
  consoleDau: z.number().nullable(), consoleIaaKrw: z.number().nullable(),
  consoleIapTrxKrw: z.number().nullable(),
}).strict();

export const dailyEditionSchema = z.object({
  cutoffAt: z.string().datetime(), dueAt: z.string().datetime(),
  frozenAt: z.string().datetime(), inputHash: z.string(),
  sources: z.array(sourceCoverageSchema), trend: z.array(frozenTrendSchema),
  conclusions: z.array(z.string()).max(3),
  providerMetrics: z.array(providerSeriesSchema).default([]),
  weekly: z.array(z.string()).default([]),
  context: z.array(z.string()).default([]),
  replacesVersion: z.number().int().positive().optional(),
  changes: z.array(z.object({ label: z.string(), before: z.string(), after: z.string() }).strict()).default([]),
  cohorts: z.array(z.object({ appId: z.string(), appName: z.string(), cohortDate: z.string(), users: z.number().int().nonnegative(), values: z.array(z.object({ day: z.number().int(), returned: z.number().nullable(), pct: z.number().nullable() }).strict()) }).strict()).default([]),
  actions: z.array(z.object({
    appName: z.string(), title: z.string(),
    status: z.enum(["registered", "linked", "insufficient", "observing", "excluded", "needs_input"]),
    url: z.string().url().nullable(),
  }).strict()),
}).strict();
export type DailyEdition = z.infer<typeof dailyEditionSchema>;

/** 한국 시각의 10:45/11:00. 날짜 이동도 같은 달력 계약을 쓴다. */
export function dailyReportSchedule(now: Date) {
  const today = metricDayOf(now), start = metricDayStart(today).getTime();
  return {
    refDate: shiftMetricDay(today, -1),
    cutoffAt: new Date(start + (10 * 60 + 45) * 60_000),
    dueAt: new Date(start + 11 * 60 * 60_000),
  };
}

export function publicationState(dueAt: string, publishedAt: string | undefined, corrections = 0) {
  if (!publishedAt) return "발행 대기";
  if (corrections > 0) return "정정";
  return new Date(publishedAt).getTime() < new Date(dueAt).getTime() + 60_000
    ? "정시 발행" : "발행 지연";
}

export function coverageSummary(sources: readonly SourceCoverage[]) {
  const applicable = sources.filter((row) => row.state !== "not_applicable");
  return { expected: applicable.length, observed: applicable.filter((row) => ["observed", "empty"].includes(row.state)).length };
}
