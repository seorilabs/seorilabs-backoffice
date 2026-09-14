import type { AppType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveGa4Target } from "@/lib/ga4/datasets";
import {
  dbDay,
  lastElapsedMetricDay,
  metricDaysBetween,
  shiftMetricDay,
  toDbDay,
} from "@/lib/analytics/metric-day";
import { metricAsOf } from "@/lib/analytics/coverage";
import type { AsOfResolution } from "@/lib/analytics/as-of";
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
/**
 * 콘솔 합계에 넣을 수 있는 스냅샷의 최대 나이(일). 콘솔은 cron 이 아니라 사람·에이전트
 * push 라 리스팅마다 최신일이 다르고, 지금 실측으로 1~21일까지 벌어져 있다. 나이를
 * 따지지 않고 각 리스팅의 최신 행을 더하면 21일 지난 수익이 매일 "오늘 합계"에 다시
 * 계상된다. 평평하다가 push 가 오면 튀는 선이 그렇게 만들어졌다.
 */
export const CONSOLE_STALE_DAYS = 3;
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
  /**
   * 기준일 GA4 DAU 합과 그 전날 합. 전날은 "직전 행"이 아니라 정확히 하루 전이며,
   * 합계에 든 앱 중 하나라도 그 날 행이 없으면 null 이다 — 일부만 센 전날과
   * 비교하면 변화율이 실제보다 부풀고, 그것이 헤드라인에 그대로 나간다.
   */
  ga4Dau: { latest: number; previous: number | null; apps: number };
  /** 콘솔 광고 수익·결제 거래액 합(CONSOLE_STALE_DAYS 안의 스냅샷을 가진 리스팅만). */
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
  /** 기준일 커버리지. 주면 확정/잠정과 분모를 함께 싣는다. */
  asOf?: AsOfResolution | null;
  /** 기준일 스냅샷이 없는 앱 이름(표시용). */
  gapNames?: readonly string[];
  /** 스냅샷이 오래돼 합계에서 뺀 콘솔 리스팅("라벨(날짜)"). */
  consoleStale?: readonly string[];
  /** LLM 해설(선택). 생성 실패 시 없이 나간다 — 리포트를 LLM 가용성에 묶지 않는다. */
  narrative?: string | null;
  /** 백오피스 Org 종합 보고서 링크(선택). 없으면 푸터를 생략한다. */
  reportUrl?: string | null;
  /** 정정 안내 한 줄(선택). 수치가 갱신됐을 때만 붙는다. */
  correction?: string | null;
}): string {
  const { totals, asOf } = input;
  // "(D-1)" 을 머리말에 박아 두면 소급 재계산이나 기준일이 밀린 날에도 어제라고 적힌다.
  // 날짜와 확정 여부만 적고, 판단 재료는 아래 커버리지 줄이 든다.
  const stamp = asOf == null ? "" : asOf.verdict === "final" ? " · 확정" : " · 잠정";
  const lines = [`📈 **${SENDER_KO} 지표 하이라이트 · ${input.refDate}${stamp}**`];
  // 분자는 실제로 합계에 들어간 앱 수다. 원장 관측 수를 쓰면 지표 표와 원장이
  // 어긋난 순간 수치와 설명이 따로 논다.
  const appScope = asOf == null
    ? ` · 대상 ${totals.ga4Dau.apps}개 앱`
    : ` · 대상 ${totals.ga4Dau.apps}/${asOf.expected}개 앱`;
  lines.push(
    totalLine(
      "GA4 DAU 합계",
      `${totals.ga4Dau.latest.toLocaleString("ko-KR")}명`,
      totals.ga4Dau.previous == null ? null : `${totals.ga4Dau.previous.toLocaleString("ko-KR")}명`,
      pctChange(totals.ga4Dau.latest, totals.ga4Dau.previous),
    ) + appScope,
  );
  // 낮은 합계를 실제 감소로 읽지 않으려면 무엇이 빠졌는지가 같은 화면에 있어야 한다.
  const gaps = input.gapNames ?? [];
  if (gaps.length > 0) {
    lines.push(`⚠️ 기준일 미관측 ${gaps.length}개: ${gaps.slice(0, 6).join(", ")}` +
      (gaps.length > 6 ? ` 외 ${gaps.length - 6}개` : ""));
  }
  const stale = input.consoleStale ?? [];
  if (stale.length > 0) {
    lines.push(`⏳ 콘솔 합계 제외(${CONSOLE_STALE_DAYS}일 초과) ${stale.length}개: ${stale.slice(0, 6).join(", ")}` +
      (stale.length > 6 ? ` 외 ${stale.length - 6}개` : ""));
  }
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
  // 정정은 맨 끝에 둔다. 무엇이 바뀌었는지가 수치 바로 아래가 아니라 읽고 난 뒤에
  // 와야 "원래 이랬는데 이렇게 바뀌었다"로 읽힌다.
  if (input.correction) lines.push("", input.correction);
  if (input.reportUrl) lines.push("", `🔗 ${input.reportUrl}`);
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

export interface Ga4Row {
  date: Date;
  dau: number;
  newUsers: number;
  d1Pct: number | null;
  adCompletions: number;
  engagedUsers: number;
  dauAndroid: number;
  dauIos: number;
  dauWeb: number;
}

export interface ConsoleRow {
  date: Date;
  dau: number | null;
  newUsers: number | null;
  iaaEarningKrw: number;
  iapTrxAmountKrw: number;
  iapSettlementKrw: number;
  payingUsers: number;
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
  const date = dbDay(latest.date);
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
  /** 실제로 나간 본문. 사람이 읽는 결과물이다. */
  body: string;
  /** outbox event id. 정정이 같은 전송을 되돌려 메시지를 고치는 데 쓴다. */
  eventId: string;
}

/** GA4 수집 대상 앱 하나의 시계열(최신순, BASELINE_DAYS+1 창). 최신 행은 기준일 값이다. */
/**
 * 기준일 스냅샷이 없어 판정에서 빠진 앱. 합계에 넣을 수는 없지만 "왜 빠졌는지"는
 * 남겨야 한다. 합계가 낮은 것이 지표 하락인지 수집 공백인지 여기서 갈린다.
 */
export interface Ga4AppGap {
  app: { id: string; slug: string; displayName: string; type: AppType };
  /** 가장 최근 스냅샷 날짜. 수집이 한 번도 없으면 null. */
  latestDate: Date | null;
}

export interface Ga4AppSeries {
  app: { id: string; slug: string; displayName: string; type: AppType };
  rowsDesc: Ga4Row[];
}

/** 콘솔 리스팅 하나의 시계열(최신순). 온디맨드 push 라 최신 행의 날짜가 기준일보다 늦을 수 있다. */
export interface ConsoleListingSeries {
  app: { id: string; slug: string; displayName: string; type: AppType };
  miniAppId: number;
  /** 리포트 표기용 라벨. 다중 리스팅이면 "앱명(리스팅)" 형태. */
  label: string;
  /** 다중 리스팅 구분 라벨(단일 리스팅이면 null). */
  listingLabel: string | null;
  rowsDesc: ConsoleRow[];
}

/**
 * 하이라이트 판정에 쓰인 적재·판정 결과 일체. Discord 리포트와 Org 종합 보고서 스냅샷이
 * 같은 계산 결과를 공유하기 위해 원시 시계열까지 함께 담는다(재질의 없이 분해 생성).
 */
export interface HighlightData {
  refDate: string;
  /**
   * 기준일 커버리지 판정. 수치 옆에 "무엇을 못 셌는가"가 함께 있어야 낮은 합계를
   * 실제 감소로 읽지 않는다. 원장이 없으면(아직 백필 전) null.
   */
  asOf: AsOfResolution | null;
  totals: PortfolioTotals;
  movements: Movement[];
  ga4Series: Ga4AppSeries[];
  /** 기준일 스냅샷이 없어 ga4Series 에 들어가지 못한 앱. */
  ga4Gaps: Ga4AppGap[];
  consoleSeries: ConsoleListingSeries[];
  /** 콘솔 대상이지만 push 수집이 한 번도 없는 리스팅 라벨. */
  consoleMissing: string[];
  /** 스냅샷이 CONSOLE_STALE_DAYS 를 넘겨 합계에서 뺀 리스팅("라벨(날짜)"). */
  consoleStale: string[];
}

/**
 * 저장된 GA4·콘솔 스냅샷을 읽어 판정까지 마친다. refDateOverride 를 주면 그 날짜를
 * 기준일로 하는 소급 계산이 된다(과거 날짜 보고서 재계산·수동 재발행용).
 */
export async function collectHighlightData(
  now: Date,
  refDateOverride?: string,
): Promise<HighlightData> {
  const refDate = refDateOverride ?? lastElapsedMetricDay(now);
  const previousDay = shiftMetricDay(refDate, -1);
  const upTo = toDbDay(refDate);
  const { ga4: resolved } = await metricAsOf({ now, requested: refDate });
  // 원장이 그 날을 아직 하나도 모르면(백필 전·신규 배포 직후) 커버리지를 주장하지
  // 않는다. 0/9 로 적으면 실제로 센 앱이 있는데도 아무것도 못 센 것처럼 보인다.
  const ledgerKnowsDay = resolved != null
    && resolved.missing.some((one) => one.state !== "unobserved");
  const asOf = resolved != null && (resolved.observed > 0 || ledgerKnowsDay) ? resolved : null;
  const apps = await prisma.app.findMany({
    where: visibleAppWhere,
    orderBy: { displayName: "asc" },
    select: {
      id: true,
      slug: true,
      displayName: true,
      type: true,
      firebaseProject: true,
      ga4Dataset: true,
      aitWorkspaceId: true,
      aitMiniAppId: true,
    },
  });

  const movements: Movement[] = [];
  // 전일 합은 "합계에 든 앱 전부가 그 날 행을 가졌을 때"만 낸다. 하나라도 빠지면
  // 비교 자체가 성립하지 않으므로 null 로 두고 렌더러가 전일 문구를 생략한다.
  let previousComplete = true;
  let previousSum = 0;
  let consolePreviousComplete = true;
  let consolePreviousSum = 0;
  const totals: PortfolioTotals = {
    ga4Dau: { latest: 0, previous: 0, apps: 0 },
    console: { iaaKrw: 0, iapKrw: 0, previousIaaKrw: 0, listings: 0 },
  };
  const consoleRaws: unknown[] = [];
  const ga4Series: Ga4AppSeries[] = [];
  const ga4Gaps: Ga4AppGap[] = [];
  const consoleSeries: ConsoleListingSeries[] = [];
  const consoleMissing: string[] = [];
  /** 스냅샷이 너무 오래돼 합계에서 뺀 리스팅. 줄에는 남지만 합계에는 없다. */
  const consoleStale: string[] = [];

  for (const app of apps.filter((app) => resolveGa4Target(app))) {
    const rows = (await prisma.appMetricDaily.findMany({
      where: { appId: app.id, date: { lte: upTo } },
      orderBy: { date: "desc" },
      take: BASELINE_DAYS + 1,
      select: {
        date: true,
        dau: true,
        newUsers: true,
        d1Pct: true,
        adCompletions: true,
        engagedUsers: true,
        dauAndroid: true,
        dauIos: true,
        dauWeb: true,
      },
    })) as Ga4Row[];
    // 기준일 스냅샷이 아직 없는 앱은 어제를 말할 수 없다. 합계도 오염시키지 않는다.
    // 다만 빠졌다는 사실은 남긴다 — 합계가 낮은 이유가 될 수 있다.
    if (rows.length === 0 || dbDay(rows[0].date) !== refDate) {
      ga4Gaps.push({
        app: { id: app.id, slug: app.slug, displayName: app.displayName, type: app.type },
        latestDate: rows[0]?.date ?? null,
      });
      continue;
    }
    movements.push(...movementsFromSeries(app.displayName, rows, GA4_METRIC_PICKERS));
    totals.ga4Dau.latest += rows[0].dau;
    totals.ga4Dau.apps += 1;
    // rows[1] 은 "직전 행"이지 "전날"이 아니다. D-2 가 비면 D-3 과 비교하면서
    // 화면에는 "전일"이라고 적히던 것을 날짜로 맞춘다.
    const yesterday = rows.find((row) => dbDay(row.date) === previousDay);
    if (yesterday) previousSum += yesterday.dau;
    else previousComplete = false;
    ga4Series.push({
      app: { id: app.id, slug: app.slug, displayName: app.displayName, type: app.type },
      rowsDesc: rows,
    });
  }

  for (const app of apps.filter((app) => resolveAitTarget(app))) {
    const listings = listingsForSlug(app.slug);
    const targets = listings.length
      ? listings.map((listing) => ({
          miniAppId: listing.miniAppId,
          // 리스팅이 하나면 라벨이 앱명과 중복이라 생략한다.
          label: listings.length > 1 ? `${app.displayName}(${listing.label})` : app.displayName,
          listingLabel: listings.length > 1 ? listing.label : null,
        }))
      : [{ miniAppId: resolveAitTarget(app)!.miniAppId, label: app.displayName, listingLabel: null }];

    for (const target of targets) {
      const rows = (await prisma.appConsoleMetricDaily.findMany({
        where: { appId: app.id, miniAppId: target.miniAppId, date: { lte: upTo } },
        orderBy: { date: "desc" },
        take: BASELINE_DAYS + 1,
        select: {
          date: true,
          dau: true,
          newUsers: true,
          iaaEarningKrw: true,
          iapTrxAmountKrw: true,
          iapSettlementKrw: true,
          payingUsers: true,
          raw: true,
        },
      })) as ConsoleRow[];
      if (rows.length === 0) {
        consoleMissing.push(target.label);
        continue;
      }
      movements.push(...movementsFromSeries(target.label, rows, CONSOLE_METRIC_PICKERS));
      // 콘솔은 온디맨드 push 라 리스팅마다 최신일이 다르다. 오래된 스냅샷은 합계에서
      // 빼고 줄에만 남긴다 — 21일 지난 수익을 매일 다시 더하면 선이 평평하다가
      // push 가 온 날 튄다.
      const staleDays = metricDaysBetween(refDate, dbDay(rows[0].date));
      if (staleDays <= CONSOLE_STALE_DAYS) {
        totals.console.iaaKrw += rows[0].iaaEarningKrw;
        totals.console.iapKrw += rows[0].iapTrxAmountKrw;
        totals.console.listings += 1;
        consoleRaws.push(rows[0].raw);
        const yesterday = rows.find(
          (row) => metricDaysBetween(dbDay(rows[0].date), dbDay(row.date)) === 1,
        );
        if (yesterday) consolePreviousSum += yesterday.iaaEarningKrw;
        else consolePreviousComplete = false;
      } else {
        consoleStale.push(`${target.label}(${dbDay(rows[0].date)})`);
      }
      consoleSeries.push({
        app: { id: app.id, slug: app.slug, displayName: app.displayName, type: app.type },
        miniAppId: target.miniAppId,
        label: target.label,
        listingLabel: target.listingLabel,
        rowsDesc: rows,
      });
    }
  }

  totals.referrers = foldReferrers(consoleRaws);
  totals.ga4Dau.previous = previousComplete && totals.ga4Dau.apps > 0 ? previousSum : null;
  totals.console.previousIaaKrw =
    consolePreviousComplete && totals.console.listings > 0 ? consolePreviousSum : null;

  return {
    refDate,
    asOf,
    totals,
    movements,
    ga4Series,
    ga4Gaps,
    consoleSeries,
    consoleMissing,
    consoleStale,
  };
}

export interface MetricHighlightOptions {
  /** 이미 적재·판정을 마친 데이터. 주면 재계산 없이 그대로 발송한다(Org 보고서와 공유). */
  data?: HighlightData;
  /** LLM 해설. undefined 면 여기서 생성하고, null 이면 해설 없이 발송한다. */
  narrative?: string | null;
  /** 백오피스 Org 종합 보고서 링크. 없으면 푸터를 생략한다. */
  reportUrl?: string | null;
  /** 정정 안내 한 줄. 조용히 달라지면 읽는 사람이 자기 기억을 의심한다. */
  correction?: string | null;
}

/**
 * 저장된 스냅샷 → 하이라이트·로우라이트 리포트 → 알림 outbox.
 *
 * payload 에 editable 을 실어 워커가 같은 메시지를 고치게 한다. 늦게 도착한 수집을
 * 반영해 수치가 바뀌었을 때 새 메시지를 보내면 어느 쪽이 맞는지 읽는 사람이 모른다.
 */
export async function sendMetricHighlightReport(
  now = new Date(),
  options: MetricHighlightOptions = {},
): Promise<MetricHighlightResult> {
  const data = options.data ?? (await collectHighlightData(now));
  const { refDate, totals, movements } = data;

  const dedupeKey = metricHighlightDedupeKey(refDate);
  const narrative =
    options.narrative !== undefined
      ? options.narrative
      : await metricNarrative(narrativeFacts(data));
  const body = renderHighlightReport({
    refDate,
    totals,
    movements,
    asOf: data.asOf,
    gapNames: data.ga4Gaps.map((gap) => gap.app.displayName),
    consoleStale: data.consoleStale,
    narrative,
    reportUrl: options.reportUrl,
    correction: options.correction,
  });
  const eventId = await enqueueNotification({
    dedupeKey,
    kind: "OPS_ALERT",
    occurredAt: now,
    payload: { text: body, sender: SEORI_SENDER, editable: true },
    destinations: discordDestinations(["app-ops"]),
  });

  return {
    refDate,
    narrated: narrative != null,
    highlights: rankMovements(movements, "highlight").length,
    lowlights: rankMovements(movements, "lowlight").length,
    observations: movements.length,
    dedupeKey,
    body,
    eventId,
  };
}
