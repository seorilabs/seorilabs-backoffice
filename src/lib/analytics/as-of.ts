import { shiftMetricDay } from "@/lib/analytics/metric-day";
import { isObserved, type MetricObservationState } from "@/lib/analytics/observation";

// 기준일 해석기(순수). DB 도 시계도 건드리지 않는다 — 호출부가 오늘 날짜와 원장 칸을 준다.
//
// 지금까지 기준일은 "달력상 어제"였고, 그 날 데이터가 얼마나 왔는지는 아무도 묻지
// 않았다. 그래서 대상 9개 중 2개만 도착한 날에도 그 2개의 합을 "어제 지표"로 발행했다.
// 여기서 묻는 것은 하나다 — 이 날짜에 대해 우리가 세어야 할 대상을 다 셌는가.

export interface AsOfTarget {
  targetKey: string;
  /**
   * 합계 기여 가중치(최근 DAU 중앙값). 빠진 대상이 포트폴리오의 80% 인지 2% 인지
   * 구분하지 못하면 "이 수치를 내보내도 되는가"를 판단할 수 없다.
   */
  weight: number;
}

export interface CoverageCell {
  targetKey: string;
  day: string;
  state: MetricObservationState;
  sealed: boolean;
}

export type AsOfVerdict = "final" | "provisional";

export interface AsOfMissing {
  targetKey: string;
  /** 원장에 칸이 없으면 "unobserved"(수집이 그 날을 시도조차 하지 않았다). */
  state: MetricObservationState | "unobserved";
  weight: number;
}

export interface AsOfResolution {
  day: string;
  verdict: AsOfVerdict;
  observed: number;
  expected: number;
  /** 아직 관측되지 않은 대상 전량. 잘라내지 않는다 — 무엇이 빠졌는지가 핵심이다. */
  missing: AsOfMissing[];
  /** 빠진 대상의 가중치 합 / 전체. 0~1. */
  missingWeightShare: number;
  /** 기대 대상이 전부 봉인됐다. 이 날은 다시 바뀌지 않는다. */
  sealed: boolean;
}

const SEP = "\u0000";
const cellKey = (targetKey: string, day: string) => `${targetKey}${SEP}${day}`;

function evaluateDay(
  day: string,
  targets: readonly AsOfTarget[],
  byCell: ReadonlyMap<string, CoverageCell>,
): AsOfResolution {
  let observed = 0;
  let expected = 0;
  let sealedCount = 0;
  let totalWeight = 0;
  let missingWeight = 0;
  const missing: AsOfMissing[] = [];

  for (const target of targets) {
    const cell = byCell.get(cellKey(target.targetKey, day));
    // 그 날 대상이 아니었던 칸은 분모를 늘리지 않는다(출시 전 앱이 미수집으로 보이면 안 된다).
    if (cell?.state === "not_applicable") continue;
    expected += 1;
    totalWeight += target.weight;
    if (cell && isObserved(cell.state)) {
      observed += 1;
      if (cell.sealed) sealedCount += 1;
      continue;
    }
    missingWeight += target.weight;
    missing.push({
      targetKey: target.targetKey,
      state: cell?.state ?? "unobserved",
      weight: target.weight,
    });
  }

  const complete = expected > 0 && observed === expected;
  return {
    day,
    verdict: complete && sealedCount === expected ? "final" : "provisional",
    observed,
    expected,
    missing,
    missingWeightShare: totalWeight > 0 ? missingWeight / totalWeight : 0,
    sealed: expected > 0 && sealedCount === expected,
  };
}

/**
 * 기준일과 완결 판정.
 *
 * requested 를 주면 그 날만 본다(과거 재계산·수동 재발행). 아니면 어제부터
 * maxLookbackDays 만큼 과거로 내려가며 완전 관측된 가장 최신 날을 찾는다.
 *
 * 완전한 후보가 없으면 **가장 최신 후보를 provisional 로** 낸다. 조용히 더 과거로
 * 걸어 내려가지 않는다 — 이틀 전을 어제인 척 발행하는 것은 낮은 수치를 발행하는
 * 것과 같은 종류의 거짓이다. 무엇이 빠졌는지는 missing 이 들고 있다.
 */
export function resolveAsOf(input: {
  /** 오늘(KST 달력일). 호출부가 metricDayOf(now) 로 준다. */
  today: string;
  targets: readonly AsOfTarget[];
  cells: readonly CoverageCell[];
  requested?: string | null;
  maxLookbackDays?: number;
}): AsOfResolution | null {
  if (input.targets.length === 0) return null;
  const byCell = new Map(input.cells.map((cell) => [cellKey(cell.targetKey, cell.day), cell]));

  if (input.requested) {
    return evaluateDay(input.requested, input.targets, byCell);
  }

  const lookback = Math.max(1, input.maxLookbackDays ?? 1);
  const candidates = Array.from(
    { length: lookback },
    (_, index) => shiftMetricDay(input.today, -(index + 1)),
  );
  for (const day of candidates) {
    const resolution = evaluateDay(day, input.targets, byCell);
    if (resolution.expected > 0 && resolution.observed === resolution.expected) {
      return resolution;
    }
  }
  return evaluateDay(candidates[0], input.targets, byCell);
}
