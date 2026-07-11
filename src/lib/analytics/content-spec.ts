// 앱별 컨텐츠 지표 스펙(엔진/소스 독립, 순수 타입). 각 앱은 자기 컨텐츠 이벤트를
// 이 스펙으로 선언하고, 수집부(content-metrics-collect)와 GA4 구현(content-metrics)이
// 스펙을 해석해 집계한다. 이벤트 이름/파라미터 키는 각 게임의 클린아키텍처 컨텐츠
// 이벤트 카탈로그(예: lucid-chess packages/product-core/.../content_events.gd)와 1:1.
//
// 충돌 최소화: 게임별 스펙은 specs/<slug>.ts 로 각자 파일에 두고, 아래 레지스트리는
// slug→spec 한 줄만 추가한다.

export type ContentAgg = "avg" | "sum";

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
}

/** 이벤트 발생 카운트(+고유 사용자). 예: hint_used 횟수/사용자. */
export interface ContentCounterSpec {
  key: string;
  label: string;
  event: string;
}

/** 이벤트 파라미터의 수치 집계(평균/합). 예: game_end.move_count 평균. */
export interface ContentMeasureSpec {
  key: string;
  label: string;
  event: string;
  param: string;
  agg: ContentAgg;
  /** 표시 단위(예: "수", "초", "회"). */
  unit?: string;
  /** 반올림 소수 자리(기본 1). */
  round?: number;
}

export interface AppContentSpec {
  slug: string;
  distributions: ContentDistributionSpec[];
  counters: ContentCounterSpec[];
  measures: ContentMeasureSpec[];
}

/** 스펙에 등장하는 모든 GA4 event_name(중복 제거). BigQuery 스캔 대상 축소용. */
export function specEvents(spec: AppContentSpec): string[] {
  const set = new Set<string>();
  for (const d of spec.distributions) set.add(d.event);
  for (const c of spec.counters) set.add(c.event);
  for (const m of spec.measures) set.add(m.event);
  return [...set];
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
