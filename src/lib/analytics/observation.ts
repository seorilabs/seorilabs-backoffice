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

/**
 * GA4 export 가 아직 안 온 것인가, 그 날 활동이 진짜 0 이었나.
 *
 * 앱마다 GA4 데이터셋이 따로다. 그래서 events_YYYYMMDD 는 그 앱이 그 날 이벤트를
 * 하나라도 냈을 때만 생긴다 — 테이블이 없다는 사실만으로는 "아직 안 왔다"와 "활동이
 * 0 이었다"를 가를 수 없다. 처음 구현은 전부 not_landed 로 봤고, 그러면 조용한 앱이
 * 매일 미관측으로 잡혀 분모가 영영 차지 않는다(실측: 30일 중 108칸).
 *
 * 두 가지로 가른다.
 *
 * 1. 그 앱의 더 뒤 날짜 테이블이 이미 착지했다면, export 는 그 날을 지나간 것이다.
 *    테이블이 없는 것은 활동이 0 이었기 때문이다.
 * 2. 그렇지 않아도 정착 기간이 지나면 0 으로 확정한다. 실측 착지 지연은 최대 34시간이고
 *    예외 1건이 58시간이었다. GA4 가 일별 테이블을 보정하는 72시간에 맞춰 3일로 둔다.
 */
export const LANDING_SETTLE_DAYS = 3;

export function missingDayState(input: {
  /** 이 날의 나이(기준일 기준 며칠 전인가). 0 = 기준일. */
  ageDays: number;
  /** 같은 앱에서 착지가 확인된 가장 최신 달력일. 하나도 없으면 null. */
  latestLandedDay: string | null;
  day: string;
  settleDays?: number;
}): Extract<MetricObservationState, "empty" | "not_landed"> {
  const settledByLater = input.latestLandedDay != null && input.day < input.latestLandedDay;
  const settledByAge = input.ageDays >= (input.settleDays ?? LANDING_SETTLE_DAYS);
  return settledByLater || settledByAge ? "empty" : "not_landed";
}
