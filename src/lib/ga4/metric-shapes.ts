// GA4 지표 차원 분해(플랫폼/국가/기기·OS)의 순수 타입 + 헬퍼.
// 무거운 의존성(@google-cloud/bigquery 등) 없음 → 서버 수집부·클라 표시부·테스트가 공유.

export interface DimCount {
  /** 차원 값(국가코드/OS문자열/기기카테고리 등). */
  k: string;
  /** 그 값의 고유 사용자 수(DAU). */
  dau: number;
}

/** AppMetricDaily.raw 에 저장하는 차원 분해(각 top-N, dau 내림차순). */
export interface MetricBreakdowns {
  countries?: DimCount[];
  osVersions?: DimCount[];
  devices?: DimCount[];
}

/** BigQuery 차원 분해 쿼리의 한 행(날짜×차원×값의 DAU). */
export interface Ga4BreakdownRow {
  date: string; // "YYYY-MM-DD"
  dim: string; // 'platform' | 'country' | 'os' | 'device'
  val: string;
  dau: number;
}

/** 한 날짜의 dim → (val → dau) 맵. */
export type DayDims = Record<string, Record<string, number>>;

/** 차원 분해 행들을 date → dim → val → dau 로 피벗. */
export function pivotBreakdownRows(rows: Ga4BreakdownRow[]): Record<string, DayDims> {
  const out: Record<string, DayDims> = {};
  for (const r of rows) {
    const day = (out[r.date] ??= {});
    const dim = (day[r.dim] ??= {});
    dim[r.val] = (dim[r.val] ?? 0) + r.dau;
  }
  return out;
}

/** val→dau 맵에서 상위 n개(dau 내림차순, 동률은 key 사전순). */
export function topN(m: Record<string, number> | undefined, n: number): DimCount[] {
  if (!m) return [];
  return Object.entries(m)
    .map(([k, dau]) => ({ k, dau }))
    .sort((a, b) => b.dau - a.dau || a.k.localeCompare(b.k))
    .slice(0, n);
}

/** platform dim 맵 → android/ios/web DAU(GA4 platform 값은 대문자). */
export function platformDau(
  m: Record<string, number> | undefined,
): { android: number; ios: number; web: number } {
  return {
    android: m?.["ANDROID"] ?? 0,
    ios: m?.["IOS"] ?? 0,
    web: m?.["WEB"] ?? 0,
  };
}

/** 한 날짜의 dims → 저장용(전용 플랫폼 컬럼 + raw JSON 차원 top-N). */
export function buildDayBreakdown(
  dims: DayDims | undefined,
  topCount = 6,
): { dauAndroid: number; dauIos: number; dauWeb: number; raw: MetricBreakdowns } {
  const p = platformDau(dims?.["platform"]);
  return {
    dauAndroid: p.android,
    dauIos: p.ios,
    dauWeb: p.web,
    raw: {
      countries: topN(dims?.["country"], topCount),
      osVersions: topN(dims?.["os"], topCount),
      devices: topN(dims?.["device"], topCount),
    },
  };
}

/** 참여율(활성사용자/DAU %). dau 0 이면 null. */
export function engagementRate(engagedUsers: number, dau: number): number | null {
  if (dau <= 0) return null;
  return Math.round((engagedUsers / dau) * 1000) / 10;
}

// 수집 조립용 최소 활동/잔존 필드(BigQuery Ga4DailyRow·clampRetention 결과의 부분집합).
export interface DailyActivityCore {
  dau: number;
  newUsers: number;
  engagedUsers: number;
  avgEngageSec: number | null;
  adEventUsers: number;
  adImpressions: number;
  adCtaUsers: number;
  adCtaImpressions: number;
  adCompletedUsers: number;
  adCompletions: number;
  networkAdUsers: number;
  networkAdImpressions: number;
}
export interface RetentionCore {
  d1Pct: number | null;
  d3Pct: number | null;
  d7Pct: number | null;
}

/**
 * 활동+잔존+차원분해 → AppMetricDaily upsert 데이터(순수, collectedAt 제외).
 * 플랫폼 DAU 전용 컬럼과 국가/기기/OS top-N raw JSON 배치를 잠근다.
 */
export function assembleDailyMetric(
  activity: DailyActivityCore,
  retention: RetentionCore,
  dims: DayDims | undefined,
): DailyActivityCore &
  RetentionCore & { dauAndroid: number; dauIos: number; dauWeb: number; raw: MetricBreakdowns } {
  const bd = buildDayBreakdown(dims);
  return {
    dau: activity.dau,
    newUsers: activity.newUsers,
    engagedUsers: activity.engagedUsers,
    avgEngageSec: activity.avgEngageSec,
    adEventUsers: activity.adEventUsers,
    adImpressions: activity.adImpressions,
    adCtaUsers: activity.adCtaUsers,
    adCtaImpressions: activity.adCtaImpressions,
    adCompletedUsers: activity.adCompletedUsers,
    adCompletions: activity.adCompletions,
    networkAdUsers: activity.networkAdUsers,
    networkAdImpressions: activity.networkAdImpressions,
    dauAndroid: bd.dauAndroid,
    dauIos: bd.dauIos,
    dauWeb: bd.dauWeb,
    raw: bd.raw,
    d1Pct: retention.d1Pct,
    d3Pct: retention.d3Pct,
    d7Pct: retention.d7Pct,
  };
}

// 핵심 지표 카드용 최소 필드(표시부 MetricDaily 가 satisfy).
export interface CoreMetricCard {
  dau: number;
  newUsers: number;
  engagedUsers: number;
  avgEngageSec: number | null;
  d1Pct: number | null;
  d7Pct: number | null;
  adCtaImpressions: number;
  adCompletions: number;
  networkAdImpressions: number;
}

const pctLabel = (v: number | null): string => (v == null ? "—" : `${v}%`);

/** 핵심 지표 카드 배열(순수, 라벨/포맷 잠금). engagement→활성사용자, 참여율 신규. */
export function buildMetricCards(m: CoreMetricCard): { label: string; value: string | number }[] {
  return [
    { label: "DAU", value: m.dau },
    { label: "신규", value: m.newUsers },
    { label: "활성사용자", value: `${m.engagedUsers}명` },
    { label: "참여율", value: pctLabel(engagementRate(m.engagedUsers, m.dau)) },
    { label: "D1 잔존", value: pctLabel(m.d1Pct) },
    { label: "D7 잔존", value: pctLabel(m.d7Pct) },
    { label: "평균 참여", value: m.avgEngageSec == null ? "—" : `${m.avgEngageSec}s` },
    { label: "광고 CTA 노출", value: m.adCtaImpressions },
    { label: "광고 완료", value: m.adCompletions },
    { label: "실제 광고 노출", value: m.networkAdImpressions },
  ];
}

export interface PlatformSeg {
  label: string;
  value: number;
  pct: number; // 전체 대비 %(정수)
}

/**
 * 플랫폼 DAU → 0 초과 세그먼트 + 총합(순수). total===0 이면 세그먼트 빈 배열 →
 * 표시부는 안내 문구로 분기(NaN width 진입 불가).
 */
export function platformSegments(
  android: number,
  ios: number,
  web: number,
): { segs: PlatformSeg[]; total: number } {
  const raw = [
    { label: "Android", value: android },
    { label: "iOS", value: ios },
    { label: "Web", value: web },
  ].filter((s) => s.value > 0);
  const total = raw.reduce((n, s) => n + s.value, 0);
  const segs = raw.map((s) => ({ ...s, pct: total > 0 ? Math.round((s.value / total) * 100) : 0 }));
  return { segs, total };
}
