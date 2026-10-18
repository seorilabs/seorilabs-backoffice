import { prisma } from "@/lib/prisma";
import { Prisma, type AppStatus } from "@prisma/client";
import type {
  ConsoleMetricsPush,
  ConsoleAppPush,
  ConsoleDailyMetric,
} from "@/lib/analytics/console-source";
import { MAX_DAYS_PER_APP, validateConsoleDay } from "@/lib/analytics/console-source";
import { consoleMetricFields, consoleFinancialFields, mergeConsoleRaw, consoleAdTotal, hasConsoleAdObservation } from "@/lib/analytics/console-values";
import { retryPrismaConflict } from "@/lib/prisma-conflict";
import { AIT_WORKSPACE_ID, AIT_LISTINGS } from "@/lib/analytics/ait-apps";
import { parseMetricDay, toDbDay } from "@/lib/analytics/metric-day";
import { recordCollectionFailure, recordObservations, type ObservationInput } from "@/lib/analytics/coverage";

// AppsInToss 콘솔 지표 ingest(push 수집). 인증된 로컬 Claude 세션이 MCP dashboard_* 를 조회해
// 정규화한 push 페이로드를 받아 AppConsoleMetricDaily(리스팅×날짜)로 멱등 upsert 한다.
// GA4 수집(analytics-collect)과 대칭: 소스만 다르고(BigQuery pull ↔ MCP push) 저장 규약은 동일.
// App 해석은 slug 우선(항상 존재), 없으면 miniAppId. 저장 키는 (appId, miniAppId, date) — 한 App 이
// 콘솔에 여러 미니앱으로 등록될 수 있어 miniAppId 로 리스팅을 분리한다(필수). 매핑 실패/miniAppId
// 누락/유효하지 않은 날짜는 개별 skip/error 로 담고 나머지 수집은 계속한다(부분 실패 격리).

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// miniAppId → App.slug (코드 표 기반 역해석). slug 미제공 push 를 App 으로 잇는 보조 경로.
const SLUG_BY_MINIAPP = new Map(AIT_LISTINGS.map((l) => [l.miniAppId, l.appSlug]));

export interface ConsoleIngestResult {
  targetApps: number; // 해석에 성공해 수집된 앱 수
  upserts: number; // 저장된 (앱×날짜) row 수
  skipped: { key: string; reason: string }[]; // 매핑/유효성 실패로 제외
  errors: { key: string; error: string }[]; // upsert 중 예외
  // 저장은 했지만 producer 가 채워야 할 값이 비어 온 경우. 실패가 아니라 품질 신호다.
  warnings: { key: string; warning: string }[];
}

/** ACTIVE 앱만 신규 콘솔 지표 수집 대상이다. PAUSED/DEPRECATED의 과거 행은 보존한다. */
export function isConsoleMetricCollectionActive(status: AppStatus): boolean {
  return status === "ACTIVE";
}

/**
 * raw 부가 지표에서 "키는 있는데 값이 전부 비어 있는" 경우를 찾는다.
 *
 * ingest 는 raw 를 그대로 저장하므로 producer(console-sync)가 구조만 만들고 값을 못 채우면
 * 조용히 통과한다. 2026-08-30 에 `iaaByOs: {IOS: null, ANDROID: null}` 가 그렇게 몇 달간
 * 쌓여 있었다. 저장은 막지 않되 결과에 드러내 다음 sync 에서 잡히게 한다.
 */
export function emptyRawSections(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const empty: string[] = [];
  for (const [section, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const values = Array.isArray(value) ? value : Object.values(value);
    if (values.length > 0 && values.every((item) => item == null)) empty.push(section);
  }
  return empty;
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
    warnings: [],
  };

  const apps = (payload as ConsoleMetricsPush | null)?.apps;
  if (!Array.isArray(apps) || apps.length === 0) {
    throw new Error("잘못된 페이로드 — { apps: ConsoleAppPush[] } 필요");
  }

  // App 해석 인덱스(slug / aitMiniAppId). 한 번만 로드.
  const registry = await prisma.app.findMany({
    select: { id: true, slug: true, status: true, aitMiniAppId: true, aitWorkspaceId: true },
  });
  const bySlug = new Map(registry.map((a) => [a.slug, a]));
  const byMiniApp = new Map(
    registry.filter((a) => a.aitMiniAppId != null).map((a) => [a.aitMiniAppId as number, a]),
  );

  for (const push of apps) {
    if (!push || typeof push !== "object") { result.skipped.push({ key: "unknown", reason: "리스팅 객체 필요" }); continue; }
    if ((push.slug != null && typeof push.slug !== "string") || typeof push.miniAppId !== "number" || !Number.isInteger(push.miniAppId) || (push.miniAppId ?? 0) <= 0) {
      result.skipped.push({ key: "unknown", reason: "리스팅 식별자 형식 오류" }); continue;
    }
    const key = pushKey(push);
    // miniAppId 는 리스팅 키(필수). slug 미제공 시 miniAppId→slug 코드표로 App 을 잇는다.
    const resolvedSlug = push.slug ?? (push.miniAppId != null ? SLUG_BY_MINIAPP.get(push.miniAppId) : undefined);
    const app =
      (resolvedSlug ? bySlug.get(resolvedSlug) : undefined) ??
      (push.miniAppId != null ? byMiniApp.get(push.miniAppId) : undefined);
    if (!app || (push.slug != null && push.slug !== app.slug)) {
      result.skipped.push({ key, reason: "App 매핑 없음(slug/miniAppId 불일치)" });
      continue;
    }
    if (!isConsoleMetricCollectionActive(app.status)) {
      result.skipped.push({ key, reason: `App 운영 중지(status=${app.status})` });
      continue;
    }
    const miniAppId = push.miniAppId;
    const listed = AIT_LISTINGS.some((listing) => listing.appSlug === app.slug && listing.miniAppId === miniAppId);
    const dbListed = app.aitMiniAppId === miniAppId && app.aitWorkspaceId != null;
    const workspaceId = listed ? AIT_WORKSPACE_ID : app.aitWorkspaceId;
    if ((!listed && !dbListed) || (push.workspaceId != null && push.workspaceId !== workspaceId)) {
      result.skipped.push({ key, reason: "등록된 리스팅 식별자 불일치" }); continue;
    }
    if (!Array.isArray(push.days) || push.days.length === 0) {
      result.skipped.push({ key, reason: "days 비어있음" });
      continue;
    }
    if (push.days.length > MAX_DAYS_PER_APP) {
      result.skipped.push({ key, reason: `days 초과(${push.days.length} > ${MAX_DAYS_PER_APP})` });
      continue;
    }

    result.targetApps++;
    // 콘솔 원장은 기록적이다. 대화형·파드 수집 모두 확인한 행만 저장하므로 "모든 칸에
    // 행을 쓴다"는 보장이 없고, 행이 없다는 사실은 활동 0 이 아니라 푸시가 아직
    // 안 왔다는 뜻이다(GA4 원장은 반대로 권위적이다).
    const observations: ObservationInput[] = [];
    const failures: Omit<ObservationInput, "state">[] = [];
    const dateCounts = new Map<string, number>();
    for (const day of push.days) if (day && typeof day.date === "string") dateCounts.set(day.date, (dateCounts.get(day.date) ?? 0) + 1);
    const duplicates = new Set<string>();
    for (const input of push.days as ConsoleDailyMetric[]) {
      if (input && typeof input.date === "string" && (dateCounts.get(input.date) ?? 0) > 1) {
        if (!duplicates.has(input.date)) {
          duplicates.add(input.date); result.skipped.push({ key, reason: "중복 날짜의 행 전체 제외" });
          if (parseMetricDay(input.date)) failures.push({ source: "ait_console", appId: app.id, listingId: miniAppId, day: input.date, detail: "중복 날짜로 저장 보류" });
        }
        continue;
      }
      const checked = validateConsoleDay(input);
      if (!checked.ok) {
        result.skipped.push({ key, reason: `미확인·비정상 지표: ${checked.fields.join(",")}` });
        if (input && typeof input.date === "string" && ISO_DATE.test(input.date) && !checked.fields.includes("date")) {
          failures.push({ source: "ait_console", appId: app.id, listingId: miniAppId, day: input.date, detail: "불완전한 지표로 저장 보류" });
        }
        continue;
      }
      const day = checked.day;
      const date = toDbDay(day.date);
      const patch = Object.fromEntries(consoleMetricFields.flatMap((field) => day[field] == null ? [] : [[field, day[field]]])) as Partial<Record<typeof consoleMetricFields[number], number>>;
      if (!Object.keys(patch).length && !hasConsoleAdObservation(day.raw, day.date)) {
        result.skipped.push({ key, reason: `확인된 지표 없음 (${day.date})` });
        continue;
      }
      for (const section of emptyRawSections(day.raw)) {
        result.warnings.push({ key, warning: `raw.${section} 값이 전부 비어 있음 (${day.date})` });
      }
      try {
        const saved = await retryPrismaConflict(() => prisma.$transaction(async (tx) => {
          // upsert가 행 잠금을 잡은 뒤 원본을 합쳐 동시 수집의 다른 OS를 잃지 않는다.
          const where = { appId_miniAppId_date: { appId: app.id, miniAppId, date } };
          const stored = await tx.appConsoleMetricDaily.upsert({ where,
            create: { appId: app.id, miniAppId, date, ...Object.fromEntries(consoleMetricFields.map((field) => [field, null])), ...patch, collectedAt: now },
            update: { ...patch, collectedAt: now },
          });
          const raw = mergeConsoleRaw(stored.raw, day.raw);
          const total = day.raw?.iaaByOs && day.iaaEarningKrw == null && day.iaaImpressions == null ? consoleAdTotal(raw, day.date) : null;
          return tx.appConsoleMetricDaily.update({ where, data: { ...total, raw: Object.keys(raw).length ? raw as Prisma.InputJsonObject : Prisma.JsonNull } });
        }));
        result.upserts++;
        const missing = Array.isArray(day.raw?.missingMetrics) ? day.raw.missingMetrics : [];
        if (consoleFinancialFields.every((field) => saved[field] != null) && !missing.length) {
          observations.push({ source: "ait_console", appId: app.id, listingId: miniAppId, day: day.date, state: "observed" });
        } else {
          result.warnings.push({ key, warning: `확인된 지표만 부분 저장 (${day.date})` });
          failures.push({ source: "ait_console", appId: app.id, listingId: miniAppId, day: day.date, detail: "확인된 지표만 부분 저장" });
        }
      } catch {
        const error = "CONSOLE_STORAGE_FAILED";
        result.errors.push({ key: `${key}@${day.date}`, error });
        failures.push({ source: "ait_console", appId: app.id, listingId: miniAppId, day: day.date, detail: error });
      }
    }
    await recordObservations(observations, now);
    await recordCollectionFailure(failures, now);
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
    select: { id: true, slug: true, status: true, aitMiniAppId: true, aitWorkspaceId: true },
  });

  const bySlug = new Map(registry.map((a) => [a.slug, a]));
  const groupByListing = new Map(grouped.map((g) => [`${g.appId}:${g.miniAppId}`, g]));

  // 대상 리스팅 = 코드 표 ∪ DB(aitMiniAppId 설정됐으나 표에 없는 앱의 primary).
  type Target = { slug: string; miniAppId: number; label?: string };
  const targets: Target[] = AIT_LISTINGS
    .filter((l) => {
      const app = bySlug.get(l.appSlug);
      return !app || isConsoleMetricCollectionActive(app.status);
    })
    .map((l) => ({
      slug: l.appSlug,
      miniAppId: l.miniAppId,
      label: l.label,
    }));
  const known = new Set(targets.map((l) => `${l.slug}:${l.miniAppId}`));
  for (const a of registry) {
    if (
      isConsoleMetricCollectionActive(a.status)
      && a.aitMiniAppId != null
      && !known.has(`${a.slug}:${a.aitMiniAppId}`)
    ) {
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
