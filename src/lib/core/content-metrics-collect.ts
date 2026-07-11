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
import { CONTENT_METRICS_APPS } from "@/lib/ga4/content-apps";
import {
  defaultContentMetricsSource,
  type ContentMetricsSource,
} from "@/lib/ga4/content-source";

// happy-farm 콘텐츠 세부 지표 수집. 콘텐츠 지표 대상 앱(content-apps 레지스트리)마다
// 최근 N일을 소스(GA4 BigQuery)에서 집계해 happy_farm_* 스냅샷으로 멱등 upsert.
// GA4 export 지연 대비로 매일 최근 N일을 재집계한다(공통 수집기와 동일 원칙).
// 대상 앱만 처리하므로 다른 게임 수집 작업과 데이터가 겹치지 않는다.

const WINDOW_DAYS = 14;

export interface ContentCollectResult {
  endDate: string; // 최신 확정일(D-1)
  windowDays: number;
  targetApps: number; // 콘텐츠 지표 대상 앱 수
  upserts: { crops: number; areas: number; funnels: number; adPlacements: number };
  skipped: string[]; // 레지스트리엔 있으나 GA4 대상/DB 매핑 없어 제외된 slug
  errors: { slug: string; error: string }[];
}

export async function collectContentMetrics(
  now: Date,
  opts: { windowDays?: number; source?: ContentMetricsSource } = {},
): Promise<ContentCollectResult> {
  if (!env.ga4Configured()) {
    throw new Error("GA4 미설정 — FEATURE_GA4_ANALYTICS + GA4_SA_KEY_JSON 필요");
  }
  const source = opts.source ?? defaultContentMetricsSource;
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const end = latestClosedDay(now);
  const endSuffix = toTableSuffix(end);
  const startSuffix = toTableSuffix(dateWindow(end, windowDays)[0]);

  const slugs = CONTENT_METRICS_APPS.map((a) => a.slug);
  const apps = await prisma.app.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, slug: true, firebaseProject: true, ga4Dataset: true },
  });

  const result: ContentCollectResult = {
    endDate: isoDate(end),
    windowDays,
    targetApps: 0,
    upserts: { crops: 0, areas: 0, funnels: 0, adPlacements: 0 },
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
      const rows = await source.fetchContentMetrics(target, startSuffix, endSuffix);

      for (const r of rows.crops) {
        const date = parseIsoDate(r.date);
        const data = {
          planted: r.planted,
          ready: r.ready,
          harvested: r.harvested,
          seedSelected: r.seedSelected,
          firstHarvests: r.firstHarvests,
          cotdHarvests: r.cotdHarvests,
          harvesters: r.harvesters,
          revenue: r.revenue,
          collectedAt: now,
        };
        await prisma.happyFarmCropDaily.upsert({
          where: { appId_date_crop: { appId: app.id, date, crop: r.crop } },
          create: { appId: app.id, date, crop: r.crop, ...data },
          update: data,
        });
        result.upserts.crops++;
      }

      for (const r of rows.areas) {
        const date = parseIsoDate(r.date);
        const data = {
          unlockClicked: r.unlockClicked,
          unlocked: r.unlocked,
          planted: r.planted,
          harvested: r.harvested,
          unlockCostSum: r.unlockCostSum,
          collectedAt: now,
        };
        await prisma.happyFarmAreaDaily.upsert({
          where: { appId_date_area: { appId: app.id, date, area: r.area } },
          create: { appId: app.id, date, area: r.area, ...data },
          update: data,
        });
        result.upserts.areas++;
      }

      for (const r of rows.funnels) {
        const date = parseIsoDate(r.date);
        const data = {
          count: r.count,
          users: r.users,
          skips: r.skips,
          stalls: r.stalls,
          collectedAt: now,
        };
        await prisma.happyFarmFunnelDaily.upsert({
          where: {
            appId_date_funnel_step: { appId: app.id, date, funnel: r.funnel, step: r.step },
          },
          create: { appId: app.id, date, funnel: r.funnel, step: r.step, ...data },
          update: data,
        });
        result.upserts.funnels++;
      }

      for (const r of rows.adPlacements) {
        const date = parseIsoDate(r.date);
        const data = {
          impressions: r.impressions,
          clicks: r.clicks,
          completes: r.completes,
          fails: r.fails,
          failsNotReady: r.failsNotReady,
          blocked: r.blocked,
          collectedAt: now,
        };
        await prisma.happyFarmAdPlacementDaily.upsert({
          where: { appId_date_placement: { appId: app.id, date, placement: r.placement } },
          create: { appId: app.id, date, placement: r.placement, ...data },
          update: data,
        });
        result.upserts.adPlacements++;
      }
    } catch (e) {
      result.errors.push({ slug: app.slug, error: (e as Error).message.slice(0, 300) });
    }
  }

  return result;
}
