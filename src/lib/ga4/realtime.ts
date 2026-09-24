import { BetaAnalyticsDataClient } from "@google-analytics/data";

import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { env } from "@/lib/env";
import { ga4ServiceAccountCredentials } from "@/lib/ga4/credentials";
import { resolveGa4Target } from "@/lib/ga4/datasets";
import { prisma } from "@/lib/prisma";

// GA4 Data API runRealtimeReport로 앱별 최근 활성 사용자를 읽는다.
// RPI Edge presence를 대체하기 위한 경로다(ADR 0028). 사람 수 기준이며
// 표준 속성은 최근 30분까지만 조회된다.
//
// 호출 한도는 속성·프로젝트당 시간 14,000 토큰이고 요청 하나는 대개 10 토큰
// 이하다. 보는 사람이 여럿이어도 속성당 분당 한 번만 호출하도록 서버 메모리에
// 60초 캐시한다. 서버 오류도 속성당 시간 10회 한도가 있어 실패도 같이 캐시한다.

export const REALTIME_RECENT_MINUTES = 5;
export const REALTIME_WINDOW_MINUTES = 30;
export const REALTIME_CACHE_TTL_MS = 60_000;

const RECENT_RANGE = "recent";
const WINDOW_RANGE = "window";

export interface Ga4RealtimeVersionRow {
  platform: string;
  appVersion: string;
  activeUsers: number;
}

export interface Ga4RealtimeAppCounts {
  recentActiveUsers: number;
  windowActiveUsers: number;
  /** 최근 30분 platform × appVersion 분포. 행끼리 합하면 한 사람이 중복될 수 있다. */
  versions: Ga4RealtimeVersionRow[];
}

export type Ga4RealtimeAppResult =
  | ({ ok: true; slug: string; displayName: string } & Ga4RealtimeAppCounts)
  | { ok: false; slug: string; displayName: string; error: string };

export interface Ga4RealtimeSnapshot {
  measuredAt: string;
  recentMinutes: number;
  windowMinutes: number;
  /** 성공한 앱만 합한다. 실패한 앱은 0이 아니라 알 수 없음이다. */
  totalRecentActiveUsers: number;
  totalWindowActiveUsers: number;
  apps: Ga4RealtimeAppResult[];
}

/** GA4 export 데이터셋 이름 "analytics_<propertyId>"에서 속성 ID를 꺼낸다. */
export function propertyIdFromDataset(dataset: string): string | null {
  const match = /^analytics_(\d+)$/.exec(dataset.trim());
  return match ? match[1] : null;
}

// Data API 응답 중 이 모듈이 읽는 부분만 좁게 정의한다. 라이브러리 타입은
// 모든 필드가 optional·nullable이라 순수 함수 테스트에 쓰기 번거롭다.
export interface RealtimeResponseLike {
  dimensionHeaders?: ReadonlyArray<{ name?: string | null }> | null;
  rows?: ReadonlyArray<{
    dimensionValues?: ReadonlyArray<{ value?: string | null }> | null;
    metricValues?: ReadonlyArray<{ value?: string | null }> | null;
  }> | null;
}

function metricValue(value: string | null | undefined): number {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

/**
 * 차원 없이 두 minuteRange를 보낸 응답을 해석한다. range가 둘 이상이면 GA4가
 * dateRange 차원을 붙여 range 이름을 돌려준다. 행이 없으면 활성 사용자 0이다.
 */
export function parseRealtimeTotals(
  response: RealtimeResponseLike,
): Pick<Ga4RealtimeAppCounts, "recentActiveUsers" | "windowActiveUsers"> {
  const headers = response.dimensionHeaders?.map((header) => header.name) ?? [];
  const rangeIndex = headers.indexOf("dateRange");
  const totals = { recentActiveUsers: 0, windowActiveUsers: 0 };
  for (const row of response.rows ?? []) {
    const range = rangeIndex >= 0 ? row.dimensionValues?.[rangeIndex]?.value : null;
    const users = metricValue(row.metricValues?.[0]?.value);
    if (range === RECENT_RANGE) totals.recentActiveUsers = users;
    if (range === WINDOW_RANGE) totals.windowActiveUsers = users;
  }
  return totals;
}

/** platform × appVersion 응답을 사용자 수 내림차순 행으로 바꾼다. */
export function parseRealtimeVersions(
  response: RealtimeResponseLike,
): Ga4RealtimeVersionRow[] {
  const headers = response.dimensionHeaders?.map((header) => header.name) ?? [];
  const platformIndex = headers.indexOf("platform");
  const versionIndex = headers.indexOf("appVersion");
  return (response.rows ?? [])
    .map((row) => ({
      platform: row.dimensionValues?.[platformIndex]?.value ?? "",
      appVersion: row.dimensionValues?.[versionIndex]?.value ?? "",
      activeUsers: metricValue(row.metricValues?.[0]?.value),
    }))
    .filter((row) => row.activeUsers > 0)
    .sort(
      (left, right) =>
        right.activeUsers - left.activeUsers ||
        left.platform.localeCompare(right.platform) ||
        left.appVersion.localeCompare(right.appVersion),
    );
}

export function buildGa4RealtimeSnapshot(
  now: Date,
  apps: readonly Ga4RealtimeAppResult[],
): Ga4RealtimeSnapshot {
  const ok = apps.filter((app) => app.ok);
  const sorted = [...apps].sort((left, right) => {
    // 실패한 앱을 위로 올려 "알 수 없음"이 목록 끝에 묻히지 않게 한다.
    if (left.ok !== right.ok) return left.ok ? 1 : -1;
    const leftUsers = left.ok ? left.windowActiveUsers : 0;
    const rightUsers = right.ok ? right.windowActiveUsers : 0;
    return rightUsers - leftUsers || left.displayName.localeCompare(right.displayName, "ko");
  });
  return {
    measuredAt: now.toISOString(),
    recentMinutes: REALTIME_RECENT_MINUTES,
    windowMinutes: REALTIME_WINDOW_MINUTES,
    totalRecentActiveUsers: ok.reduce((sum, app) => sum + app.recentActiveUsers, 0),
    totalWindowActiveUsers: ok.reduce((sum, app) => sum + app.windowActiveUsers, 0),
    apps: sorted,
  };
}

/** 캐시 유효 여부. 순수 함수로 두어 시간 경계를 단위 검증한다. */
export function isRealtimeCacheFresh(cachedAt: number, now: number): boolean {
  return now - cachedAt < REALTIME_CACHE_TTL_MS;
}

let client: BetaAnalyticsDataClient | null = null;

function dataClient(): BetaAnalyticsDataClient {
  client ??= new BetaAnalyticsDataClient({ credentials: ga4ServiceAccountCredentials() });
  return client;
}

async function fetchAppCounts(propertyId: string): Promise<Ga4RealtimeAppCounts> {
  const property = `properties/${propertyId}`;
  const analytics = dataClient();
  // 총합과 분포를 따로 조회한다. 분포 행을 더하면 버전을 바꾼 사람이
  // 두 번 세어지므로, 총합은 차원 없는 요청에서 GA4가 중복을 제거한 값을 쓴다.
  const [[totals], [versions]] = await Promise.all([
    analytics.runRealtimeReport({
      property,
      metrics: [{ name: "activeUsers" }],
      minuteRanges: [
        { name: RECENT_RANGE, startMinutesAgo: REALTIME_RECENT_MINUTES - 1, endMinutesAgo: 0 },
        { name: WINDOW_RANGE, startMinutesAgo: REALTIME_WINDOW_MINUTES - 1, endMinutesAgo: 0 },
      ],
    }),
    analytics.runRealtimeReport({
      property,
      dimensions: [{ name: "platform" }, { name: "appVersion" }],
      metrics: [{ name: "activeUsers" }],
    }),
  ]);
  return { ...parseRealtimeTotals(totals), versions: parseRealtimeVersions(versions) };
}

interface RealtimeTarget {
  slug: string;
  displayName: string;
  propertyId: string;
}

const cache = new Map<string, { cachedAt: number; result: Ga4RealtimeAppResult }>();

async function loadAppResult(target: RealtimeTarget, now: number): Promise<Ga4RealtimeAppResult> {
  const cached = cache.get(target.propertyId);
  if (cached && isRealtimeCacheFresh(cached.cachedAt, now)) {
    return { ...cached.result, slug: target.slug, displayName: target.displayName };
  }
  let result: Ga4RealtimeAppResult;
  try {
    const counts = await fetchAppCounts(target.propertyId);
    result = { ok: true, slug: target.slug, displayName: target.displayName, ...counts };
  } catch (caught) {
    // 권한 미부여(PERMISSION_DENIED)가 가장 흔하다. 원인을 화면에서 바로 보이게 남긴다.
    const message = caught instanceof Error ? caught.message : String(caught);
    result = {
      ok: false,
      slug: target.slug,
      displayName: target.displayName,
      error: `GA4 실시간 조회 실패: ${message.slice(0, 200)}`,
    };
  }
  cache.set(target.propertyId, { cachedAt: now, result });
  return result;
}

/**
 * GA4 export가 연결된 표시 대상 앱 전체의 실시간 활성 사용자를 읽는다.
 * 앱별 실패는 결과 안에 남기고, GA4 설정 자체가 없을 때만 예외를 던진다.
 */
export async function loadGa4RealtimeSnapshot(now = new Date()): Promise<Ga4RealtimeSnapshot> {
  if (!env.ga4Configured()) {
    throw new Error("GA4 조회가 설정되지 않았습니다(FEATURE_GA4_ANALYTICS·GA4_SA_KEY_JSON).");
  }
  const apps = await prisma.app.findMany({
    where: visibleAppWhere,
    select: { slug: true, displayName: true, firebaseProject: true, ga4Dataset: true },
  });
  const targets: RealtimeTarget[] = [];
  for (const app of apps) {
    const target = resolveGa4Target(app);
    const propertyId = target ? propertyIdFromDataset(target.dataset) : null;
    if (propertyId) targets.push({ slug: app.slug, displayName: app.displayName, propertyId });
  }
  const results = await Promise.all(
    targets.map((target) => loadAppResult(target, now.getTime())),
  );
  return buildGa4RealtimeSnapshot(now, results);
}
