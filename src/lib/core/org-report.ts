import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  dbDay,
  lastElapsedMetricDay,
  metricDayWindow,
  metricDaysBetween,
  toDbDay,
  shiftMetricDay,
} from "@/lib/analytics/metric-day";
import { ga4CoverageByDay } from "@/lib/analytics/coverage";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import {
  baselineOf,
  collectHighlightData,
  metricHighlightDedupeKey,
  sendMetricHighlightReport,
  type HighlightData,
} from "@/lib/core/metric-highlights";
import { metricNarrative, type MetricNarrative } from "@/lib/core/metric-narrative";
import { collectFinanceCosts, financeMonth } from "@/lib/core/finance-costs";
import { orgReportUrl } from "@/lib/core/org-report-link";
import { requeueNotification } from "@/lib/notifications/outbox";
import {
  ORG_REPORT_SCHEMA_VERSION,
  parseOrgReportDocument,
  serializeMovement,
  type OrgReportDocument,
} from "@/lib/core/org-report-schema";

// Org 종합 지표 보고서.
//
// 발행(11:00 KST, runDailyOrgReport)은 하이라이트 적재·판정(collectHighlightData)을
// 딱 한 번 수행해 (1) 스냅샷(OrgReportDaily) 저장과 (2) Discord 하이라이트 발송이
// 항상 같은 수치·판정·해설을 싣게 한다. 스냅샷 저장에 실패하면 발송하지 않는다 —
// 500 으로 cron 재시도를 받고, outbox dedupeKey 가 이중 발송을 막는다(SENT 는 재발송
// 되지 않는다).
//
// 조회(getOrgReport)는 스냅샷 우선이고, 없거나 파싱에 실패한 날짜만 원본 테이블에서
// 같은 조립기로 재계산한다(저장하지 않음). 비용·LLM 해설은 과거 시점을 복원할 수
// 없어 재계산 문서에서는 null 이다.
//
// 추이 그래프(orgTrendSeries)는 스냅샷이 아니라 항상 원본 시계열을 읽는다 — GA4 는
// 매일 최근 N일(analytics-collect WINDOW_DAYS) 창을 재집계하므로 스냅샷을 이어 붙이면
// 낡은 값이 남는다.

type Ga4Summary = OrgReportDocument["summary"]["ga4"];
type PlatformSplit = OrgReportDocument["platform"];
type SegmentCell = OrgReportDocument["segments"]["game"];
type AppEntry = OrgReportDocument["apps"][number];
type ConsoleMeta = OrgReportDocument["consoleMeta"];

/** 조립된 문서 → 발췌 스칼라(피커/목록 조회용). */
function excerptOf(doc: OrgReportDocument) {
  const tally = (verdict: "highlight" | "lowlight") =>
    doc.movements.filter((movement) => movement.verdict === verdict).length;
  return {
    ga4Dau: doc.summary.ga4.dau,
    consoleIaaKrw: doc.summary.console.iaaKrw,
    consoleIapKrw: doc.summary.console.iapTrxKrw,
    highlightCount: tally("highlight"),
    lowlightCount: tally("lowlight"),
    consoleLagDays: doc.consoleMeta.lagDays,
    narrated: doc.narrative != null,
  };
}

function buildConsoleMeta(data: HighlightData): ConsoleMeta {
  const listings = data.consoleSeries.length + data.consoleMissing.length;
  if (data.consoleSeries.length === 0) {
    return { refDate: null, lagDays: null, listings, onRefDate: 0, missing: data.consoleMissing };
  }
  const latestMs = Math.max(
    ...data.consoleSeries.map((series) => series.rowsDesc[0].date.getTime()),
  );
  const consoleRefDate = dbDay(new Date(latestMs));
  return {
    refDate: consoleRefDate,
    lagDays: metricDaysBetween(data.refDate, dbDay(new Date(latestMs))),
    listings,
    onRefDate: data.consoleSeries.filter(
      (series) => dbDay(series.rowsDesc[0].date) === consoleRefDate,
    ).length,
    missing: data.consoleMissing,
  };
}

/**
 * 적재된 재료 → 보고서 문서(순수 조립, DB/LLM/외부 호출 없음).
 * 수치 규칙은 Discord 하이라이트와 동일하다: GA4 합계는 기준일 스냅샷이 있는 앱만,
 * 콘솔 합계는 각 리스팅의 최신 스냅샷(지연은 lagDays 로 정직하게 기록).
 */
export function assembleOrgReportDocument(input: {
  data: HighlightData;
  narrative: string | null;
  costs: OrgReportDocument["costs"];
  origin: OrgReportDocument["origin"];
  generatedAt: Date;
  /** 해설 생성 출처(선택). 어느 모델이 어떤 지시로 썼는지. */
  narrativeMeta?: OrgReportDocument["narrativeMeta"];
  /** 발행 기록. 정정 판단의 근거이자 "그때 무엇을 보고 그 숫자를 냈는가"의 기록이다. */
  published?: OrgReportDocument["published"];
}): OrgReportDocument {
  const { data } = input;
  const latestGa4 = data.ga4Series.map((series) => series.rowsDesc[0]);
  const latestConsole = data.consoleSeries.map((series) => series.rowsDesc[0]);
  const sum = <T>(rows: readonly T[], pick: (row: T) => number): number =>
    rows.reduce((total, row) => total + pick(row), 0);

  const ga4Summary: Ga4Summary = {
    dau: data.totals.ga4Dau.latest,
    dauPrev: data.totals.ga4Dau.previous,
    newUsers: sum(latestGa4, (row) => row.newUsers),
    engagedUsers: sum(latestGa4, (row) => row.engagedUsers),
    adCompletions: sum(latestGa4, (row) => row.adCompletions),
    apps: data.totals.ga4Dau.apps,
  };

  // 전일 합은 기준일 합과 같은 앱 집합에서 나온다(기존 totals 규칙). 앱이 없으면 null.
  const prevOrNull = (total: number): number | null => (data.ga4Series.length ? total : null);
  const platform: PlatformSplit = {
    android: {
      dau: sum(latestGa4, (row) => row.dauAndroid),
      dauPrev: prevOrNull(sum(data.ga4Series, (s) => s.rowsDesc[1]?.dauAndroid ?? 0)),
    },
    ios: {
      dau: sum(latestGa4, (row) => row.dauIos),
      dauPrev: prevOrNull(sum(data.ga4Series, (s) => s.rowsDesc[1]?.dauIos ?? 0)),
    },
    web: {
      dau: sum(latestGa4, (row) => row.dauWeb),
      dauPrev: prevOrNull(sum(data.ga4Series, (s) => s.rowsDesc[1]?.dauWeb ?? 0)),
    },
  };

  const segment = (type: "GAME" | "APP"): SegmentCell => {
    const ga4 = data.ga4Series.filter((series) => series.app.type === type);
    const consoles = data.consoleSeries.filter((series) => series.app.type === type);
    const slugs = new Set([...ga4, ...consoles].map((series) => series.app.slug));
    return {
      apps: slugs.size,
      dau: sum(ga4, (series) => series.rowsDesc[0].dau),
      dauPrev: ga4.length ? sum(ga4, (series) => series.rowsDesc[1]?.dau ?? 0) : null,
      iaaKrw: sum(consoles, (series) => series.rowsDesc[0].iaaEarningKrw),
      iapTrxKrw: sum(consoles, (series) => series.rowsDesc[0].iapTrxAmountKrw),
    };
  };

  // 앱별 분해: GA4·콘솔 어느 한쪽이라도 있는 앱을 displayName 순으로 합친다.
  const entries = new Map<string, AppEntry>();
  const entryOf = (app: { slug: string; displayName: string; type: "APP" | "GAME" }): AppEntry => {
    let entry = entries.get(app.slug);
    if (!entry) {
      entry = { slug: app.slug, displayName: app.displayName, type: app.type, ga4: null, listings: [] };
      entries.set(app.slug, entry);
    }
    return entry;
  };
  for (const series of data.ga4Series) {
    const latest = series.rowsDesc[0];
    entryOf(series.app).ga4 = {
      date: dbDay(latest.date),
      dau: latest.dau,
      dauPrev: series.rowsDesc[1]?.dau ?? null,
      dau7dMedian: baselineOf(series.rowsDesc.slice(1).map((row) => row.dau)),
      newUsers: latest.newUsers,
      d1Pct: latest.d1Pct,
      engagedUsers: latest.engagedUsers,
      adCompletions: latest.adCompletions,
      dauAndroid: latest.dauAndroid,
      dauIos: latest.dauIos,
      dauWeb: latest.dauWeb,
    };
  }
  for (const series of data.consoleSeries) {
    const latest = series.rowsDesc[0];
    entryOf(series.app).listings.push({
      miniAppId: series.miniAppId,
      label: series.listingLabel,
      date: dbDay(latest.date),
      lagDays: metricDaysBetween(data.refDate, dbDay(latest.date)),
      dau: latest.dau,
      newUsers: latest.newUsers,
      iaaKrw: latest.iaaEarningKrw,
      iapTrxKrw: latest.iapTrxAmountKrw,
      payingUsers: latest.payingUsers,
    });
  }

  return {
    version: ORG_REPORT_SCHEMA_VERSION,
    refDate: data.refDate,
    generatedAt: input.generatedAt.toISOString(),
    origin: input.origin,
    summary: {
      ga4: ga4Summary,
      console: {
        iaaKrw: data.totals.console.iaaKrw,
        iaaPrevKrw: data.totals.console.previousIaaKrw,
        iapTrxKrw: data.totals.console.iapKrw,
        iapSettlementKrw: sum(latestConsole, (row) => row.iapSettlementKrw),
        payingUsers: sum(latestConsole, (row) => row.payingUsers),
        listings: data.totals.console.listings,
      },
    },
    platform,
    segments: { game: segment("GAME"), app: segment("APP") },
    apps: [...entries.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "ko")),
    movements: data.movements.map(serializeMovement),
    referrers: data.totals.referrers ?? [],
    narrative: input.narrative,
    costs: input.costs,
    consoleMeta: buildConsoleMeta(data),
    narrativeMeta: input.narrativeMeta ?? null,
    published: input.published ?? null,
  };
}

async function saveOrgReport(doc: OrgReportDocument): Promise<{ version: number }> {
  const excerpt = excerptOf(doc);
  const common = {
    schemaVersion: ORG_REPORT_SCHEMA_VERSION,
    report: doc as unknown as Prisma.InputJsonValue,
    generatedAt: new Date(doc.generatedAt),
    ...excerpt,
  };
  return prisma.orgReportDaily.upsert({
    where: { date: toDbDay(doc.refDate) },
    create: { date: toDbDay(doc.refDate), ...common },
    update: { version: { increment: 1 }, ...common },
    select: { version: true },
  });
}

export interface OrgReportRunResult {
  refDate: string;
  version: number;
  narrated: boolean;
  highlights: number;
  lowlights: number;
  observations: number;
  dedupeKey: string;
  consoleLagDays: number | null;
}

/**
 * 일일 발행 본체(11:00 cron): 적재·판정 1회 → 해설 → 비용 → 스냅샷 upsert →
 * Discord 하이라이트(보고서 링크 포함). 스냅샷 저장 실패는 그대로 던져 발송을 막는다.
 */
export async function runDailyOrgReport(now = new Date()): Promise<OrgReportRunResult> {
  const data = await collectHighlightData(now);
  const made = await metricNarrative(data);
  const financeCosts = await collectFinanceCosts(now);
  const doc = assembleOrgReportDocument({
    data,
    narrative: made.text,
    narrativeMeta: meta(made),
    costs: {
      month: financeMonth(now).month,
      summaryLines: financeCosts.summaryLines,
      warnings: financeCosts.warnings,
      figures: financeCosts.figures,
    },
    origin: "published",
    generatedAt: now,
  });
  // 스냅샷을 먼저 저장한다(저장 실패는 그대로 던져 발송을 막는다). 발행 기록도 여기서
  // 남긴다 — 이것이 없으면 다음 밤 정정이 "아직 발행 안 됨"으로 오판해 정정이 아니라
  // 최초 발행으로 처리한다. dedupeKey 는 순수 함수라 발송 전에 알 수 있다.
  const { version } = await saveOrgReport({
    ...doc,
    published: {
      factsHash: factsFingerprint(data),
      dedupeKey: metricHighlightDedupeKey(data.refDate),
      publishedAt: now.toISOString(),
      observed: data.asOf?.observed ?? data.totals.ga4Dau.apps,
      expected: data.asOf?.expected ?? data.totals.ga4Dau.apps,
      corrections: 0,
    },
  });
  const sent = await sendMetricHighlightReport(now, {
    data,
    narrative: made.text,
    reportUrl: orgReportUrl(data.refDate),
  });
  return { ...sent, narrated: !made.fallback, version, consoleLagDays: doc.consoleMeta.lagDays };
}

/**
 * 발행 시점 "사실"의 지문. 수치·판정·커버리지만 넣고 LLM 해설은 뺀다 — 해설은 실행마다
 * 달라져서 본문을 해싱하면 수치가 그대로인 날에도 매번 정정으로 판정된다.
 */
export function factsFingerprint(data: HighlightData): string {
  const canonical = JSON.stringify({
    refDate: data.refDate,
    ga4: data.totals.ga4Dau,
    console: {
      iaaKrw: data.totals.console.iaaKrw,
      iapKrw: data.totals.console.iapKrw,
      previousIaaKrw: data.totals.console.previousIaaKrw,
      listings: data.totals.console.listings,
    },
    observed: data.asOf?.observed ?? null,
    expected: data.asOf?.expected ?? null,
    movements: data.movements
      .map((movement) =>
        [movement.label, movement.metricKey, movement.verdict, movement.latest, movement.baseline]
          .join("|"))
      .sort(),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** 정정 안내 한 줄. 무엇이 얼마나 바뀌었는지를 옛 발췌 컬럼에서 바로 만든다. */
export function correctionLine(input: {
  previousDau: number;
  previousApps: number | null;
  currentDau: number;
  currentApps: number;
}): string {
  const apps = input.previousApps != null && input.previousApps !== input.currentApps
    ? `, 대상 ${input.previousApps} → ${input.currentApps}개 앱`
    : "";
  return `♻️ 정정 — 늦게 도착한 수집을 반영했습니다 (GA4 DAU 합계 ${input.previousDau.toLocaleString("ko-KR")} → ${input.currentDau.toLocaleString("ko-KR")}명${apps}).`;
}

/** MetricNarrative → 문서에 남길 출처. 텍스트는 따로 싣는다. */
const meta = (made: MetricNarrative): OrgReportDocument["narrativeMeta"] => ({
  fallback: made.fallback,
  provider: made.provider,
  model: made.model,
  promptVersion: made.promptVersion,
});

/** 해설을 다시 부르지 않는 정정 횟수 상한. 수치가 계속 흔들리는 날에 LLM 을 반복 호출하지 않는다. */
const MAX_NARRATED_CORRECTIONS = 2;

export interface ReconcileResult {
  day: string;
  action: "none" | "published" | "corrected";
  version: number | null;
  requeued: number;
}

/**
 * 하루 전 발행분을 지금 원본과 대조해 필요할 때만 정정한다(야간 발행과 같은 실행).
 *
 * 발행은 D-1 을 내보내지만 그 시점에 늦게 도착한 export 가 있을 수 있다. 다음 날 밤
 * 같은 날짜를 다시 계산해, 사실이 달라졌으면 **같은 Discord 메시지를 고친다**.
 * 새 메시지를 보내면 어느 쪽이 맞는지 읽는 사람이 모르고, 아무것도 안 하면 발행분이
 * 영원히 틀린 채 남는다(08-30~09-11 이 실제로 그랬다).
 *
 * 사실이 같으면 아무것도 하지 않는다 — 변화 없는 version+1 은 감사 기록을 흐린다.
 */
export async function reconcileOrgReport(
  now = new Date(),
  opts: { day?: string } = {},
): Promise<ReconcileResult> {
  const day = opts.day ?? shiftMetricDay(lastElapsedMetricDay(now), -1);
  const data = await collectHighlightData(now, day);
  const snapshot = await prisma.orgReportDaily.findUnique({ where: { date: toDbDay(day) } });
  const previous = snapshot ? parseOrgReportDocument(snapshot.report) : null;
  const published = previous?.published ?? null;
  const facts = factsFingerprint(data);

  if (published && published.factsHash === facts) {
    return { day, action: "none", version: snapshot?.version ?? null, requeued: 0 };
  }

  const corrections = published ? published.corrections + 1 : 0;
  const correction = published
    ? correctionLine({
      previousDau: snapshot?.ga4Dau ?? 0,
      previousApps: previous?.summary.ga4.apps ?? null,
      currentDau: data.totals.ga4Dau.latest,
      currentApps: data.totals.ga4Dau.apps,
    })
    : null;
  // 수치가 바뀌었으면 앞선 해설은 정의상 틀렸다. 다만 같은 날짜가 계속 흔들리면
  // 해설을 반복 생성하지 않고 수치만 정정한다.
  const made = corrections > MAX_NARRATED_CORRECTIONS
    ? null
    : await metricNarrative(data);
  const narrative = made ? made.text : previous?.narrative ?? null;

  const sent = await sendMetricHighlightReport(now, {
    data,
    narrative,
    reportUrl: orgReportUrl(day),
    correction,
  });
  const doc = assembleOrgReportDocument({
    data,
    narrative,
    narrativeMeta: made ? meta(made) : previous?.narrativeMeta ?? null,
    // 비용은 과거 시점을 복원할 수 없다. 발행분의 값을 그대로 잇는다.
    costs: previous?.costs ?? null,
    origin: "published",
    generatedAt: now,
    published: {
      factsHash: facts,
      dedupeKey: sent.dedupeKey,
      publishedAt: published?.publishedAt ?? now.toISOString(),
      observed: data.asOf?.observed ?? data.totals.ga4Dau.apps,
      expected: data.asOf?.expected ?? data.totals.ga4Dau.apps,
      corrections,
    },
  });
  const { version } = await saveOrgReport(doc);
  // SENT 를 PENDING 으로 되돌리면 providerMessageId 가 남아 워커가 같은 메시지를 고친다.
  const requeued = await requeueNotification(sent.eventId);
  return { day, action: published ? "corrected" : "published", version, requeued };
}

/**
 * 특정 날짜의 보고서를 원본에서 재계산한다. persist=true 면 스냅샷으로 저장(수동
 * 재발행/백필)하고, 아니면 조회 전용이다. 그 날짜에 GA4·콘솔 데이터가 전혀 없으면 null.
 */
export async function buildOrgReportForDate(
  refDate: string,
  options: { persist?: boolean; now?: Date } = {},
): Promise<{ doc: OrgReportDocument; version: number | null } | null> {
  const now = options.now ?? new Date();
  const data = await collectHighlightData(now, refDate);
  if (data.ga4Series.length === 0 && data.consoleSeries.length === 0) return null;
  const doc = assembleOrgReportDocument({
    data,
    // 재계산은 결정적 수치만 — LLM 해설과 비용(월누적 실시간 조회)은 과거 복원이 불가하다.
    narrative: null,
    costs: null,
    origin: "recomputed",
    generatedAt: now,
  });
  if (!options.persist) return { doc, version: null };
  const { version } = await saveOrgReport(doc);
  return { doc, version };
}

export interface OrgReportView {
  doc: OrgReportDocument;
  /** snapshot=저장된 발행문 그대로, recomputed=조회 시점 재계산(저장하지 않음). */
  source: "snapshot" | "recomputed";
  version: number | null;
  generatedAt: Date | null;
}

/**
 * 날짜별 보고서 조회. date 미지정이면 최신 확정일(D-1). 스냅샷 우선, 없거나 파싱
 * 실패면 재계산 fallback. 그 날짜에 데이터가 전혀 없으면(미래 포함) null.
 */
export async function getOrgReport(date?: string, now = new Date()): Promise<OrgReportView | null> {
  const refDate = date ?? lastElapsedMetricDay(now);
  const snapshot = await prisma.orgReportDaily.findUnique({
    where: { date: toDbDay(refDate) },
  });
  if (snapshot) {
    const doc = parseOrgReportDocument(snapshot.report);
    if (doc) {
      return { doc, source: "snapshot", version: snapshot.version, generatedAt: snapshot.generatedAt };
    }
    console.error(`[org-report] 스냅샷 파싱 실패(${refDate}, v${snapshot.version}) — 재계산으로 강등`);
  }
  const built = await buildOrgReportForDate(refDate, { now });
  return built ? { doc: built.doc, source: "recomputed", version: null, generatedAt: null } : null;
}

export interface OrgReportDayExcerpt {
  date: string;
  version: number;
  ga4Dau: number;
  consoleIaaKrw: number;
  consoleIapKrw: number;
  highlightCount: number;
  lowlightCount: number;
  consoleLagDays: number | null;
  narrated: boolean;
  generatedAt: Date;
}

/** 발행된 날짜 목록(최신순, 발췌값만). 날짜 피커·목록 UI 용. */
export async function listOrgReportDays(limit = 60): Promise<OrgReportDayExcerpt[]> {
  const rows = await prisma.orgReportDaily.findMany({
    orderBy: { date: "desc" },
    take: limit,
    select: {
      date: true,
      version: true,
      ga4Dau: true,
      consoleIaaKrw: true,
      consoleIapKrw: true,
      highlightCount: true,
      lowlightCount: true,
      consoleLagDays: true,
      narrated: true,
      generatedAt: true,
    },
  });
  return rows.map((row) => ({ ...row, date: dbDay(row.date) }));
}

export interface OrgTrendPoint {
  date: string;
  ga4Dau: number | null;
  ga4NewUsers: number | null;
  adCompletions: number | null;
  dauAndroid: number | null;
  dauIos: number | null;
  dauWeb: number | null;
  /** 콘솔 DAU 합. 그 날 전 리스팅이 null(미집계)이면 null — 허수 0 을 만들지 않는다. */
  consoleDau: number | null;
  consoleIaaKrw: number | null;
  consoleIapTrxKrw: number | null;
}

export interface TrendGa4Sums {
  dau: number | null;
  newUsers: number | null;
  adCompletions: number | null;
  dauAndroid: number | null;
  dauIos: number | null;
  dauWeb: number | null;
}

export interface TrendConsoleSums {
  dau: number | null;
  iaaEarningKrw: number | null;
  iapTrxAmountKrw: number | null;
}

/**
 * 일별 합산 값을 endDate(포함) 기준 과거 days 일의 날짜 격자로 정렬한다(순수).
 * 수집이 없는 날은 null 로 남겨 차트가 선을 끊게 한다 — 0 으로 채우면 없던 날에도
 * 그 값이었다는 거짓을 만든다.
 */
export function alignTrendGrid(
  endDate: string,
  days: number,
  ga4ByDate: ReadonlyMap<string, TrendGa4Sums>,
  consoleByDate: ReadonlyMap<string, TrendConsoleSums>,
  /**
   * 날짜별 GA4 관측/기대 수. 일부 앱만 수집된 날의 합계는 낮은 값이 아니라 "모르는
   * 값"이다. 그 날을 그대로 그리면 한 앱이 빠진 날이 포트폴리오 급감으로 보인다 —
   * 화면에서 보이던 들쭉날쭉함의 정체가 이것이다. 주지 않으면 기존 동작 그대로.
   */
  ga4CoverageByDate?: ReadonlyMap<string, { observed: number; expected: number }>,
): OrgTrendPoint[] {
  return metricDayWindow(endDate, days).map((key) => {
    const coverage = ga4CoverageByDate?.get(key);
    const partial = coverage != null && coverage.observed < coverage.expected;
    const ga4 = partial ? undefined : ga4ByDate.get(key);
    const console_ = consoleByDate.get(key);
    return {
      date: key,
      ga4Dau: ga4?.dau ?? null,
      ga4NewUsers: ga4?.newUsers ?? null,
      adCompletions: ga4?.adCompletions ?? null,
      dauAndroid: ga4?.dauAndroid ?? null,
      dauIos: ga4?.dauIos ?? null,
      dauWeb: ga4?.dauWeb ?? null,
      consoleDau: console_?.dau ?? null,
      consoleIaaKrw: console_?.iaaEarningKrw ?? null,
      consoleIapTrxKrw: console_?.iapTrxAmountKrw ?? null,
    };
  });
}

/**
 * 추이 그래프용 Org 합산 시계열. endDate(포함)부터 과거 days 일을 날짜 격자로 정렬해
 * 수집이 없는 날은 null 로 남긴다(차트가 선을 끊는다). 원본 테이블을 읽으므로 GA4
 * 재집계·콘솔 늦은 push 가 반영된 최신 확정치다.
 *
 * 일부 앱만 수집된 날도 null 이다. 그 날의 합계는 낮은 값이 아니라 모르는 값이고,
 * 그대로 그리면 한 앱이 빠진 날이 포트폴리오 급감으로 보인다.
 */
export async function orgTrendSeries(endDate: string, days = 28): Promise<OrgTrendPoint[]> {
  const end = toDbDay(endDate);
  const range = { gte: toDbDay(metricDayWindow(endDate, days)[0]), lte: end };
  const [ga4Rows, consoleRows] = await Promise.all([
    prisma.appMetricDaily.groupBy({
      by: ["date"],
      where: { date: range, app: visibleAppWhere },
      _sum: {
        dau: true,
        newUsers: true,
        adCompletions: true,
        dauAndroid: true,
        dauIos: true,
        dauWeb: true,
      },
    }),
    prisma.appConsoleMetricDaily.groupBy({
      by: ["date"],
      where: { date: range, app: visibleAppWhere },
      _sum: { dau: true, iaaEarningKrw: true, iapTrxAmountKrw: true },
    }),
  ]);
  return alignTrendGrid(
    endDate,
    days,
    new Map(ga4Rows.map((row) => [dbDay(row.date), row._sum])),
    new Map(consoleRows.map((row) => [dbDay(row.date), row._sum])),
    await ga4CoverageByDay(metricDayWindow(endDate, days)),
  );
}
