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
import { foamGa4ContentSource } from "@/lib/ga4/foam-content-source";
import type {
  FoamContentSource,
  ContentSourceApp,
  ContentDateWindow,
} from "@/lib/analytics/foam-content-shapes";

// 콘텐츠 세부 지표 수집. 대상 앱마다 최근 N일 콘텐츠 이벤트를 소스에서 조회해 typed
// 모델(레벨/수익화/미션/경제)로 멱등 upsert. 공통 지표 수집(analytics-collect)과 같은
// 야간 크론에서 이어 돈다. 소스는 FoamContentSource 포트로 주입 — 지금은 GA4/BigQuery,
// 나중에 자체 지표 서버로 교체해도 이 파일과 스키마·대시보드는 그대로다.
//
// GA4 export 지연 대비로 매일 최근 N일을 재집계한다(지연 도착분 반영). 콘텐츠 이벤트가
// 없는 앱(예: foam-party 외 게임)은 소스가 빈 배열을 반환해 자연히 건너뛴다.

const WINDOW_DAYS = 14;

// 이 수집기가 담당하는 앱 slug(foam-party 콘텐츠 이벤트 카탈로그 채택 앱).
const FOAM_CONTENT_SLUGS = ["foam-party"];

// DB 쓰기 동시성 상한. 레벨 많은 앱은 (레벨×시장×일)로 수천 행이 될 수 있어 건별 순차
// await 는 크론 maxDuration(300s)을 위협한다. 커넥션 풀을 넘지 않는 선에서 병렬화한다.
const WRITE_CONCURRENCY = 8;

// items 를 최대 limit 개씩 동시에 처리하고 완료 수를 반환. 하나라도 reject 하면 그대로
// 전파(앱 단위 try/catch 가 errors 로 수집). 순서 무관(멱등 upsert).
async function runPooled<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<number> {
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
      done++;
    }
  });
  await Promise.all(workers);
  return done;
}

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

export async function collectFoamContentMetrics(
  now: Date,
  opts: { windowDays?: number; source?: FoamContentSource } = {},
): Promise<ContentCollectResult> {
  if (!env.ga4Configured()) {
    throw new Error("GA4 미설정 — FEATURE_GA4_ANALYTICS + GA4_SA_KEY_JSON 필요");
  }
  const source = opts.source ?? foamGa4ContentSource;
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const end = latestClosedDay(now); // D-1 UTC 자정
  const window: ContentDateWindow = {
    start: toTableSuffix(dateWindow(end, windowDays)[0]),
    end: toTableSuffix(end),
  };

  // 이 콘텐츠 이벤트(level_*/skin_*/daily_mission_claim/foam_bomb_use)는 foam-party
  // 전용이라 그 앱만 조회한다(다른 게임은 이벤트가 없어 빈 결과 — 스캔 낭비 방지).
  // 레벨형 게임이 같은 카탈로그를 채택하면 여기에 slug 를 추가하면 자동 편입된다.
  const apps = await prisma.app.findMany({
    where: { slug: { in: FOAM_CONTENT_SLUGS } },
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

      // 조회는 병렬(Promise.all)이었고, 쓰기도 모델별로 동시성 상한 내에서 병렬화한다.
      result.upserts.levels += await runPooled(levels, WRITE_CONCURRENCY, async (r) => {
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
      });

      result.upserts.monetization += await runPooled(monetization, WRITE_CONCURRENCY, async (r) => {
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
      });

      result.upserts.missions += await runPooled(missions, WRITE_CONCURRENCY, async (r) => {
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
      });

      result.upserts.economy += await runPooled(economy, WRITE_CONCURRENCY, async (r) => {
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
      });
    } catch (e) {
      result.errors.push({ slug: app.slug, error: (e as Error).message.slice(0, 300) });
    }
  }

  return result;
}
