import type { AppContentSpec } from "@/lib/analytics/content-spec";

// 컨텐츠 지표 소스 경계(포트). 지금은 GA4/BigQuery 구현(ga4ContentSource)이지만,
// 향후 자체 지표 서버가 서면 같은 인터페이스의 HTTP 구현으로 무중단 교체한다.
// 수집부(content-metrics-collect)는 이 인터페이스에만 의존한다.

/** 소스 조회 대상. GA4 구현은 firebaseProject+dataset 을, 자체 서버 구현은 slug 를 쓴다. */
export interface ContentSourceTarget {
  slug: string;
  firebaseProject: string | null;
  dataset: string | null;
}

/** 분포 한 항목: 값 k 의 이벤트 수(count)와 고유 사용자 수(users). */
export interface ContentDistItem {
  k: string;
  count: number;
  users: number;
}

/** 카운터 한 항목: 이벤트 수와 고유 사용자 수. */
export interface ContentCounter {
  count: number;
  users: number;
}

/** 하루치 컨텐츠 지표 스냅샷(앱×날짜). AppContentMetricDaily.raw 에 저장된다. */
export interface ContentMetricSnapshot {
  /** distribution key → top-N 값 분포(count 내림차순). */
  distributions: Record<string, ContentDistItem[]>;
  /** counter key → 발생 수/사용자. */
  counters: Record<string, ContentCounter>;
  /** measure key → 집계값(데이터 없으면 null). */
  measures: Record<string, number | null>;
  /** 그 날 스펙 이벤트 총 발생 수(수집 유효성 판단용). */
  totalEvents: number;
}

/** date("YYYY-MM-DD") → 스냅샷. */
export type ContentMetricByDate = Record<string, ContentMetricSnapshot>;

export interface ContentMetricsSource {
  /** 대상 앱의 [start,end]("YYYYMMDD") 구간 컨텐츠 지표를 날짜별로 집계한다. */
  queryContentMetrics(
    target: ContentSourceTarget,
    spec: AppContentSpec,
    start: string,
    end: string,
  ): Promise<ContentMetricByDate>;
}
