import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { queryLandedEventTables } from "@/lib/ga4/bigquery";
import {
  dbDay,
  lastElapsedMetricDay,
  metricDayWindow,
  metricDaysBetween,
  toDbDay,
  toGa4TableSuffix,
} from "@/lib/analytics/metric-day";
import {
  recordObservations,
  type MetricObservationState,
  type ObservationInput,
} from "@/lib/analytics/coverage";
import { missingDayState } from "@/lib/analytics/observation";
import { consoleCoverageTargets, ga4CoverageTargets } from "@/lib/analytics/targets";

// 원장이 생기기 전 기간을 채운다.
//
// 과거를 추측해 지어내지 않는다. 지금 시점에 진실로 알 수 있는 것만 쓴다.
//   - 일별 테이블이 지금 있고 지표 행도 있다  → observed
//   - 일별 테이블은 있는데 지표 행이 없다     → empty (그 날 활동이 0 이었다)
//   - 일별 테이블이 지금도 없다               → not_landed
// landedAt 은 채우지 않는다. 언제 착지했는지는 소급할 수 없고, 지어낸 시각으로
// 발행 시각을 정하면 그 결정의 근거가 거짓이 된다.
//
// 콘솔에는 "테이블"이 없다. push 가 들어온 날만 행이 있으므로 행 유무로만 가른다.

export interface LedgerBackfillResult {
  endDate: string;
  windowDays: number;
  ga4: { targets: number; cells: number; observed: number; empty: number; notLanded: number };
  console: { targets: number; cells: number; observed: number; notLanded: number };
  errors: { slug: string; error: string }[];
}

export async function backfillMetricLedger(
  now: Date,
  opts: { windowDays: number },
): Promise<LedgerBackfillResult> {
  if (!env.ga4Configured()) {
    throw new Error("GA4 미설정 — FEATURE_GA4_ANALYTICS + GA4_SA_KEY_JSON 필요");
  }
  const end = lastElapsedMetricDay(now);
  const days = metricDayWindow(end, opts.windowDays);
  const range = { gte: toDbDay(days[0]), lte: toDbDay(end) };

  const result: LedgerBackfillResult = {
    endDate: end,
    windowDays: opts.windowDays,
    ga4: { targets: 0, cells: 0, observed: 0, empty: 0, notLanded: 0 },
    console: { targets: 0, cells: 0, observed: 0, notLanded: 0 },
    errors: [],
  };

  const ga4 = await ga4CoverageTargets();
  result.ga4.targets = ga4.targets.length;
  for (const target of ga4.targets) {
    try {
      const [landed, rows] = await Promise.all([
        queryLandedEventTables(target.ga4, toGa4TableSuffix(days[0]), toGa4TableSuffix(end)),
        prisma.appMetricDaily.findMany({
          where: { appId: target.appId, date: range },
          select: { date: true },
        }),
      ]);
      const stored = new Set(rows.map((row) => dbDay(row.date)));
      const latestLandedDay = days.filter((day) => landed.has(toGa4TableSuffix(day))).at(-1) ?? null;
      const observations: ObservationInput[] = days.map((day) => {
        const state: MetricObservationState = stored.has(day)
          ? "observed"
          : landed.has(toGa4TableSuffix(day))
            ? "empty"
            : missingDayState({
              ageDays: metricDaysBetween(end, day),
              latestLandedDay,
              day,
            });
        if (state === "observed") result.ga4.observed += 1;
        else if (state === "empty") result.ga4.empty += 1;
        else result.ga4.notLanded += 1;
        return { source: "ga4", appId: target.appId, day, state };
      });
      result.ga4.cells += await recordObservations(observations, now);
    } catch (e) {
      result.errors.push({ slug: target.slug, error: (e as Error).message.slice(0, 300) });
    }
  }

  const console_ = await consoleCoverageTargets();
  result.console.targets = console_.targets.length;
  for (const target of console_.targets) {
    const rows = await prisma.appConsoleMetricDaily.findMany({
      where: { appId: target.appId, miniAppId: target.listingId, date: range },
      select: { date: true },
    });
    const stored = new Set(rows.map((row) => dbDay(row.date)));
    const observations: ObservationInput[] = days.map((day) => {
      const state: MetricObservationState = stored.has(day) ? "observed" : "not_landed";
      if (state === "observed") result.console.observed += 1;
      else result.console.notLanded += 1;
      return {
        source: "ait_console" as const,
        appId: target.appId,
        listingId: target.listingId,
        day,
        state,
      };
    });
    result.console.cells += await recordObservations(observations, now);
  }

  return result;
}
