import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { queryLandedEventTables } from "@/lib/ga4/bigquery";
import { dbDay, toDbDay, toGa4TableSuffix } from "@/lib/analytics/metric-day";
import { recordLanding } from "@/lib/analytics/coverage";
import { ga4CoverageTargets } from "@/lib/analytics/targets";

// GA4 export 착지 시각 실측.
//
// 발행 시각을 언제로 둘지는 "D-1 이 언제쯤 다 오는가"에 달렸는데, 지금까지 관측
// 지점이 하루 한두 개뿐이라 그 분포를 아무도 몰랐다. 실측상 전체 DAU 의 66% 를
// 차지하는 앱이 29일 중 26일 아침 수집을 놓쳤고, 그중 저녁에 관측된 날은 이틀뿐이다.
// 나머지는 (10h, 34h] 구간 어딘가일 뿐이다.
//
// 이 프로브는 지표를 수집하지 않는다. 아직 착지하지 않은 칸이 있는 앱에만
// INFORMATION_SCHEMA 를 물어 "테이블이 생겼다"는 사실과 그 시각만 남긴다.
// 착지한 뒤에는 그 앱에 쿼리가 발생하지 않으므로 비용이 스스로 줄어든다.

/** 이보다 오래된 미착지 칸은 더 보지 않는다. 그쯤이면 지연이 아니라 결손이다. */
export const PROBE_MAX_AGE_DAYS = 3;

export interface LandingProbeResult {
  /** 미착지 칸이 남아 조회한 앱 수. 0 이면 전부 착지했다는 뜻이다. */
  probedApps: number;
  pendingCells: number;
  /** 이번 실행에서 처음 착지를 확인한 칸 수. */
  landed: number;
  errors: { slug: string; error: string }[];
}

export async function probeLandings(now: Date): Promise<LandingProbeResult> {
  if (!env.ga4Configured()) {
    throw new Error("GA4 미설정 — FEATURE_GA4_ANALYTICS + GA4_SA_KEY_JSON 필요");
  }
  const { targets } = await ga4CoverageTargets();
  const floor = new Date(now.getTime() - PROBE_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000);

  const pending = await prisma.metricCollectionLedger.findMany({
    where: {
      source: "ga4",
      state: "not_landed",
      landedAt: null,
      day: { gte: toDbDay(dbDay(floor)) },
    },
    select: { appId: true, day: true },
  });

  const result: LandingProbeResult = {
    probedApps: 0,
    pendingCells: pending.length,
    landed: 0,
    errors: [],
  };
  if (pending.length === 0) return result;

  const daysByApp = new Map<string, string[]>();
  for (const cell of pending) {
    const days = daysByApp.get(cell.appId) ?? [];
    days.push(dbDay(cell.day));
    daysByApp.set(cell.appId, days);
  }

  for (const target of targets) {
    const days = daysByApp.get(target.appId);
    if (!days || days.length === 0) continue;
    days.sort();
    result.probedApps += 1;
    try {
      const landed = await queryLandedEventTables(
        target.ga4,
        toGa4TableSuffix(days[0]),
        toGa4TableSuffix(days[days.length - 1]),
      );
      for (const day of days) {
        if (!landed.has(toGa4TableSuffix(day))) continue;
        const first = await recordLanding({
          source: "ga4",
          appId: target.appId,
          day,
          now,
        });
        if (first) result.landed += 1;
      }
    } catch (e) {
      result.errors.push({ slug: target.slug, error: (e as Error).message.slice(0, 300) });
    }
  }
  return result;
}
