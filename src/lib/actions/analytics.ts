"use server";

import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { requireSession } from "@/lib/auth-helpers";
import {
  resolveGa4Target,
  latestClosedDay,
  dateWindow,
  toTableSuffix,
  isoDate,
} from "@/lib/ga4/datasets";
import { queryAdProbe } from "@/lib/ga4/bigquery";

// /settings 의 "광고/수익 지표 진단" 버튼. 각 GA4 대상 앱에서 ad_impression 이벤트와
// 노출수준 수익(value) export 여부를 실데이터로 확인한다. 상시 수집이 아닌 일회성 프로브.

const PROBE_WINDOW_DAYS = 14;

export interface AdProbeAppResult {
  slug: string;
  displayName: string;
  /** ad_impression 이벤트가 하나라도 있으면 true. */
  hasAdImpression: boolean;
  /** value(수익)가 채워진 노출이 있으면 true → AdMob 노출수준 수익 export 동작. */
  hasRevenue: boolean;
  adImpressions: number;
  rewardedImpressions: number;
  impressionsWithValue: number;
  estRevenue: number;
  currencies: string | null;
  broadAdEvents: number;
  error?: string;
}

export interface AdProbeResult {
  endDate: string;
  windowDays: number;
  /** GA4 자격증명/피처플래그 설정 여부. false 면 BigQuery 조회는 생략된다. */
  ga4Configured: boolean;
  apps: AdProbeAppResult[];
  skipped: string[];
}

// GA4 미설정 앱의 기본 결과 스켈레톤(모든 카운트 0).
function unconfiguredApp(
  app: { slug: string; displayName: string },
  error: string,
): AdProbeAppResult {
  return {
    slug: app.slug,
    displayName: app.displayName,
    hasAdImpression: false,
    hasRevenue: false,
    adImpressions: 0,
    rewardedImpressions: 0,
    impressionsWithValue: 0,
    estRevenue: 0,
    currencies: null,
    broadAdEvents: 0,
    error,
  };
}

export async function adRevenueProbe(): Promise<AdProbeResult> {
  await requireSession();

  const end = latestClosedDay(new Date());
  const endSuffix = toTableSuffix(end);
  const startSuffix = toTableSuffix(dateWindow(end, PROBE_WINDOW_DAYS)[0]);
  const configured = env.ga4Configured();

  const apps = await prisma.app.findMany({
    orderBy: { displayName: "asc" },
    select: { slug: true, displayName: true, firebaseProject: true, ga4Dataset: true },
  });

  const result: AdProbeResult = {
    endDate: isoDate(end),
    windowDays: PROBE_WINDOW_DAYS,
    ga4Configured: configured,
    apps: [],
    skipped: [],
  };

  // GA4 미설정이어도 매핑 누락 앱 목록/전체 앱 상태는 노출한다(부분 결과). BigQuery만 생략.
  for (const app of apps) {
    const target = resolveGa4Target(app);
    if (!target) {
      result.skipped.push(app.slug);
      continue;
    }
    if (!configured) {
      result.apps.push(
        unconfiguredApp(app, "GA4 미설정 — FEATURE_GA4_ANALYTICS + GA4_SA_KEY_JSON 필요"),
      );
      continue;
    }
    try {
      const p = await queryAdProbe(target, startSuffix, endSuffix);
      result.apps.push({
        slug: app.slug,
        displayName: app.displayName,
        hasAdImpression: p.adImpressions > 0,
        hasRevenue: p.impressionsWithValue > 0,
        adImpressions: p.adImpressions,
        rewardedImpressions: p.rewardedImpressions,
        impressionsWithValue: p.impressionsWithValue,
        estRevenue: p.estRevenue,
        currencies: p.currencies,
        broadAdEvents: p.broadAdEvents,
      });
    } catch (e) {
      result.apps.push({
        slug: app.slug,
        displayName: app.displayName,
        hasAdImpression: false,
        hasRevenue: false,
        adImpressions: 0,
        rewardedImpressions: 0,
        impressionsWithValue: 0,
        estRevenue: 0,
        currencies: null,
        broadAdEvents: 0,
        error: (e as Error).message.slice(0, 300),
      });
    }
  }

  return result;
}
