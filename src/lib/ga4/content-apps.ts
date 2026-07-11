// 콘텐츠 세부 지표 대상 앱 레지스트리.
// 공통 지표(AppMetricDaily)는 모든 GA4 대상 앱이 받지만, 콘텐츠 세부 지표는 앱마다
// 이벤트/콘텐츠 차원이 다르므로 "콘텐츠 지표를 구현한 앱"만 명시적으로 편입한다.
// 지금은 happy-farm 전용이며, 다른 게임이 콘텐츠 계측을 추가하면 여기에 등록한다.

export interface ContentMetricsApp {
  /** App.slug. resolveGa4Target 로 GA4 대상 여부를 함께 확인한다. */
  slug: string;
  /** 대시보드 라벨(콘텐츠 지표 섹션 제목 등). */
  label: string;
}

export const CONTENT_METRICS_APPS: ContentMetricsApp[] = [
  { slug: "happy-farm", label: "행복한 농장" },
  { slug: "foam-party", label: "버블버블 폼파티" },
];

const BY_SLUG = new Map(CONTENT_METRICS_APPS.map((a) => [a.slug, a]));

/** slug 가 콘텐츠 세부 지표 대상인지. */
export function isContentMetricsApp(slug: string): boolean {
  return BY_SLUG.has(slug);
}

export function getContentMetricsApp(slug: string): ContentMetricsApp | null {
  return BY_SLUG.get(slug) ?? null;
}
