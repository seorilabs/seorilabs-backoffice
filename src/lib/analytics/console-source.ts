import { z } from "zod";
import { parseMetricDay } from "./metric-day";

// AppsInToss 콘솔 지표 소스 경계(포트) + push 수집 계약.
//
// 대화형 push와 승인된 파드 조회가 같은 검증·저장 계약을 사용한다.
// 파드 인증·운영 활성화 조건은 scripts/console-metrics/runbook.md를 따른다.

/** 하루치 콘솔 지표(리스팅×날짜). 승격 스칼라 + 부가 원본(raw). AppConsoleMetricDaily 로 upsert 된다. */
export interface ConsoleDailyMetric {
  /** 기준일 "YYYY-MM-DD"(토스/KST). */
  date: string;
  /**
   * 콘솔 활성 사용자(dashboard_dau.au). null=콘솔 미집계(세션/광고는 있으나 DAU 배열에 부재).
   * 0(=방문 0명)과 구분해야 하므로 값이 없으면 null 로 보낸다(0 으로 채우지 말 것).
   */
  dau?: number | null;
  /** 신규 활성(dashboard_dau.newAu). null=콘솔 미집계. */
  newUsers?: number | null;
  /** 평균 세션 길이 초(dashboard_session.metric). 없으면 null. */
  avgSessionSec?: number | null;
  /** 광고 노출 수(dashboard_revenue_iaa, OS 합). */
  iaaImpressions?: number;
  /** 광고 추정 수익 원(dashboard_revenue_iaa.estimatedEarning, OS 합). */
  iaaEarningKrw?: number;
  /** 인앱결제 거래액 원(dashboard_revenue_iap.trxAmount). */
  iapTrxAmountKrw?: number;
  /** 인앱결제 정산액 원(dashboard_revenue_iap.settlementAmount). */
  iapSettlementKrw?: number;
  /** 결제 사용자 수(dashboard_revenue_iap.pu). */
  payingUsers?: number;
  /**
   * 부가 원본. 승격 컬럼으로 담기 애매한 값들:
   * 유입경로(전체탭/미니앱홈)·연령/성별/OS 분포·OS별 IAA(ecpm 등)·잔존 코호트·앱버전 등.
   * 잔존/데모그래픽은 구간 집계라 보통 윈도우의 마지막 날짜 raw 에만 담는다(푸셔 책임).
   */
  raw?: Record<string, unknown> | null;
}

/**
 * 한 콘솔 리스팅(App×miniApp)의 push 묶음. slug 로 App 을 해석하고, miniAppId 로 리스팅을 구분한다.
 * 한 App 이 여러 리스팅을 가지면(예: crossword-puzzle) 같은 slug + 다른 miniAppId 로 여러 묶음을 보낸다.
 */
export interface ConsoleAppPush {
  /** backoffice App.slug(= repo name). App 해석 1순위. */
  slug?: string;
  /**
   * 콘솔 miniAppId(= 리스팅 키, 필수). 저장 유니크 키 (appId, miniAppId, date)의 일부.
   * slug 미제공 시 App 해석에도 쓰인다. 누락되면 그 묶음은 skip 된다.
   */
  miniAppId?: number;
  /** 콘솔 workspaceId(제공 시 등록된 리스팅과 일치해야 함). */
  workspaceId?: number;
  /** 최근 N일(멱등 재집계). 순서 무관. */
  days: ConsoleDailyMetric[];
}

/** ingest route 로 보내는 push 페이로드 최상위. */
export interface ConsoleMetricsPush {
  apps: ConsoleAppPush[];
}

// ── 승인된 pod-side pull 소스 포트 ──────────────────────
export interface ConsoleSourceTarget {
  slug: string;
  workspaceId: number;
  miniAppId: number;
}

export interface ConsoleMetricsSource {
  /** 대상 앱의 [start,end]("YYYY-MM-DD") 구간 일별 콘솔 지표를 반환한다. */
  queryConsoleMetrics(
    target: ConsoleSourceTarget,
    start: string,
    end: string,
  ): Promise<ConsoleDailyMetric[]>;
}

export const MAX_DAYS_PER_APP = 120;
const count = z.number().finite().int().nonnegative();
const amount = z.number().finite();
const daySchema = z.object({
  date: z.string().refine((value) => parseMetricDay(value) !== null),
  dau: count.nullish(), newUsers: count.nullish(), avgSessionSec: amount.nonnegative().nullish(),
  iaaImpressions: count, iaaEarningKrw: amount, iapTrxAmountKrw: amount, iapSettlementKrw: amount, payingUsers: count,
  raw: z.record(z.unknown()).nullish(),
});
const SECRET_KEY = /^(?:access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret|cookie|api[_-]?key)$/i;
export function containsConsoleSecret(value: unknown): boolean {
  return !!value && typeof value === "object" && Object.entries(value).some(([key, child]) => SECRET_KEY.test(key) || containsConsoleSecret(child));
}
export function validateConsoleDay(value: unknown) {
  const result = daySchema.safeParse(value);
  if (!result.success) return { ok: false as const, fields: [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "day")))] };
  if (containsConsoleSecret(result.data.raw)) return { ok: false as const, fields: ["raw.credentials"] };
  return { ok: true as const, day: result.data };
}
