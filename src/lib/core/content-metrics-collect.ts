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
import { contentSpecFor } from "@/lib/analytics/content-registry";
import { ga4ContentSource } from "@/lib/ga4/content-metrics";
import type { AppContentSpec } from "@/lib/analytics/content-spec";
import type { ContentMetricsSource, ContentMetricSnapshot } from "@/lib/analytics/content-source";
import type { Ga4Target } from "@/lib/ga4/datasets";
import type { Prisma } from "@prisma/client";

// 앱 컨텐츠 세부 지표 수집. 컨텐츠 스펙이 등록된 앱마다 최근 N일을 소스에서 집계해
// AppContentMetricDaily 로 멱등 upsert 한다. 소스는 ContentMetricsSource 포트 주입이라
// 지금은 GA4/BigQuery, 향후 자체 지표 서버로 이 파일 밖에서 교체된다.
// GA4 export 지연 대비로 매일 최근 N일을 재집계한다(지연 도착분 반영, 하루 딜레이 허용).

const WINDOW_DAYS = 3;

export interface ContentCollectResult {
  endDate: string; // 최신 확정일(D-1)
  windowDays: number;
  targetApps: number; // 컨텐츠 스펙 + GA4 대상 모두 갖춘 앱 수
  upserts: number; // 저장된 (앱×날짜) row 수
  skipped: string[]; // 컨텐츠 스펙 없음/GA4 매핑 없음으로 제외된 앱 slug
  errors: { slug: string; error: string }[];
}

export interface ContentCollectAppRow {
  id: string;
  slug: string;
  firebaseProject: string | null;
  ga4Dataset: string | null;
}

export interface ContentCollectTarget {
  app: { id: string; slug: string };
  target: Ga4Target;
  spec: AppContentSpec;
}

/**
 * 수집 대상 분류(순수). 컨텐츠 스펙이 등록되고 GA4 대상이 해석되는 앱만 target 으로,
 * 나머지는 skipped 로 나눈다. 스펙 없는 앱은 컨텐츠 지표 수집에서 빠지고 공통 지표
 * 수집에는 영향을 주지 않는다.
 */
export function classifyContentTargets(apps: ContentCollectAppRow[]): {
  targets: ContentCollectTarget[];
  skipped: string[];
} {
  const targets: ContentCollectTarget[] = [];
  const skipped: string[] = [];
  for (const app of apps) {
    const spec = contentSpecFor(app.slug);
    const target = resolveGa4Target(app);
    if (!spec || !target) {
      skipped.push(app.slug);
      continue;
    }
    targets.push({ app: { id: app.id, slug: app.slug }, target, spec });
  }
  return { targets, skipped };
}

/** 스냅샷 → AppContentMetricDaily upsert 페이로드(순수, collectedAt 제외 필드 잠금). */
export function buildContentUpsert(
  snapshot: ContentMetricSnapshot,
  now: Date,
): { totalEvents: number; raw: Prisma.InputJsonValue; collectedAt: Date } {
  return {
    totalEvents: snapshot.totalEvents,
    raw: snapshot as unknown as Prisma.InputJsonValue,
    collectedAt: now,
  };
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
  const endSuffix = toTableSuffix(end);
  const startSuffix = toTableSuffix(dateWindow(end, windowDays)[0]);

  const apps = await prisma.app.findMany({
    select: { id: true, slug: true, firebaseProject: true, ga4Dataset: true },
  });
  const { targets, skipped } = classifyContentTargets(apps);

  const result: ContentCollectResult = {
    endDate: isoDate(end),
    windowDays,
    targetApps: targets.length,
    upserts: 0,
    skipped,
    errors: [],
  };

  for (const { app, target, spec } of targets) {
    try {
      const byDate = await source.queryContentMetrics(
        { slug: app.slug, firebaseProject: target.firebaseProject, dataset: target.dataset },
        spec,
        startSuffix,
        endSuffix,
      );
      for (const [dateStr, snapshot] of Object.entries(byDate)) {
        const date = parseIsoDate(dateStr);
        const data = buildContentUpsert(snapshot, now);
        await prisma.appContentMetricDaily.upsert({
          where: { appId_date: { appId: app.id, date } },
          create: { appId: app.id, date, ...data },
          update: data,
        });
        result.upserts++;
      }
    } catch (e) {
      result.errors.push({ slug: app.slug, error: (e as Error).message.slice(0, 300) });
    }
  }

  return result;
}
