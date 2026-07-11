// happy-farm 콘텐츠 세부 지표의 순수 타입 + 조립 헬퍼.
// 무거운 의존성(@google-cloud/bigquery, @prisma/client) 없음 → 수집부·소스 어댑터·
// 테스트가 공유한다. 지표 정의 단일 출처는 happy-farm docs/04-work/content-analytics.md.

/** 작물×일자 집계 1행(BigQuery/자체서버 공통 계약). date 는 "YYYY-MM-DD". */
export interface CropDailyRow {
  date: string;
  crop: string;
  planted: number;
  ready: number;
  harvested: number;
  seedSelected: number;
  firstHarvests: number;
  cotdHarvests: number;
  harvesters: number;
  revenue: number;
}

/** 구역×일자 집계 1행. */
export interface AreaDailyRow {
  date: string;
  area: string;
  unlockClicked: number;
  unlocked: number;
  planted: number;
  harvested: number;
  unlockCostSum: number;
}

/** 기능 퍼널×단계×일자 집계 1행. */
export interface FunnelDailyRow {
  date: string;
  funnel: string;
  step: string;
  count: number;
  users: number;
  skips: number;
  stalls: number;
}

/** 광고 placement×일자 집계 1행(정의는 ad-analytics.md 준수). */
export interface AdPlacementDailyRow {
  date: string;
  placement: string;
  impressions: number;
  clicks: number;
  completes: number;
  fails: number;
  failsNotReady: number;
  blocked: number;
}

/** 한 앱의 콘텐츠 지표 원본(윈도우 전체). ContentMetricsSource 반환 계약. */
export interface ContentMetricRows {
  crops: CropDailyRow[];
  areas: AreaDailyRow[];
  funnels: FunnelDailyRow[];
  adPlacements: AdPlacementDailyRow[];
}

/** BigQuery 스칼라/래핑값 → 안전한 number(비유한/누락은 0). */
export function num(v: unknown): number {
  const n =
    typeof v === "object" && v !== null ? Number((v as { value: unknown }).value) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── 파생 지표(대시보드 표시부에서 공유, 0분모 방어) ─────────────────────────

/** 심기→수확 전환율(%, 소수1자리). planted 0 이면 null. */
export function plantToHarvestRate(harvested: number, planted: number): number | null {
  if (planted <= 0) return null;
  return Math.round((harvested / planted) * 1000) / 10;
}

/** 수확당 평균 매출. harvested 0 이면 null. */
export function avgRevenuePerHarvest(revenue: number, harvested: number): number | null {
  if (harvested <= 0) return null;
  return Math.round((revenue / harvested) * 10) / 10;
}

/** 구역 언락 전환율(%, 소수1자리). unlockClicked 0 이면 null. */
export function unlockConversionRate(unlocked: number, unlockClicked: number): number | null {
  if (unlockClicked <= 0) return null;
  return Math.round((unlocked / unlockClicked) * 1000) / 10;
}
