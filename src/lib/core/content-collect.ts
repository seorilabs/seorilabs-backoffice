import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  resolveGa4Target,
  latestClosedDay,
  dateWindow,
  toTableSuffix,
  isoDate,
  parseIsoDate,
} from "@/lib/ga4/datasets";
import { ga4ContentSource } from "@/lib/ga4/content-source";
import type {
  ContentMetricsSource,
  ContentSourceApp,
  ContentDateWindow,
} from "@/lib/analytics/content-shapes";

// 콘텐츠 세부 지표 수집. 대상 앱마다 최근 N일 콘텐츠 이벤트를 소스에서 조회해 typed
// 모델(레벨/수익화/미션/경제)로 멱등 upsert. 공통 지표 수집(analytics-collect)과 같은
// 야간 크론에서 이어 돈다. 소스는 ContentMetricsSource 포트로 주입 — 지금은 GA4/BigQuery,
// 나중에 자체 지표 서버로 교체해도 이 파일과 스키마·대시보드는 그대로다.
//
// GA4 export 지연 대비로 매일 최근 N일을 재집계한다(지연 도착분 반영). 콘텐츠 이벤트가
// 없는 앱(예: foam-party 외 게임)은 소스가 빈 배열을 반환해 자연히 건너뛴다.

const WINDOW_DAYS = 14;

export interface ContentUpsertCounts {
  levels: number;
  monetization: number;
  missions: number;
  economy: number;
}

export interface ContentCollectResult {
  endDate: string; // 최신 확정일(D-1)
  windowDays: number;
  source: string; // 소스 이름(ga4-bigquery 등)
  targetApps: number; // GA4 대상 앱 수
  upserts: ContentUpsertCounts;
  skipped: string[]; // 매핑 없어 제외된 앱 slug
  errors: { slug: string; error: string }[];
}

export async function collectContentMetrics(
  now: Date,
  opts: { windowDays?: number; source?: ContentMetricsSource } = {},
): Promise<ContentCollectResult> {
  if (!env.ga4Configured()) {
    throw new Error("GA4 미설정 — FEATURE_GA4_ANALYTICS + GA4_SA_KEY_JSON 필요");
  }
  const source = opts.source ?? ga4ContentSource;
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const end = latestClosedDay(now); // D-1 UTC 자정
  const window: ContentDateWindow = {
    start: toTableSuffix(dateWindow(end, windowDays)[0]),
    end: toTableSuffix(end),
  };

  const apps = await prisma.app.findMany({
    select: { id: true, slug: true, firebaseProject: true, ga4Dataset: true },
  });

  const result: ContentCollectResult = {
    endDate: isoDate(end),
    windowDays,
    source: source.name,
    targetApps: 0,
    upserts: { levels: 0, monetization: 0, missions: 0, economy: 0 },
    skipped: [],
    errors: [],
  };

  for (const app of apps) {
    const src: ContentSourceApp = app;
    if (!resolveGa4Target(src)) {
      result.skipped.push(app.slug);
      continue;
    }
    result.targetApps++;
    try {
      const [levels, monetization, missions, economy] = await Promise.all([
        source.queryLevels(src, window),
        source.queryMonetization(src, window),
        source.queryMissions(src, window),
        source.queryEconomy(src, window),
      ]);

      for (const r of levels) {
        const date = parseIsoDate(r.date);
        const data = {
          starts: r.starts,
          completes: r.completes,
          players: r.players,
          avgClearSec: r.avgClearSec,
          avgStars: r.avgStars,
          coinsEarned: r.coinsEarned,
          collectedAt: now,
        };
        await prisma.appLevelMetricDaily.upsert({
          where: {
            appId_date_platform_level: {
              appId: app.id,
              date,
              platform: r.market,
              level: r.level,
            },
          },
          create: { appId: app.id, date, platform: r.market, level: r.level, ...data },
          update: data,
        });
        result.upserts.levels++;
      }

      for (const r of monetization) {
        const date = parseIsoDate(r.date);
        const data = {
          count: r.count,
          users: r.users,
          coinsSpent: r.coinsSpent,
          adCount: r.adCount,
          collectedAt: now,
        };
        await prisma.appMonetizationDaily.upsert({
          where: {
            appId_date_platform_kind_itemKey: {
              appId: app.id,
              date,
              platform: r.market,
              kind: r.kind,
              itemKey: r.itemKey,
            },
          },
          create: {
            appId: app.id,
            date,
            platform: r.market,
            kind: r.kind,
            itemKey: r.itemKey,
            ...data,
          },
          update: data,
        });
        result.upserts.monetization++;
      }

      for (const r of missions) {
        const date = parseIsoDate(r.date);
        const data = {
          claims: r.claims,
          users: r.users,
          rewardCoins: r.rewardCoins,
          collectedAt: now,
        };
        await prisma.appMissionMetricDaily.upsert({
          where: {
            appId_date_platform_missionType: {
              appId: app.id,
              date,
              platform: r.market,
              missionType: r.missionType,
            },
          },
          create: {
            appId: app.id,
            date,
            platform: r.market,
            missionType: r.missionType,
            ...data,
          },
          update: data,
        });
        result.upserts.missions++;
      }

      for (const r of economy) {
        const date = parseIsoDate(r.date);
        const data = {
          coinsFromLevels: r.coinsFromLevels,
          coinsFromMissions: r.coinsFromMissions,
          coinsToUpgrades: r.coinsToUpgrades,
          coinsToSkins: r.coinsToSkins,
          coinsToFoamBombs: r.coinsToFoamBombs,
          foamBombAd: r.foamBombAd,
          foamBombCoin: r.foamBombCoin,
          collectedAt: now,
        };
        await prisma.appEconomyMetricDaily.upsert({
          where: {
            appId_date_platform: { appId: app.id, date, platform: r.market },
          },
          create: { appId: app.id, date, platform: r.market, ...data },
          update: data,
        });
        result.upserts.economy++;
      }
    } catch (e) {
      result.errors.push({ slug: app.slug, error: (e as Error).message.slice(0, 300) });
    }
  }

  return result;
}
