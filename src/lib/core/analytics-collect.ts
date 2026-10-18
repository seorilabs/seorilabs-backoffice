import { beginCollection, completeCollection } from "@/lib/insights/collection";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  lastElapsedMetricDay,
  metricDayWindow,
  metricDaysBetween,
  shiftMetricDay,
  toDbDay,
  toGa4TableSuffix,
} from "@/lib/analytics/metric-day";
import { ga4CoverageTargets } from "@/lib/analytics/targets";
import {
  recordCollectionFailure,
  recordObservations,
  type ObservationInput,
} from "@/lib/analytics/coverage";
import { ga4ObservationState } from "@/lib/analytics/observation";
import {
  queryDailyActivity,
  queryCohortRetention,
  queryDailyBreakdowns,
  queryLandedEventTables,
  type Ga4CohortRow,
} from "@/lib/ga4/bigquery";
import {
  assembleDailyMetric,
  pivotBreakdownRows,
  zeroDailyActivity,
} from "@/lib/ga4/metric-shapes";
import type { Prisma } from "@prisma/client";

// GA4→BigQuery 일별 지표 수집. 대상 앱마다 최근 N일을 쿼리해 AppMetricDaily(공통 지표)로
// 멱등 upsert 한다. GA4 export 지연 대비로 매일 최근 N일을 재집계한다(지연 도착분 + 코호트
// D7 확정 반영). 게임별 컨텐츠 세부 지표는 별도 경로(app-content-metrics-collect, 스펙 구동)가
// 담당한다 — 여기서는 공통 지표만.
//
// 창 길이는 D7 이 정한다. metricDayWindow(end, N) 은 end-(N-1) 부터 end 까지라 코호트의
// 최대 age 가 N-1 이고, clampRetention 은 age>=7 일 때만 d7Pct 를 남긴다. 그래서
// N<=7 이면 d7Pct 가 어느 행에도 기록되지 않는다. 더 나쁘게, 이 수집은 upsert 라
// 창 안의 기존 행에 들어 있던 d7Pct 까지 null 로 덮는다.
//
// 37일 창은 D30 코호트도 7일간 재계산한다. 기존 쿼리 비용 상한은 유지한다.
export const MIN_D7_AGE_DAYS = 7;
export const WINDOW_DAYS = 37;

export interface CollectResult {
  runId: string;
  endDate: string; // 최신 확정일(D-1)
  windowDays: number;
  targetApps: number; // GA4 대상 앱 수
  upserts: number; // 저장된 (앱×날짜) row 수
  observed: number; // 값이 있는 칸
  empty: number; // 테이블은 있는데 활동이 0 인 칸
  notLanded: number; // export 가 아직 오지 않은 칸
  skipped: string[]; // 매핑 없어 제외된 앱 slug
  errors: { slug: string; error: string }[];
}

/**
 * cohort 잔존율을 확정 여부로 clamp. GA4 export 지연/코호트 미성숙으로 아직 확정되지
 * 않은 지표(cohort_day + k > 최신확정일)는 0 이 아니라 null 로 둔다.
 * @param ageDays 최신확정일이 해당 날짜보다 며칠 뒤인지.
 */
export function clampRetention(
  cohort: Pick<Ga4CohortRow, "d1Pct" | "d3Pct" | "d7Pct"> | undefined,
  ageDays: number,
): { d1Pct: number | null; d3Pct: number | null; d7Pct: number | null } {
  if (!cohort) return { d1Pct: null, d3Pct: null, d7Pct: null };
  return {
    d1Pct: ageDays >= 1 ? cohort.d1Pct : null,
    d3Pct: ageDays >= 3 ? cohort.d3Pct : null,
    d7Pct: ageDays >= MIN_D7_AGE_DAYS ? cohort.d7Pct : null,
  };
}

/**
 * 이 실행이 아무것도 수집하지 못했는가(순수).
 *
 * 지금까지 수집 라우트는 전 대상이 실패해도 HTTP 200 {ok:true} 를 돌려줬다.
 * cron 은 `curl -fsS` 로 호출하고 본문을 버리므로 전면 실패가 조용히 지나갔다.
 * 대상이 하나도 없는 경우(설정 미완)도 성공으로 볼 수 없다.
 */
export function collectionFailedEntirely(result: {
  targetApps: number;
  errors: readonly unknown[];
}): boolean {
  return result.targetApps === 0 || result.errors.length === result.targetApps;
}

export async function collectMetrics(
  now: Date,
  opts: { windowDays?: number } = {},
): Promise<CollectResult> {
  if (!env.ga4Configured()) {
    throw new Error("GA4 미설정 — FEATURE_GA4_ANALYTICS + GA4_SA_KEY_JSON 필요");
  }
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const end = lastElapsedMetricDay(now); // D-1(KST 달력일)
  const days = metricDayWindow(end, windowDays);
  const startSuffix = toGa4TableSuffix(days[0]);
  const endSuffix = toGa4TableSuffix(end);

  const { targets, skipped } = await ga4CoverageTargets();

  const run = await beginCollection("ga4", `window:${days[0]}:${end}`);
  const result: CollectResult = {
    runId: run.id,
    endDate: end,
    windowDays,
    targetApps: targets.length,
    upserts: 0,
    observed: 0,
    empty: 0,
    notLanded: 0,
    skipped,
    errors: [],
  };

  for (const target of targets) {
    const attempt = await beginCollection("ga4", `${target.ga4.firebaseProject}.${target.ga4.dataset}`, target.appId);
    try {
      const [landed, activity, cohort, breakdowns] = await Promise.all([
        queryLandedEventTables(target.ga4, startSuffix, endSuffix),
        queryDailyActivity(target.ga4, startSuffix, endSuffix),
        queryCohortRetention(target.ga4, startSuffix, endSuffix),
        queryDailyBreakdowns(target.ga4, startSuffix, endSuffix),
      ]);
      const activityByDate = new Map(activity.map((a) => [a.date, a]));
      const cohortByDate = new Map(cohort.map((c) => [c.date, c]));
      const dimsByDate = pivotBreakdownRows(breakdowns);
      const observations: ObservationInput[] = [];

      // 응답한 날짜만 도는 것이 아니라 창 전체를 돈다. 응답에 없는 날이 활동 0 인지
      // export 미착지인지는 일별 테이블 존재 여부로만 갈린다.
      for (const day of days) {
        const age = metricDaysBetween(end, day);
        const landedDay = landed.has(toGa4TableSuffix(day));
        const row = activityByDate.get(day);
        const state = ga4ObservationState({ tableLanded: landedDay, activityPresent: row !== undefined });
        if (state === "not_landed") {
          observations.push({ source: "ga4", appId: target.appId, day, state });
          result.notLanded++;
          continue;
        }
        const ret = clampRetention(cohortByDate.get(day), age);
        const d1Landed = age >= 1 && landed.has(toGa4TableSuffix(shiftMetricDay(day, 1)));
        if (!d1Landed) ret.d1Pct = null;
        if (age < 3 || !landed.has(toGa4TableSuffix(shiftMetricDay(day, 3)))) ret.d3Pct = null;
        if (age < 7 || !landed.has(toGa4TableSuffix(shiftMetricDay(day, 7)))) ret.d7Pct = null;
        const assembled = assembleDailyMetric(
          row ?? zeroDailyActivity(day),
          ret,
          dimsByDate[day],
        );
        const data = {
          ...assembled,
          cohortUsers: cohortByDate.get(day)?.newUsers ?? null,
          d1Users: d1Landed ? cohortByDate.get(day)?.d1Users ?? null : null,
          ...Object.fromEntries(([3, 7, 14, 30] as const).flatMap((n) => {
            const verified = age >= n && landed.has(toGa4TableSuffix(shiftMetricDay(day, n)));
            const cohortRow = cohortByDate.get(day);
            const returned = verified ? cohortRow?.[`d${n}Users`] ?? null : null;
            const users = cohortRow?.newUsers ?? 0;
            return [[`d${n}Users`, returned], [`d${n}Pct`, returned !== null && users > 0 ? 100 * returned / users : null]];
          })),
          raw: { ...assembled.raw, collection: { runId: attempt.id, periodStart: days[0], periodEnd: end, timeZone: "Asia/Seoul", account: `${target.ga4.firebaseProject}.${target.ga4.dataset}` } } as unknown as Prisma.InputJsonValue,
          collectedAt: now,
        };
        const date = toDbDay(day);
        await prisma.appMetricDaily.upsert({
          where: { appId_date: { appId: target.appId, date } },
          create: { appId: target.appId, date, ...data },
          update: data,
        });
        result.upserts++;
        // 테이블은 있는데 그 앱의 그 날 행이 없다 = 진짜 활동 0. 0 행을 남겨야
        // 기준선이 그 날을 건너뛰지 않는다.
        observations.push({
          source: "ga4",
          appId: target.appId,
          day,
          state,
        });
        if (row) result.observed++;
        else result.empty++;
      }
      await recordObservations(observations, now);
      const valid = observations.filter((row) => ["observed", "empty"].includes(row.state));
      await completeCollection(attempt.id, {
        status: valid.length === observations.length ? "observed" : valid.length ? "partial" : "not_landed",
        ...(valid.length ? { dataThrough: toDbDay(valid.at(-1)!.day) } : {}),
        coverage: { from: days[0], to: end, observed: valid.length, expected: observations.length, account: `${target.ga4.firebaseProject}.${target.ga4.dataset}`, credentialId: "shared/gcp/ga4-fleet-reader" },
      });
    } catch (e) {
      const error = (e as Error).message.slice(0, 300);
      result.errors.push({ slug: target.slug, error });
      await completeCollection(attempt.id, { status: /403|401/.test(error) ? "needs_input" : "failed", errorCode: /403|401/.test(error) ? "SOURCE_PERMISSION_REQUIRED" : "SOURCE_COLLECTION_FAILED" });
      // 실패는 이미 관측된 칸을 덮지 않는다(recordCollectionFailure 가 거른다).
      await recordCollectionFailure(
        days.map((day) => ({ source: "ga4" as const, appId: target.appId, day, detail: error })),
        now,
      );
    }
  }

  await completeCollection(run.id, { status: result.errors.length === result.targetApps ? "failed" : result.errors.length || result.notLanded ? "partial" : "observed", coverage: { from: days[0], to: end, targetApps: targets.length, upserts: result.upserts, notLanded: result.notLanded, errors: result.errors.length } });
  return result;
}
