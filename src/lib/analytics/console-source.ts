// AppsInToss 콘솔 지표 소스 경계(포트) + push 수집 계약.
//
// 콘솔 MCP(mcp.toss.im)는 사용자 OAuth 세션으로 인증돼 backoffice pod 가 직접 pull 할 수 없다.
// 따라서 v1 수집은 "인증된 로컬 Claude 세션이 MCP 로 조회 → 정규화 → ingest route 로 push" 한다.
// 아래 ConsoleDailyMetric/ConsoleMetricsPush 가 그 push 계약이다(푸셔·ingest 공용 타입).
//
// 향후 토스가 서비스 자격증명(서버-투-서버 리포팅 API 등)을 제공하면, 같은 스냅샷 형태를 반환하는
// ConsoleMetricsSource 의 HTTP pull 구현을 붙여 pod-side 수집으로 무중단 교체한다 — 스키마 불변.

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
  /** 콘솔 workspaceId(참고용, 저장/검증에 사용하지 않음). */
  workspaceId?: number;
  /** 최근 N일(멱등 재집계). 순서 무관. */
  days: ConsoleDailyMetric[];
}

/** ingest route 로 보내는 push 페이로드 최상위. */
export interface ConsoleMetricsPush {
  apps: ConsoleAppPush[];
}

// ── 향후 pod-side pull 을 위한 소스 포트(현재 미구현) ──────────────────────
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
