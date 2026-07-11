import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  resolveGa4Target,
  latestClosedDay,
  dateWindow,
  toTableSuffix,
  isoDate,
  parseIsoDate,
  daysBetween,
} from "@/lib/ga4/datasets";
import {
  queryDailyActivity,
  queryCohortRetention,
  queryDailyBreakdowns,
  type Ga4CohortRow,
} from "@/lib/ga4/bigquery";
import { pivotBreakdownRows, assembleDailyMetric } from "@/lib/ga4/metric-shapes";
import { collectCrosswordGameMetrics } from "@/lib/core/crossword-game-metrics";
import type { Prisma } from "@prisma/client";

// 게임 세부 지표 모듈이 붙는 앱들. 공통 지표(AppMetricDaily) 수집 뒤, 해당 앱만 게임 전용
// 수집을 추가로 돌린다. 게임이 늘면 이 표에 (slug → 수집 함수)만 추가하면 된다.
const GAME_METRIC_COLLECTORS: Record<
  string,
  (params: {
    appId: string;
    target: import("@/lib/ga4/datasets").Ga4Target;
    startSuffix: string;
    endSuffix: string;
    now: Date;
  }) => Promise<number>
> = {
  "crossword-puzzle": collectCrosswordGameMetrics,
};

// GA4→BigQuery 일별 지표 수집. 대상 앱마다 최근 N일을 쿼리해 AppMetricDaily 로 멱등 upsert.
// GA4 export 지연 대비로 매일 최근 N일을 재집계한다(지연 도착분 + 코호트 D7 확정 반영).

const WINDOW_DAYS = 14;

export interface CollectResult {
  endDate: string; // 최신 확정일(D-1)
  windowDays: number;
  targetApps: number; // GA4 대상 앱 수
  upserts: number; // 저장된 (앱×날짜) row 수
  gameUpserts: number; // 게임 세부 지표로 저장된 (앱×날짜×마켓) row 수
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
    d7Pct: ageDays >= 7 ? cohort.d7Pct : null,
  };
}

export async function collectMetrics(
  now: Date,
  opts: { windowDays?: number } = {},
): Promise<CollectResult> {
  if (!env.ga4Configured()) {
    throw new Error("GA4 미설정 — FEATURE_GA4_ANALYTICS + GA4_SA_KEY_JSON 필요");
  }
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const end = latestClosedDay(now); // D-1 UTC 자정
  const endSuffix = toTableSuffix(end);
  const startSuffix = toTableSuffix(dateWindow(end, windowDays)[0]);

  const apps = await prisma.app.findMany({
    select: { id: true, slug: true, firebaseProject: true, ga4Dataset: true },
  });

  const result: CollectResult = {
    endDate: isoDate(end),
    windowDays,
    targetApps: 0,
    upserts: 0,
    gameUpserts: 0,
    skipped: [],
    errors: [],
  };

  for (const app of apps) {
    const target = resolveGa4Target(app);
    if (!target) {
      result.skipped.push(app.slug);
      continue;
    }
    result.targetApps++;
    try {
      const [activity, cohort, breakdowns] = await Promise.all([
        queryDailyActivity(target, startSuffix, endSuffix),
        queryCohortRetention(target, startSuffix, endSuffix),
        queryDailyBreakdowns(target, startSuffix, endSuffix),
      ]);
      const cohortByDate = new Map(cohort.map((c) => [c.date, c]));
      const dimsByDate = pivotBreakdownRows(breakdowns);

      for (const a of activity) {
        const date = parseIsoDate(a.date);
        const age = daysBetween(end, date);
        const ret = clampRetention(cohortByDate.get(a.date), age);
        const assembled = assembleDailyMetric(a, ret, dimsByDate[a.date]);
        const data = {
          ...assembled,
          raw: assembled.raw as unknown as Prisma.InputJsonValue,
          collectedAt: now,
        };
        await prisma.appMetricDaily.upsert({
          where: { appId_date: { appId: app.id, date } },
          create: { appId: app.id, date, ...data },
          update: data,
        });
        result.upserts++;
      }
    } catch (e) {
      result.errors.push({
        slug: app.slug,
        error: (e as Error).message.slice(0, 300),
      });
    }

    // 게임 세부 지표(해당 앱만). 공통 지표와 독립적으로 실패 격리한다 — 게임 쿼리 실패가
    // 공통 지표 수집을 되돌리지 않게 별도 try/catch.
    const gameCollector = GAME_METRIC_COLLECTORS[app.slug];
    if (gameCollector) {
      try {
        result.gameUpserts += await gameCollector({
          appId: app.id,
          target,
          startSuffix,
          endSuffix,
          now,
        });
      } catch (e) {
        result.errors.push({
          slug: `${app.slug}:game`,
          error: (e as Error).message.slice(0, 300),
        });
      }
    }
  }

  return result;
}
