// 관측 상태 어휘와 봉인 규칙(순수). DB 도 시계도 모른다.
//
// as-of 해석기(as-of.ts)와 원장 쓰기(coverage.ts)가 둘 다 이것에 의존한다. 한쪽에
// 두면 두 모듈이 서로를 import 해 순환이 생긴다.

export const METRIC_SOURCES = ["ga4", "ait_console"] as const;
export type MetricSource = (typeof METRIC_SOURCES)[number];

export const METRIC_OBSERVATION_STATES = [
  "observed", // 소스가 그 날을 응답했고 값을 저장했다.
  "empty", // 소스 테이블은 착지했는데 그 대상의 그 날 활동이 진짜 0 이다.
  "not_landed", // export/푸시가 아직 없다. 나중에 채워질 수 있다.
  "failed", // 쿼리·푸시가 오류로 끝났다. 재시도 대상.
  "not_applicable", // 그 날 이 대상은 수집 범위가 아니다(출시 전·중단·매핑 없음).
] as const;
export type MetricObservationState = (typeof METRIC_OBSERVATION_STATES)[number];

/** 이 칸이 합산 분모를 채웠는가. 값을 본 것과 0 임을 본 것만 "관측됨"이다. */
export function isObserved(state: MetricObservationState): boolean {
  return state === "observed" || state === "empty";
}

/** 소스 테이블이 존재한다는 뜻인가. landedAt 을 찍을 조건이다. */
export function impliesLanded(state: MetricObservationState): boolean {
  return isObserved(state);
}

/**
 * GA4 는 같은 상태로 두 번 이상 봐야 봉인한다. 한 번 관측만으로 봉인하면 첫 관측이
 * 미완결 테이블이었을 때 낮은 값이 영구 고정된다(09-12 에 실제로 그럴 뻔했다).
 * 콘솔은 자동 수집이 없어 관측 횟수로 성숙을 말할 수 없으므로 경과일만 본다.
 */
export const SEAL_RULES: Record<
  MetricSource,
  { minAgeDays: number; minObservations: number }
> = {
  ga4: { minAgeDays: 2, minObservations: 2 },
  ait_console: { minAgeDays: 3, minObservations: 1 },
};

/**
 * 이 칸이 다시는 바뀌지 않는가(순수). failed·not_landed 는 절대 봉인되지 않는다 —
 * 영구히 실패한 대상이 있으면 그 날은 영원히 잠정이고, 그것이 정확한 표현이다.
 */
export function sealRule(input: {
  source: MetricSource;
  state: MetricObservationState;
  ageDays: number;
  observations: number;
}): boolean {
  if (!isObserved(input.state)) return false;
  // 콘솔은 push 로만 들어와 "활동 0"을 관측할 수 없다. empty 는 GA4 전용이다.
  if (input.source === "ait_console" && input.state !== "observed") return false;
  const rule = SEAL_RULES[input.source];
  return input.ageDays >= rule.minAgeDays && input.observations >= rule.minObservations;
}
