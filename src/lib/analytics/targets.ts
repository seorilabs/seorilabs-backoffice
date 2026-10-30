import { activeGa4ConfigSelect } from "@/lib/ga4/config";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { resolveGa4Target, type Ga4Target } from "@/lib/ga4/datasets";
import { listingsForSlug, resolveAitTarget } from "@/lib/analytics/ait-apps";
import type { MetricSource } from "@/lib/analytics/observation";

// 지표 수집·합산 대상의 단일 해석기.
//
// 전에는 같은 질문("무엇을 세는가")에 네 곳이 따로 답했다. analytics-collect 는
// 필터 없이 전체 앱을 돌았고, 보고 경로들은 visibleAppWhere 로 걸렀으며, 콘솔 ingest 는
// ACTIVE 만 받았다. 그래서 수집한 집합과 보고한 집합이 달랐고, DEPRECATED 앱에는
// 아무도 읽지 않는 행이 계속 쌓였다. 분모가 흔들리는 원인 중 하나였다.
//
// 여기서 한 번 정하고 수집기·보고기·원장 백필이 모두 이것만 쓴다.

export interface CoverageTarget {
  source: MetricSource;
  appId: string;
  slug: string;
  displayName: string;
  /** 콘솔 리스팅 id. GA4 는 앱 단위라 0. */
  listingId: number;
  /** 표시·로그 키. GA4 는 slug, 콘솔은 "slug#miniAppId". */
  targetKey: string;
  /** 다중 리스팅 앱에서만 채운다(단일 리스팅은 앱명과 중복이라 생략). */
  listingLabel: string | null;
}

export interface CoverageTargets<T> {
  targets: T[];
  /** 대상 밖으로 빠진 앱 slug. 조용히 사라지면 분모가 줄어든 것을 아무도 모른다. */
  skipped: string[];
}

/** GA4 수집·합산 대상. 비활성 앱은 빼고, 데이터셋이 해석되는 앱만 센다. */
export async function ga4CoverageTargets(db: Prisma.TransactionClient = prisma): Promise<
  CoverageTargets<CoverageTarget & { ga4: Ga4Target }>
> {
  const apps = await db.app.findMany({
    where: visibleAppWhere,
    orderBy: { displayName: "asc" },
    select: {
      id: true,
      slug: true,
      displayName: true,
      firebaseProject: true,
      ga4Dataset: true, configRevisions: activeGa4ConfigSelect,
    },
  });
  const skipped: string[] = [];
  const targets = apps.flatMap((app) => {
    const ga4 = resolveGa4Target(app);
    if (!ga4) {
      skipped.push(app.slug);
      return [];
    }
    return [{
      source: "ga4" as const,
      appId: app.id,
      slug: app.slug,
      displayName: app.displayName,
      listingId: 0,
      targetKey: app.slug,
      listingLabel: null,
      ga4,
    }];
  });
  return { targets, skipped };
}

/**
 * 콘솔 수집·합산 대상. 앱 하나가 리스팅 여럿일 수 있어(crossword-puzzle 웹+네이티브)
 * 리스팅 단위로 편다. 리스팅 표에 없으면 primary 하나로 대체한다.
 */
export async function consoleCoverageTargets(db: Prisma.TransactionClient = prisma): Promise<CoverageTargets<CoverageTarget>> {
  const apps = await db.app.findMany({
    where: visibleAppWhere,
    orderBy: { displayName: "asc" },
    select: {
      id: true,
      slug: true,
      displayName: true,
      aitWorkspaceId: true,
      aitMiniAppId: true,
    },
  });
  const skipped: string[] = [];
  const targets = apps.flatMap((app) => {
    const target = resolveAitTarget(app);
    if (!target) {
      skipped.push(app.slug);
      return [];
    }
    const listings = listingsForSlug(app.slug);
    const rows = listings.length > 0
      ? listings.map((listing) => ({
        miniAppId: listing.miniAppId,
        label: listings.length > 1 ? listing.label : null,
      }))
      : [{ miniAppId: target.miniAppId, label: null }];
    return rows.map((row) => ({
      source: "ait_console" as const,
      appId: app.id,
      slug: app.slug,
      displayName: app.displayName,
      listingId: row.miniAppId,
      targetKey: `${app.slug}#${row.miniAppId}`,
      listingLabel: row.label,
    }));
  });
  return { targets, skipped };
}

/** 잘못된 요청은 조회와 수집 원장을 만들기 전에 거절한다. */
export class InvalidAnalyticsTarget extends Error {}
export function filterGa4Targets<T extends { appId: string }>(targets: T[], appId?: string): T[] {
  if (appId === undefined) return targets;
  const selected = targets.filter(target => target.appId === appId);
  if (!appId.trim() || selected.length === 0) throw new InvalidAnalyticsTarget("수집 가능한 앱이 아닙니다.");
  return selected;
}
