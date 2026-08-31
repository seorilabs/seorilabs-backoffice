// Org 보고서 라인 차트의 순수 기하. 컴포넌트(ReportLineChart)는 렌더만 하고
// 눈금·경로 계산은 여기서 테스트로 고정한다. PlatformMetricChart 의 방식을 일 단위
// 시계열로 일반화한 것이다.

/** 축 최댓값을 읽기 좋은 눈금으로 올림(5 이하는 5 고정). */
export function niceMax(value: number): number {
  if (value <= 5) return 5;
  const mag = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / mag) * mag;
}

export interface ChartSegments {
  /** 2점 이상 이어지는 구간의 SVG path("M… L…"). */
  paths: string[];
  /** 양옆이 결측이라 선이 안 그려지는 고립 점 — 마커로 남긴다. */
  lonePoints: Array<{ x: number; y: number }>;
}

/**
 * 값이 null(미수집)인 지점에서 선을 끊는다. 이어 그리면 수집이 없던 날에도
 * 그 정도였다는 거짓을 보여준다.
 */
export function splitSegmentsOnNull(
  values: readonly (number | null)[],
  x: (index: number) => number,
  y: (value: number) => number,
): ChartSegments {
  const paths: string[] = [];
  const lonePoints: Array<{ x: number; y: number }> = [];
  let run: Array<{ x: number; y: number }> = [];
  const flush = () => {
    if (run.length >= 2) {
      paths.push(run.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" "));
    } else if (run.length === 1) {
      lonePoints.push(run[0]);
    }
    run = [];
  };
  values.forEach((value, index) => {
    if (value == null) {
      flush();
      return;
    }
    run.push({ x: x(index), y: y(value) });
  });
  flush();
  return { paths, lonePoints };
}
