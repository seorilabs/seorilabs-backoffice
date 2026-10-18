import { prisma } from "@/lib/prisma";
import { dbDay, lastElapsedMetricDay, shiftMetricDay, toDbDay, metricDaysBetween } from "@/lib/analytics/metric-day";
import { movementsFromSeries } from "@/lib/core/metric-highlights";
import { providerMetricSeries } from "@/lib/analytics/report-query";
import type { MetricFact } from "./contracts";

/** 등록 정책·재고 검사를 통과한 앱만 호출한다. 기존 임계를 재사용하고 실제 원장 분모로 판단한다. */
export async function issueMetricFacts(appId: string, now: Date): Promise<MetricFact[]> {
  const end = lastElapsedMetricDay(now), start = shiftMetricDay(end, -14), range = { gte: toDbDay(start), lte: toDbDay(end) };
  const [rows, ledger, sourceRun] = await Promise.all([
    prisma.appMetricDaily.findMany({ where: { appId, date: range }, orderBy: { date: "desc" } }),
    prisma.metricCollectionLedger.findMany({ where: { appId, source: "ga4", day: range, sealed: true, state: { in: ["observed", "empty"] } } }),
    prisma.sourceCollectionRun.findFirst({ where: { appId, source: "ga4", status: { in: ["observed", "partial"] } }, orderBy: { startedAt: "desc" } }),
  ]);
  const verified = rows.filter((row) => ledger.some((cell) => dbDay(cell.day) === dbDay(row.date)));
  const movements = sourceRun ? movementsFromSeries(appId, verified, [
    { key: "ga4_dau", pick: (row) => row.dau },
    { key: "ga4_d1", pick: (row) => row.d1Pct, sample: (row) => row.cohortUsers },
    { key: "ga4_ad_completions", pick: (row) => row.adCompletions },
  ]) : [];
  const facts: MetricFact[] = movements.filter((row) => row.verdict === "lowlight" && row.baseline !== null).map((row) => ({ metric: row.metricKey, day: row.date, periodStart: shiftMetricDay(row.date, -7), baseline: row.baseline!, latest: row.latest,
    baselineDays: verified.filter((point) => metricDaysBetween(row.date, dbDay(point.date)) >= 1 && metricDaysBetween(row.date, dbDay(point.date)) <= 7 && (row.metricKey !== "ga4_d1" || point.d1Pct !== null && point.cohortUsers !== null)).length,
    sample: row.sample ?? Math.max(row.latest, row.baseline!), complete: true, mature: true, source: "ga4", scope: appId, runId: sourceRun!.id, direction: "lowlight" }));
  const [consoleRows, consoleLedger, consoleRun] = await Promise.all([
    prisma.appConsoleMetricDaily.findMany({ where: { appId, date: range }, orderBy: { date: "desc" } }),
    prisma.metricCollectionLedger.findMany({ where: { appId, source: "ait_console", day: range, sealed: true, state: { in: ["observed", "empty"] } } }),
    prisma.sourceCollectionRun.findFirst({ where: { appId, source: "ait_console", status: { in: ["observed", "partial"] } }, orderBy: { startedAt: "desc" } }),
  ]);
  for (const miniAppId of new Set(consoleRows.map((row) => row.miniAppId))) {
    const points = consoleRows.filter((row) => row.miniAppId === miniAppId && consoleLedger.some((cell) => cell.listingId === miniAppId && dbDay(cell.day) === dbDay(row.date)));
    for (const movement of movementsFromSeries(appId, points, [{ key: "console_dau", pick: (row) => row.dau }])) {
      if (movement.verdict !== "lowlight" || movement.baseline === null || !consoleRun) continue;
      facts.push({ metric: "console_dau", day: movement.date, periodStart: shiftMetricDay(movement.date, -7), baseline: movement.baseline, latest: movement.latest, baselineDays: points.filter((row) => row.dau !== null && metricDaysBetween(movement.date, dbDay(row.date)) >= 1 && metricDaysBetween(movement.date, dbDay(row.date)) <= 7).length, sample: Math.max(movement.latest, movement.baseline), complete: true, mature: true, source: "console", scope: `${appId}:${miniAppId}`, runId: consoleRun.id, direction: "lowlight" });
    }
  }
  for (const series of await providerMetricSeries(end, prisma, appId)) {
    if (series.verdict !== "lowlight") continue;
    const current = series.points.find((point) => point.day === series.assessmentDay);
    if (!current) continue;
    const baseline = series.points.filter((point) => point.value !== null && point.valueStatus !== "provisional" && ["observed", "empty"].includes(point.state) && metricDaysBetween(current.day, point.day) >= 1 && metricDaysBetween(current.day, point.day) <= 7);
    const sorted = baseline.map((point) => point.value!).sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    if (!sorted.length || current.value === null) continue;
    facts.push({ metric: series.metric, day: current.day, periodStart: shiftMetricDay(current.day, -7), baseline: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, latest: current.value, baselineDays: baseline.length, sample: current.denominator ?? Math.max(current.value, ...sorted), complete: ["observed", "empty"].includes(current.state), mature: current.valueStatus !== "provisional", source: series.source, scope: `${appId}:${series.account}:${series.resource}:${series.timeZone}:${series.currency ?? "count"}:${series.reportType}:${series.segment}`, runId: current.runId, direction: "lowlight" });
  }
  return facts;
}
