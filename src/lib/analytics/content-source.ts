import type { AppContentSpec } from "@/lib/analytics/content-spec";

// 컨텐츠 지표 소스 경계(포트). 지금은 GA4/BigQuery 구현(ga4ContentSource)이지만,
// 향후 자체 지표 서버가 서면 같은 인터페이스의 HTTP 구현으로 무중단 교체한다.
// 수집부(app-content-metrics-collect)는 이 인터페이스에만 의존한다.

/** 소스 조회 대상. GA4 구현은 firebaseProject+dataset 을, 자체 서버 구현은 slug 를 쓴다. */
export interface ContentSourceTarget {
  slug: string;
  firebaseProject: string | null;
  dataset: string | null;
}

/** 통합('all') 마켓 식별자. 마켓 미선언 스펙은 이 단일 마켓만 쓴다. */
export const MARKET_ALL = "all";

/** 지표 한 값: 집계값(value)과 고유 사용자 수(users, count 종류에서만 채워짐). */
export interface ContentMetricValue {
  /** 집계 결과. 데이터 없으면 null(avg/sum) 또는 0(count). */
  value: number | null;
  /** 고유 사용자 수(agg=count 일 때만). 그 외 undefined. */
  users?: number;
}

/** 분포 한 항목: 값 k 의 이벤트 수(count)와 고유 사용자 수(users). */
export interface ContentDistItem {
  k: string;
  count: number;
  users: number;
}

/**
 * 하루치·한 마켓 컨텐츠 지표 스냅샷(앱×날짜×마켓). AppContentMetricDaily.raw 에 저장된다.
 * 지표 구성은 앱마다 다르므로 고정 컬럼이 아니라 스펙 key 로 인덱싱한 맵으로 담는다.
 */
export interface ContentMetricSnapshot {
  /** metric key → 집계값(+users). */
  metrics: Record<string, ContentMetricValue>;
  /** distribution key → top-N 값 분포(count 내림차순). */
  distributions: Record<string, ContentDistItem[]>;
  /** group key → 그룹 값 → metric key → 집계값(+users). */
  groups: Record<string, Record<string, Record<string, ContentMetricValue>>>;
  /** 그 날 스펙 이벤트 총 발생 수(수집 유효성 판단용). */
  totalEvents: number;
}

/** date("YYYY-MM-DD") → 스냅샷(한 마켓 기준). */
export type ContentMetricByDate = Record<string, ContentMetricSnapshot>;

/** market → (date → 스냅샷). 마켓 미선언 스펙은 MARKET_ALL 키 하나만 담는다. */
export type ContentMetricByMarket = Record<string, ContentMetricByDate>;

export interface ContentMetricsSource {
  /**
   * 대상 앱의 [start,end]("YYYYMMDD") 구간 컨텐츠 지표를 마켓×날짜별로 집계한다.
   * 마켓 미선언 스펙은 MARKET_ALL 마켓 하나만, 선언 스펙은 각 마켓 + MARKET_ALL(통합)을 담는다.
   */
  queryContentMetrics(
    target: ContentSourceTarget,
    spec: AppContentSpec,
    start: string,
    end: string,
  ): Promise<ContentMetricByMarket>;
}
