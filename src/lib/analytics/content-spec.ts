// 앱별 컨텐츠 지표 스펙(엔진/소스 독립, 순수 타입). 각 앱은 자기 컨텐츠 이벤트를 이
// 스펙으로 선언하고, 수집부(app-content-metrics-collect)와 GA4 구현(ga4-content-source)이
// 스펙을 해석해 집계한다. 이벤트 이름/파라미터 키는 각 게임의 클린아키텍처 컨텐츠
// 이벤트 카탈로그와 1:1.
//
// 이 스펙 하나로 모든 게임의 컨텐츠 지표를 표현한다(happy-farm/foam/crossword 도 이 스펙으로
// 이관). 게임별 스펙은 specs/<slug>.ts 로 각자 파일에 두고, 레지스트리(content-registry)는
// slug→spec 한 줄만 추가한다(충돌 표면 최소화). 표현 요소:
//   - metrics:       앱 전체 단위 단일 지표(카운트/고유사용자/합/평균) 카드. 파라미터 조건 필터 가능.
//   - distributions: 파라미터 값 분포(top-N 막대). 예: outcome → win/loss/draw 비중.
//   - groups:        브레이크다운 표/퍼널(그룹 키별 여러 지표). 예: 레벨별 시작/완료/평균시간.
//   - derived:       다른 지표 key 로 계산하는 파생 비율 카드(뷰 전용). 예: 완료율 = 완료/시작.
//   - market:        선언 시 마켓별 + 통합('all') 행으로 저장/조회. 미선언이면 'all' 단일.

/** 지표 집계 방식. count=이벤트수, users=고유사용자수, sum/avg=param 수치 집계. */
export type ContentAgg = "count" | "users" | "sum" | "avg";

/**
 * event_param 조건 필터(조건부 집계). 예: reason='not_ready', is_first=1.
 * op="truthy" 는 불리언 파라미터가 참인지 검사한다(웹/RN Firebase SDK 가 string 'true'/'1'
 * 또는 int 1 로 export 하는 두 형식을 모두 허용). truthy 는 value 를 쓰지 않는다.
 */
export interface ContentPredicate {
  param: string;
  op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "truthy";
  /** 비교값. 문자열이면 string_value, 숫자면 수치값과 비교. truthy 에서는 무시(생략 가능). */
  value?: string | number;
}

/**
 * 단일 지표 정의(앱 전체 또는 group 내부에서 재사용). agg 별 의미:
 *   - count: COUNT(*) (+ 고유사용자 users)
 *   - users: COUNT(DISTINCT user)
 *   - sum:   SUM(param)
 *   - avg:   AVG(param)
 * where 가 있으면 그 조건을 만족하는 이벤트만 집계한다(조건부 COUNTIF/SUMIF).
 */
export interface ContentMetricSpec {
  key: string;
  label: string;
  /** GA4 event_name. 배열이면 여러 이벤트 합산(예: seed_selected + first_seed_selected). */
  event: string | string[];
  agg: ContentAgg;
  /** sum/avg 필수(수치 param). count/users 에서는 무시. */
  param?: string;
  /** 조건부 집계 필터(AND 결합). */
  where?: ContentPredicate[];
  /** 표시 단위(예: "수", "초", "원"). */
  unit?: string;
  /** 반올림 소수 자리(sum/avg, 기본 1). */
  round?: number;
}

/** 이벤트 파라미터 값 분포(top-N). 예: game_end.outcome → win/loss/draw 비중. */
export interface ContentDistributionSpec {
  /** 지표 식별 키(저장/표시). 예: "outcome". */
  key: string;
  /** 표시 라벨. 예: "게임 결과". */
  label: string;
  /** GA4 event_name. 예: "game_end". */
  event: string;
  /** event_param 키. 예: "outcome". */
  param: string;
  /** 상위 N개 값(기본 8). */
  topN?: number;
  /** 표시용 값 라벨 매핑(예: win→승). 없으면 원값 그대로 표시. */
  valueLabels?: Record<string, string>;
  /** 조건부 필터(선택). */
  where?: ContentPredicate[];
}

/**
 * 브레이크다운(그룹) 지표. 한 파라미터(param) 값별로 여러 지표(metrics)를 집계한다.
 * 레벨별/작물별/난이도별/구역별/placement별 등 "차원 × 여러 측정치" 표/퍼널을 표현한다.
 * 각 metric.event 는 서로 다를 수 있다(예: 시작=level_start, 완료=level_complete).
 * group.param 은 모든 관련 이벤트가 공유하는 그룹 키 파라미터여야 한다.
 */
export interface ContentGroupSpec {
  key: string;
  label: string;
  /** 그룹 키 event_param. 예: "level" / "crop" / "difficulty" / "placement". */
  param: string;
  /** 그룹 값별로 집계할 지표들. metric.event 각각으로 스캔한다. */
  metrics: ContentMetricSpec[];
  /** 그룹 값별 파생 비율(뷰 전용). num/den 은 이 group 의 metric key. */
  derived?: ContentDerivedSpec[];
  /** 표시용 값 라벨(예: easy→쉬움). 없으면 원값. */
  valueLabels?: Record<string, string>;
  /** 표시 상위 N개 그룹 값(기본 20). */
  topN?: number;
  /** 정렬 기준 metric key(내림차순). 없으면 첫 metric. */
  orderBy?: string;
  /** 그룹 값 표시 순서 고정(예: [easy,normal,hard]). 지정 시 topN/orderBy 무시. */
  order?: string[];
  /** 표시 형태. table=다열 표, funnel=도달률 막대(첫 metric 기준 %). 기본 table. */
  render?: "table" | "funnel";
}

/**
 * 파생 비율 지표(뷰 전용, 저장 안 함). 스냅샷의 다른 지표 key 로 계산한다.
 * value = num / den * scale. den=0 이면 null. 앱 전체 metrics 또는 group.metrics 를 참조.
 */
export interface ContentDerivedSpec {
  key: string;
  label: string;
  /** 분자 metric key. */
  num: string;
  /** 분모 metric key. */
  den: string;
  /** 배율(기본 100 → 퍼센트). */
  scale?: number;
  unit?: string;
  round?: number;
}

/** 마켓(플랫폼) 차원. 선언 시 마켓별 + 통합('all') 행으로 저장한다. */
export interface ContentMarketSpec {
  /**
   * 마켓을 담은 event_param(선택). 있으면 우선, 없거나 빈 값이면 GA4 platform 매핑으로 폴백.
   * 예: crossword 는 "market" 파라미터를 직접 보낸다.
   */
  param?: string;
  /**
   * GA4 platform(ANDROID/IOS/WEB) → 마켓 key 폴백 매핑(선택). param 이 없거나 빈 값일 때 사용.
   * 예: foam 은 android/ios/web, crossword 는 google-play/app-store/apps-in-toss.
   */
  platformMap?: { android?: string; ios?: string; web?: string };
  /** 표시할 마켓 목록(통합 'all' 제외, 순서 고정). key 는 저장/조회 식별자. */
  values: { key: string; label: string }[];
}

export interface AppContentSpec {
  slug: string;
  /** 마켓 분해(선택). 미선언이면 'all' 단일 행만 저장한다. */
  market?: ContentMarketSpec;
  /** 앱 전체 단일 지표 카드. */
  metrics?: ContentMetricSpec[];
  /** 파라미터 값 분포(top-N 막대). */
  distributions?: ContentDistributionSpec[];
  /** 브레이크다운 표/퍼널. */
  groups?: ContentGroupSpec[];
  /** 앱 전체 파생 비율 카드. num/den 은 metrics 의 key. */
  derived?: ContentDerivedSpec[];
}

/** metric.event(문자열/배열)를 배열로 정규화. */
export function metricEvents(m: ContentMetricSpec): string[] {
  return Array.isArray(m.event) ? m.event : [m.event];
}

/** 스펙에 등장하는 모든 GA4 event_name(중복 제거). BigQuery 스캔 대상 축소용. */
export function specEvents(spec: AppContentSpec): string[] {
  const set = new Set<string>();
  for (const m of spec.metrics ?? []) for (const e of metricEvents(m)) set.add(e);
  for (const d of spec.distributions ?? []) set.add(d.event);
  for (const g of spec.groups ?? []) for (const m of g.metrics) for (const e of metricEvents(m)) set.add(e);
  return [...set];
}

/** 마켓 분해 대상 여부. */
export function hasMarket(spec: AppContentSpec): boolean {
  return !!spec.market && spec.market.values.length > 0;
}

// GA4 event_name / param 키는 [a-z0-9_] 규격이며 개발자 정의(사용자 입력 아님)지만,
// SQL 조립에 들어가므로 식별자 규격을 강제해 방어한다. 위반 시 조립을 실패시킨다.
const IDENT_RE = /^[a-zA-Z0-9_]{1,64}$/;

export function assertIdent(value: string, what: string): string {
  if (!IDENT_RE.test(value)) {
    throw new Error(`컨텐츠 스펙 식별자 규격 위반(${what}): ${JSON.stringify(value)}`);
  }
  return value;
}
