import { prisma } from "@/lib/prisma";
import { isoDate, latestClosedDay, resolveGa4Target } from "@/lib/ga4/datasets";
import { listingsForSlug, resolveAitTarget } from "@/lib/analytics/ait-apps";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { SEORI_SENDER } from "@/lib/notifications/sender";
import { metricNarrative, narrativeFacts } from "@/lib/core/metric-narrative";

// 서리 일일 지표 하이라이트·로우라이트. GA4(AppMetricDaily)와 AppsInToss 콘솔
// (AppConsoleMetricDaily)의 저장된 스냅샷만 읽어 "어제 무엇이 크게 움직였는가"를 추린다.
// 전량 나열은 #metrics-daily 의 지표 리포트가 이미 한다. 여기서는 판단만 남긴다.
//
// 판정은 전부 결정적이다. 최신값을 직전 7일 중앙값과 비교하고, 표본이 작은 앱을
// 먼저 걸러 낸 뒤 변화율×규모로 정렬한다. 중앙값을 쓰는 이유는 하루짜리 튐이
// 기준선을 흔들지 않게 하기 위해서다(기존 이상 감지와 같은 방식).

const BASELINE_DAYS = 7;
/** 기준선을 세우는 데 필요한 최소 관측일. 이보다 적으면 판정하지 않는다. */
const MIN_BASELINE_POINTS = 4;
const TOP_N = 5;
const SENDER_KO = "서리";

export type MovementSource = "GA4" | "콘솔";

export interface MetricSpec {
  key: string;
  ko: string;
  source: MovementSource;
  /** 이 값 미만의 기준선은 표본이 작아 판정하지 않는다. */
  minBaseline: number;
  /** 이 변화 이상만 하이라이트·로우라이트가 된다. 비율 지표는 %p, 나머지는 %. */
  minChange: number;
  /**
   * 상대 변화와 함께 요구하는 최소 절대 변화량. 규모가 작은 포트폴리오에서는
   * 3명이 5명이 되어도 +67% 라 상대 임계만으로는 잡음이 리포트를 덮는다.
   */
  minAbsDelta?: number;
  /**
   * 이 지표를 판정하기 위해 필요한 최소 모수. 잔존율처럼 분모가 작으면 값 자체가
   * 흔들리는 지표에 건다(D1 은 신규 사용자 수).
   */
  minSample?: number;
  /** 잔존율처럼 그 자체가 퍼센트인 지표. 상대 변화가 아니라 %p 로 본다. */
  pointScale?: boolean;
  format: (value: number) => string;
}

const count = (unit: string) => (value: number) => `${Math.round(value).toLocaleString("ko-KR")}${unit}`;
const won = (value: number) => `₩${Math.round(value).toLocaleString("ko-KR")}`;
const percent = (value: number) => `${value.toFixed(1)}%`;

// 임계는 2026-08-29 실측 분포에 맞춘 값이다(전체 GA4 DAU 75명, 콘솔 일 광고수익 ₩38).
// 포트폴리오가 커지면 minBaseline·minAbsDelta 를 함께 올린다.
export const METRIC_SPECS: MetricSpec[] = [
  { key: "ga4_dau", ko: "DAU", source: "GA4", minBaseline: 5, minChange: 30, minAbsDelta: 3, format: count("명") },
  // 신규 20명 미만 코호트의 D1 은 한두 명에 수십 %p 가 움직여 판정하지 않는다.
  { key: "ga4_d1", ko: "D1 잔존율", source: "GA4", minBaseline: 5, minChange: 15, minSample: 20, pointScale: true, format: percent },
  { key: "ga4_ad_completions", ko: "보상형 광고 완료", source: "GA4", minBaseline: 10, minChange: 40, minAbsDelta: 5, format: count("회") },
  { key: "console_dau", ko: "토스 DAU", source: "콘솔", minBaseline: 5, minChange: 40, minAbsDelta: 3, format: count("명") },
  { key: "console_iaa", ko: "광고 수익", source: "콘솔", minBaseline: 50, minChange: 50, minAbsDelta: 50, format: won },
  { key: "console_iap", ko: "결제 거래액", source: "콘솔", minBaseline: 1_000, minChange: 40, minAbsDelta: 1_000, format: won },
];

const SPEC_BY_KEY = new Map(METRIC_SPECS.map((spec) => [spec.key, spec]));

export interface MovementInput {
  /** 표시 이름. 콘솔 다중 리스팅은 리스팅 라벨까지 포함한다. */
  label: string;
  metricKey: string;
  latest: number;
  /** 직전 7일 중앙값. 관측이 모자라면 null. */
  baseline: number | null;
  /** 지표의 모수(D1 의 신규 사용자 수 등). spec.minSample 이 있는 지표만 쓴다. */
  sample?: number | null;
  /** 이 값의 기준일. 리포트 기준일과 다르면 리포트에 함께 표기한다. */
  date: string;
}

/** absent = 관측 창 전체가 0 이라 애초에 말할 것이 없는 지표(광고 없는 앱의 광고 수익 등). */
export type MovementVerdict = "highlight" | "lowlight" | "flat" | "insufficient" | "absent";

export interface Movement extends MovementInput {
  spec: MetricSpec;
  verdict: MovementVerdict;
  /** 변화량. 비율 지표는 %p, 나머지는 %. 신규 등장(기준선 0)은 null. */
  change: number | null;
  /** 정렬 점수. 변화 크기 × 규모(로그) — 작은 앱의 큰 변화율이 판을 덮지 않게 한다. */
  score: number;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 관측일이 모자라면 null. 기준선은 최신값을 뺀 직전 구간의 중앙값이다. */
export function baselineOf(previousValues: readonly (number | null)[]): number | null {
  const usable = previousValues
    .slice(0, BASELINE_DAYS)
    .filter((value): value is number => value != null);
  return usable.length >= MIN_BASELINE_POINTS ? median(usable) : null;
}

export function evaluateMovement(input: MovementInput): Movement {
  const spec = SPEC_BY_KEY.get(input.metricKey);
  if (!spec) throw new Error(`알 수 없는 지표: ${input.metricKey}`);
  const base = { ...input, spec };

  // 창 전체가 0 이면 그 앱에 없는 지표다. 표본 부족이 아니라 관측 대상이 아니다.
  if (input.latest === 0 && (input.baseline === 0 || input.baseline == null)) {
    return { ...base, verdict: "absent", change: null, score: 0 };
  }
  if (input.baseline == null) return { ...base, verdict: "insufficient", change: null, score: 0 };

  // 모수가 작으면 값 자체가 흔들려 변화를 신호로 읽을 수 없다.
  if (spec.minSample != null && (input.sample ?? 0) < spec.minSample) {
    return { ...base, verdict: "insufficient", change: null, score: 0 };
  }

  // 기준선이 임계 미만이면 표본이 작다. 다만 없던 것이 뚜렷하게 생긴 경우는
  // 그 자체가 소식이라 "신규"로 올린다.
  if (input.baseline < spec.minBaseline) {
    if (input.baseline === 0 && input.latest >= spec.minBaseline) {
      return { ...base, verdict: "highlight", change: null, score: 100 * Math.log10(input.latest + 10) };
    }
    return { ...base, verdict: "insufficient", change: null, score: 0 };
  }

  const change = spec.pointScale
    ? input.latest - input.baseline
    : ((input.latest - input.baseline) / input.baseline) * 100;
  const absDelta = Math.abs(input.latest - input.baseline);
  if (Math.abs(change) < spec.minChange || absDelta < (spec.minAbsDelta ?? 0)) {
    return { ...base, verdict: "flat", change, score: 0 };
  }
  return {
    ...base,
    verdict: change > 0 ? "highlight" : "lowlight",
    change,
    score: Math.abs(change) * Math.log10(input.baseline + 10),
  };
}

export function rankMovements(movements: readonly Movement[], verdict: "highlight" | "lowlight"): Movement[] {
  return movements
    .filter((movement) => movement.verdict === verdict)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, "ko"));
}

function movementLine(movement: Movement, refDate: string, index: number): string {
  const spec = movement.spec;
  const value = spec.format(movement.latest);
  const stamp = movement.date === refDate ? "" : ` · ⏳${movement.date}`;
  if (movement.change == null) {
    return `${index + 1}. **${movement.label}** · ${spec.source} ${spec.ko} ${value} (신규)${stamp}`;
  }
  const delta = spec.pointScale
    ? `${movement.change >= 0 ? "+" : ""}${movement.change.toFixed(1)}%p`
    : `${movement.change >= 0 ? "+" : ""}${Math.round(movement.change)}%`;
  const base = spec.format(movement.baseline as number);
  return `${index + 1}. **${movement.label}** · ${spec.source} ${spec.ko} ${value} (기준 ${base}, ${delta})${stamp}`;
}

/** 콘솔 유입경로 한 항목(검색/전체탭 등). 비율은 0~1. */
export interface ReferrerShare {
  dimension: string;
  rate: number;
}

/** 콘솔 raw.referrer 를 리스팅 합산으로 접는다. 값이 없으면 빈 배열. */
export function foldReferrers(raws: ReadonlyArray<unknown>): ReferrerShare[] {
  const weight = new Map<string, number>();
  for (const raw of raws) {
    const rows = (raw as { referrer?: unknown } | null)?.referrer;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const dimension = (row as { dimension?: unknown })?.dimension;
      const value = (row as { value?: unknown })?.value;
      if (typeof dimension !== "string" || !dimension || typeof value !== "number" || value <= 0) continue;
      weight.set(dimension, (weight.get(dimension) ?? 0) + value);
    }
  }
  const total = [...weight.values()].reduce((sum, v) => sum + v, 0);
  if (total <= 0) return [];
  // 비율은 리스팅별 rate 평균이 아니라 유입 수 합으로 다시 계산한다. 규모가 다른
  // 리스팅의 비율을 평균하면 작은 리스팅이 과대 대표된다.
  return [...weight.entries()]
    .map(([dimension, value]) => ({ dimension, rate: value / total }))
    .sort((a, b) => b.rate - a.rate);
}

export interface PortfolioTotals {
  /** 기준일 GA4 DAU 합과 그 전날 합. 전날 값이 없으면 null. */
  ga4Dau: { latest: number; previous: number | null; apps: number };
  /** 콘솔 광고 수익·결제 거래액 합(기준일 스냅샷이 있는 리스팅만). */
  console: { iaaKrw: number; iapKrw: number; previousIaaKrw: number | null; listings: number };
  /** 콘솔 유입경로 비중(합산). 수집 값이 없으면 빈 배열이라 줄 자체가 빠진다. */
  referrers?: ReferrerShare[];
}

function totalLine(label: string, latest: string, previous: string | null, changePct: number | null): string {
  if (previous == null || changePct == null) return `${label} ${latest}`;
  const sign = changePct >= 0 ? "+" : "";
  return `${label} ${latest} (전일 ${previous} · ${sign}${changePct.toFixed(1)}%)`;
}

function pctChange(latest: number, previous: number | null): number | null {
  return previous == null || previous === 0 ? null : ((latest - previous) / previous) * 100;
}

export function renderHighlightReport(input: {
  refDate: string;
  totals: PortfolioTotals;
  movements: readonly Movement[];
  /** LLM 해설(선택). 생성 실패 시 없이 나간다 — 리포트를 LLM 가용성에 묶지 않는다. */
  narrative?: string | null;
}): string {
  const { totals } = input;
  const lines = [`📈 **${SENDER_KO} 지표 하이라이트 · ${input.refDate} (D-1)**`];
  lines.push(
    totalLine(
      "GA4 DAU 합계",
      `${totals.ga4Dau.latest.toLocaleString("ko-KR")}명`,
      totals.ga4Dau.previous == null ? null : `${totals.ga4Dau.previous.toLocaleString("ko-KR")}명`,
      pctChange(totals.ga4Dau.latest, totals.ga4Dau.previous),
    ) + ` · 대상 ${totals.ga4Dau.apps}개 앱`,
  );
  lines.push(
    totalLine(
      "콘솔 광고 수익",
      won(totals.console.iaaKrw),
      totals.console.previousIaaKrw == null ? null : won(totals.console.previousIaaKrw),
      pctChange(totals.console.iaaKrw, totals.console.previousIaaKrw),
    ) + ` · 결제 ${won(totals.console.iapKrw)} · 대상 ${totals.console.listings}개 리스팅`,
  );

  const referrers = totals.referrers ?? [];
  if (referrers.length > 0) {
    lines.push(
      `유입경로: ${referrers
        .slice(0, 4)
        .map((item) => `${item.dimension} ${(item.rate * 100).toFixed(0)}%`)
        .join(" · ")}`,
    );
  }

  const highlights = rankMovements(input.movements, "highlight").slice(0, TOP_N);
  const lowlights = rankMovements(input.movements, "lowlight").slice(0, TOP_N);
  if (highlights.length > 0) {
    lines.push("", "🟢 **하이라이트**");
    highlights.forEach((movement, index) => lines.push(movementLine(movement, input.refDate, index)));
  }
  if (lowlights.length > 0) {
    lines.push("", "🔴 **로우라이트**");
    lowlights.forEach((movement, index) => lines.push(movementLine(movement, input.refDate, index)));
  }
  if (highlights.length === 0 && lowlights.length === 0) {
    lines.push("", "임계를 넘은 변동 없음");
  }

  // 해설은 목록 뒤에 둔다. 수치를 먼저 보고 해석을 읽는 순서가 맞고, 해설이 빠져도
  // 리포트 구조가 흔들리지 않는다.
  if (input.narrative) lines.push("", `🧠 ${input.narrative}`);

  const tally = (verdict: MovementVerdict) =>
    input.movements.filter((movement) => movement.verdict === verdict).length;
  const absent = tally("absent");
  const judged = input.movements.length - absent;
  lines.push(
    "",
    `판정 ${judged}건 (변동 없음 ${tally("flat")} · 표본 부족 ${tally("insufficient")}) · 미집계 ${absent}건`,
  );
  return lines.join("\n");
}

/** KST 날짜 기준 하루 1건. CronJob 중복 발화가 리포트를 두 번 올리지 않는다. */
export function metricHighlightDedupeKey(refDate: string): string {
  return `metric-highlight:${refDate}`;
}

// ── 수집 ────────────────────────────────────────────────────────────────────

const GA4_METRIC_PICKERS = [
  { key: "ga4_dau", pick: (row: Ga4Row) => row.dau },
  // D1 은 신규 사용자 코호트가 모수다. 코호트가 작으면 판정하지 않는다.
  { key: "ga4_d1", pick: (row: Ga4Row) => row.d1Pct, sample: (row: Ga4Row) => row.newUsers },
  { key: "ga4_ad_completions", pick: (row: Ga4Row) => row.adCompletions },
];

const CONSOLE_METRIC_PICKERS = [
  { key: "console_dau", pick: (row: ConsoleRow) => row.dau },
  { key: "console_iaa", pick: (row: ConsoleRow) => row.iaaEarningKrw },
  { key: "console_iap", pick: (row: ConsoleRow) => row.iapTrxAmountKrw },
];

interface Ga4Row {
  date: Date;
  dau: number;
  newUsers: number;
  d1Pct: number | null;
  adCompletions: number;
}

interface ConsoleRow {
  date: Date;
  dau: number | null;
  iaaEarningKrw: number;
  iapTrxAmountKrw: number;
  raw?: unknown;
}

/** 시계열(최신순) → 지표별 움직임. 최신 행이 없으면 아무것도 만들지 않는다. */
export function movementsFromSeries<T extends { date: Date }>(
  label: string,
  rowsDesc: readonly T[],
  pickers: ReadonlyArray<{
    key: string;
    pick: (row: T) => number | null;
    /** 모수를 요구하는 지표(D1)만 선언한다. 기준선과 같은 창의 중앙값을 쓴다. */
    sample?: (row: T) => number | null;
  }>,
): Movement[] {
  const latest = rowsDesc[0];
  if (!latest) return [];
  const date = isoDate(latest.date);
  return pickers.flatMap(({ key, pick, sample }) => {
    const value = pick(latest);
    if (value == null) return [];
    return [
      evaluateMovement({
        label,
        metricKey: key,
        latest: value,
        baseline: baselineOf(rowsDesc.slice(1).map(pick)),
        ...(sample ? { sample: baselineOf(rowsDesc.map(sample)) } : {}),
        date,
      }),
    ];
  });
}

export interface MetricHighlightResult {
  refDate: string;
  /** 해설이 붙었는지. false = Gemini 미설정이거나 생성 실패(리포트는 정상 발송). */
  narrated: boolean;
  highlights: number;
  lowlights: number;
  observations: number;
  dedupeKey: string;
}

/** 저장된 스냅샷 → 하이라이트·로우라이트 리포트 → 알림 outbox. */
export async function sendMetricHighlightReport(now = new Date()): Promise<MetricHighlightResult> {
  const refDate = isoDate(latestClosedDay(now));
  const apps = await prisma.app.findMany({
    where: visibleAppWhere,
    orderBy: { displayName: "asc" },
    select: {
      id: true,
      slug: true,
      displayName: true,
      firebaseProject: true,
      ga4Dataset: true,
      aitWorkspaceId: true,
      aitMiniAppId: true,
    },
  });

  const movements: Movement[] = [];
  const totals: PortfolioTotals = {
    ga4Dau: { latest: 0, previous: 0, apps: 0 },
    console: { iaaKrw: 0, iapKrw: 0, previousIaaKrw: 0, listings: 0 },
  };
  const consoleRaws: unknown[] = [];

  for (const app of apps.filter((app) => resolveGa4Target(app))) {
    const rows = (await prisma.appMetricDaily.findMany({
      where: { appId: app.id },
      orderBy: { date: "desc" },
      take: BASELINE_DAYS + 1,
      select: { date: true, dau: true, newUsers: true, d1Pct: true, adCompletions: true },
    })) as Ga4Row[];
    // 기준일 스냅샷이 아직 없는 앱은 어제를 말할 수 없다. 합계도 오염시키지 않는다.
    if (rows.length === 0 || isoDate(rows[0].date) !== refDate) continue;
    movements.push(...movementsFromSeries(app.displayName, rows, GA4_METRIC_PICKERS));
    totals.ga4Dau.latest += rows[0].dau;
    totals.ga4Dau.previous = (totals.ga4Dau.previous ?? 0) + (rows[1]?.dau ?? 0);
    totals.ga4Dau.apps += 1;
  }

  for (const app of apps.filter((app) => resolveAitTarget(app))) {
    const listings = listingsForSlug(app.slug);
    const targets = listings.length
      ? listings.map((listing) => ({
          miniAppId: listing.miniAppId,
          // 리스팅이 하나면 라벨이 앱명과 중복이라 생략한다.
          label: listings.length > 1 ? `${app.displayName}(${listing.label})` : app.displayName,
        }))
      : [{ miniAppId: resolveAitTarget(app)!.miniAppId, label: app.displayName }];

    for (const target of targets) {
      const rows = (await prisma.appConsoleMetricDaily.findMany({
        where: { appId: app.id, miniAppId: target.miniAppId },
        orderBy: { date: "desc" },
        take: BASELINE_DAYS + 1,
        select: { date: true, dau: true, iaaEarningKrw: true, iapTrxAmountKrw: true, raw: true },
      })) as ConsoleRow[];
      if (rows.length === 0) continue;
      movements.push(...movementsFromSeries(target.label, rows, CONSOLE_METRIC_PICKERS));
      // 콘솔은 온디맨드 push 라 리스팅마다 최신일이 다르다. 합계는 각 리스팅의
      // 최신 스냅샷을 쓰되, 오래된 값은 각 항목 줄에 기준일이 함께 찍힌다.
      totals.console.iaaKrw += rows[0].iaaEarningKrw;
      totals.console.iapKrw += rows[0].iapTrxAmountKrw;
      totals.console.previousIaaKrw = (totals.console.previousIaaKrw ?? 0) + (rows[1]?.iaaEarningKrw ?? 0);
      totals.console.listings += 1;
      consoleRaws.push(rows[0].raw);
    }
  }

  totals.referrers = foldReferrers(consoleRaws);

  const dedupeKey = metricHighlightDedupeKey(refDate);
  const narrative = await metricNarrative(narrativeFacts({ refDate, totals, movements }));
  await enqueueNotification({
    dedupeKey,
    kind: "OPS_ALERT",
    occurredAt: now,
    payload: {
      text: renderHighlightReport({ refDate, totals, movements, narrative }),
      sender: SEORI_SENDER,
    },
    destinations: discordDestinations(["app-ops"]),
  });

  return {
    refDate,
    narrated: narrative != null,
    highlights: rankMovements(movements, "highlight").length,
    lowlights: rankMovements(movements, "lowlight").length,
    observations: movements.length,
    dedupeKey,
  };
}
