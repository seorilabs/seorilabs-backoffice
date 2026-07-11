import type { Ga4Target } from "@/lib/ga4/datasets";
import type { ContentMetricRows } from "@/lib/ga4/content-shapes";
import {
  queryAdPlacementDaily,
  queryAreaDaily,
  queryCropDaily,
  queryFunnelDaily,
} from "@/lib/ga4/content-bigquery";

// 콘텐츠 지표 소스 포트(seam). 수집기는 이 포트에만 의존하고 백엔드 구현을 모른다.
// 현재 구현은 GA4→BigQuery(Ga4ContentMetricsSource)이며, 자체 지표 서버가 준비되면
// 같은 포트를 구현하는 SelfServerContentMetricsSource 로 drop-in 교체/추가할 수 있다.
// (happy-farm 쪽 emission seam: packages/farm-core/src/metricsSink.ts 와 대칭)

export interface ContentMetricsSource {
  /** 앱 대상×기간(YYYYMMDD)의 콘텐츠 지표 원본을 가져온다. */
  fetchContentMetrics(target: Ga4Target, start: string, end: string): Promise<ContentMetricRows>;
}

/** GA4 BigQuery export 기반 구현. 4개 차원 쿼리를 병렬 실행한다. */
export class Ga4ContentMetricsSource implements ContentMetricsSource {
  async fetchContentMetrics(
    target: Ga4Target,
    start: string,
    end: string,
  ): Promise<ContentMetricRows> {
    const [crops, areas, funnels, adPlacements] = await Promise.all([
      queryCropDaily(target, start, end),
      queryAreaDaily(target, start, end),
      queryFunnelDaily(target, start, end),
      queryAdPlacementDaily(target, start, end),
    ]);
    return { crops, areas, funnels, adPlacements };
  }
}

// 기본 소스(현재 GA4). 자체 서버 전환 시 이 한 줄만 교체하면 수집기는 변경 불필요.
export const defaultContentMetricsSource: ContentMetricsSource = new Ga4ContentMetricsSource();
