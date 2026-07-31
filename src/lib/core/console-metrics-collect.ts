import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type {
  ConsoleMetricsPush,
  ConsoleAppPush,
  ConsoleDailyMetric,
} from "@/lib/analytics/console-source";
import { AIT_LISTINGS } from "@/lib/analytics/ait-apps";

// AppsInToss 콘솔 지표 ingest(push 수집). 인증된 로컬 Claude 세션이 MCP dashboard_* 를 조회해
// 정규화한 push 페이로드를 받아 AppConsoleMetricDaily(리스팅×날짜)로 멱등 upsert 한다.
// GA4 수집(analytics-collect)과 대칭: 소스만 다르고(BigQuery pull ↔ MCP push) 저장 규약은 동일.
// App 해석은 slug 우선(항상 존재), 없으면 miniAppId. 저장 키는 (appId, miniAppId, date) — 한 App 이
// 콘솔에 여러 미니앱으로 등록될 수 있어 miniAppId 로 리스팅을 분리한다(필수). 매핑 실패/miniAppId
// 누락/유효하지 않은 날짜는 개별 skip/error 로 담고 나머지 수집은 계속한다(부분 실패 격리).

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS_PER_APP = 120; // 한 리스팅 push 당 날짜 상한(폭주 방지)

// miniAppId → App.slug (코드 표 기반 역해석). slug 미제공 push 를 App 으로 잇는 보조 경로.
const SLUG_BY_MINIAPP = new Map(AIT_LISTINGS.map((l) => [l.miniAppId, l.appSlug]));

export interface ConsoleIngestResult {
  targetApps: number; // 해석에 성공해 수집된 앱 수
  upserts: number; // 저장된 (앱×날짜) row 수
  skipped: { key: string; reason: string }[]; // 매핑/유효성 실패로 제외
  errors: { key: string; error: string }[]; // upsert 중 예외
}

/** "YYYY-MM-DD"(UTC 자정) Date 로 파싱. @db.Date 저장/비교용. */
function parseIsoDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** dau/newUsers 전용: 유한 수면 그 값(0 포함), 아니면 null(=콘솔 미집계). 0 으로 채우지 않는다. */
function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function pushKey(p: ConsoleAppPush): string {
  const base = p.slug ?? (p.miniAppId != null ? `miniApp:${p.miniAppId}` : "unknown");
  return p.miniAppId != null ? `${base}#${p.miniAppId}` : base;
}

/**
 * push 페이로드를 검증·해석해 upsert 한다.
 * @param payload ingest route 가 받은 raw body(외부 입력이므로 방어적으로 검증).
 * @param now collectedAt 기준 시각.
 */
export async function ingestConsoleMetrics(
  payload: unknown,
  now: Date,
): Promise<ConsoleIngestResult> {
  const result: ConsoleIngestResult = {
    targetApps: 0,
    upserts: 0,
    skipped: [],
    errors: [],
  };

  const apps = (payload as ConsoleMetricsPush | null)?.apps;
  if (!Array.isArray(apps) || apps.length === 0) {
    throw new Error("잘못된 페이로드 — { apps: ConsoleAppPush[] } 필요");
  }

  // App 해석 인덱스(slug / aitMiniAppId). 한 번만 로드.
  const registry = await prisma.app.findMany({
    select: { id: true, slug: true, aitMiniAppId: true },
  });
  const bySlug = new Map(registry.map((a) => [a.slug, a]));
  const byMiniApp = new Map(
    registry.filter((a) => a.aitMiniAppId != null).map((a) => [a.aitMiniAppId as number, a]),
  );

  for (const push of apps) {
    const key = pushKey(push);
    // miniAppId 는 리스팅 키(필수). slug 미제공 시 miniAppId→slug 코드표로 App 을 잇는다.
    const resolvedSlug = push.slug ?? (push.miniAppId != null ? SLUG_BY_MINIAPP.get(push.miniAppId) : undefined);
    const app =
      (resolvedSlug ? bySlug.get(resolvedSlug) : undefined) ??
      (push.miniAppId != null ? byMiniApp.get(push.miniAppId) : undefined);
    if (!app) {
      result.skipped.push({ key, reason: "App 매핑 없음(slug/miniAppId 불일치)" });
      continue;
    }
    if (push.miniAppId == null) {
      result.skipped.push({ key, reason: "miniAppId 누락(리스팅 키 필수)" });
      continue;
    }
    const miniAppId = push.miniAppId;
    if (!Array.isArray(push.days) || push.days.length === 0) {
      result.skipped.push({ key, reason: "days 비어있음" });
      continue;
    }
    if (push.days.length > MAX_DAYS_PER_APP) {
      result.skipped.push({ key, reason: `days 초과(${push.days.length} > ${MAX_DAYS_PER_APP})` });
      continue;
    }

    result.targetApps++;
    for (const day of push.days as ConsoleDailyMetric[]) {
      if (!day || typeof day.date !== "string" || !ISO_DATE.test(day.date)) {
        result.errors.push({ key, error: `잘못된 date: ${day?.date}` });
        continue;
      }
      const date = parseIsoDate(day.date);
      const data = {
        // dau/newUsers 는 null 허용(콘솔 미집계). 0 강제하지 않는다.
        dau: intOrNull(day.dau),
        newUsers: intOrNull(day.newUsers),
        avgSessionSec:
          day.avgSessionSec == null ? null : num(day.avgSessionSec, 0),
        iaaImpressions: num(day.iaaImpressions),
        iaaEarningKrw: num(day.iaaEarningKrw),
        iapTrxAmountKrw: num(day.iapTrxAmountKrw),
        iapSettlementKrw: num(day.iapSettlementKrw),
        payingUsers: num(day.payingUsers),
        raw: (day.raw ?? Prisma.JsonNull) as Prisma.InputJsonValue | typeof Prisma.JsonNull,
        collectedAt: now,
      };
      try {
        await prisma.appConsoleMetricDaily.upsert({
          where: { appId_miniAppId_date: { appId: app.id, miniAppId, date } },
          create: { appId: app.id, miniAppId, date, ...data },
          update: data,
        });
        result.upserts++;
      } catch (e) {
        result.errors.push({ key: `${key}@${day.date}`, error: (e as Error).message.slice(0, 300) });
      }
    }
  }

  return result;
}

// ── 동기화 상태 조회(온디맨드 수집 윈도우 판정용) ──────────────────────────
// 콘솔 수집은 cron 이 아닌 온디맨드(대화형 Claude 세션)라 마지막 동기화가 오래됐을 수 있다.
// 수집 커맨드가 "어디부터 당길지"를 정하려면 앱별 마지막 저장 날짜가 필요하다. ingest 는 POST
// 전용이라 읽기 경로가 없어, 같은 라우트에 token 보호 GET 을 두고 이 헬퍼로 상태를 반환한다.

/** 대상 리스팅 1개(App×miniApp)의 콘솔 지표 동기화 상태. */
export interface ConsoleSyncStatusApp {
  /** backoffice App.slug(= repo name). 한 slug 에 리스팅이 여럿일 수 있다. */
  slug: string;
  /** 콘솔 miniAppId(= 리스팅 키). */
  miniAppId: number | null;
  /** 리스팅 라벨(같은 slug 내 구분: "웹"/"네이티브 게임" 등). */
  label?: string;
  /** 저장된 마지막 지표 기준일 "YYYY-MM-DD"(없으면 null → 백필 필요). */
  lastDate: string | null;
  /** 마지막 수집 시각 ISO(없으면 null). */
  lastCollectedAt: string | null;
  /** 저장된 (리스팅×날짜) row 수. */
  rows: number;
}

/** 콘솔 지표 수집 대상 리스팅 전체의 동기화 상태 스냅샷. */
export interface ConsoleSyncStatus {
  /** 대상 리스팅별 상태(한 App 의 여러 리스팅이 각각 한 항목). */
  apps: ConsoleSyncStatusApp[];
  /** 데이터가 있는 리스팅들의 lastDate 중 가장 이른 값 — 증분 윈도우 시작 판단용(없으면 null). */
  minLastDate: string | null;
  /** 데이터가 있는 리스팅들의 lastDate 중 가장 늦은 값(없으면 null). */
  maxLastDate: string | null;
  /** 저장 row 가 전혀 없는 대상 리스팅 "slug#miniAppId" — 신규 등록 등, 별도 백필 필요. */
  appsWithNoData: string[];
}

function toIsoDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * 콘솔 지표 수집 대상 리스팅(코드 표 ∪ DB aitMiniAppId 설정 앱)별 마지막 동기화 상태를 반환한다.
 * 한 App 이 여러 콘솔 미니앱으로 등록될 수 있어 리스팅(App×miniApp) 단위로 낸다.
 * 수집 커맨드가 이 값을 읽어 증분 윈도우([minLastDate−overlap, D-1])와 백필 대상을 정한다.
 */
export async function getConsoleSyncStatus(): Promise<ConsoleSyncStatus> {
  const grouped = await prisma.appConsoleMetricDaily.groupBy({
    by: ["appId", "miniAppId"],
    _max: { date: true, collectedAt: true },
    _count: { _all: true },
  });
  const registry = await prisma.app.findMany({
    select: { id: true, slug: true, aitMiniAppId: true },
  });

  const bySlug = new Map(registry.map((a) => [a.slug, a]));
  const groupByListing = new Map(grouped.map((g) => [`${g.appId}:${g.miniAppId}`, g]));

  // 대상 리스팅 = 코드 표 ∪ DB(aitMiniAppId 설정됐으나 표에 없는 앱의 primary).
  type Target = { slug: string; miniAppId: number; label?: string };
  const targets: Target[] = AIT_LISTINGS.map((l) => ({
    slug: l.appSlug,
    miniAppId: l.miniAppId,
    label: l.label,
  }));
  const known = new Set(AIT_LISTINGS.map((l) => `${l.appSlug}:${l.miniAppId}`));
  for (const a of registry) {
    if (a.aitMiniAppId != null && !known.has(`${a.slug}:${a.aitMiniAppId}`)) {
      targets.push({ slug: a.slug, miniAppId: a.aitMiniAppId });
    }
  }

  const apps: ConsoleSyncStatusApp[] = targets
    .sort((x, y) => x.slug.localeCompare(y.slug) || x.miniAppId - y.miniAppId)
    .map((t) => {
      const app = bySlug.get(t.slug);
      const g = app ? groupByListing.get(`${app.id}:${t.miniAppId}`) : undefined;
      return {
        slug: t.slug,
        miniAppId: t.miniAppId,
        label: t.label,
        lastDate: toIsoDate(g?._max.date ?? null),
        lastCollectedAt: g?._max.collectedAt ? g._max.collectedAt.toISOString() : null,
        rows: g?._count._all ?? 0,
      };
    });

  const withData = apps.filter((a) => a.lastDate != null).map((a) => a.lastDate!);
  return {
    apps,
    minLastDate: withData.length ? withData.reduce((m, d) => (d < m ? d : m)) : null,
    maxLastDate: withData.length ? withData.reduce((m, d) => (d > m ? d : m)) : null,
    appsWithNoData: apps.filter((a) => a.rows === 0).map((a) => `${a.slug}#${a.miniAppId}`),
  };
}
