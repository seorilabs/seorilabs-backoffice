// AppsInToss 콘솔 지표의 기간(윈도우) 집계. /analytics Overview 의 "최근 N일 집계" 표가 쓴다.
// 순수 함수 — DB/뷰와 독립적으로 테스트한다. rows 는 최신→과거(orderBy date desc) 가정.

export interface ConsoleWindowRow {
  date: Date;
  dau: number;
  newUsers: number;
  avgSessionSec: number | null;
  iaaImpressions: number;
  iaaEarningKrw: number;
}

export interface ConsoleWindowAgg {
  /** 집계에 포함된 수집 일수(= rows.length). */
  days: number;
  /** 구간의 가장 이른/늦은 날짜. */
  dateMin: Date;
  dateMax: Date;
  /** DAU 합과 일평균(존재 일수 기준). */
  dauSum: number;
  dauAvg: number;
  /** 신규 사용자 합. */
  newSum: number;
  /** 평균 세션 길이(초). avgSessionSec 이 있는 날만 평균, 없으면 null. */
  sessAvg: number | null;
  /** 광고 노출 합, 광고 추정 수익 합(원). */
  iaaImpSum: number;
  iaaEarnSum: number;
}

/**
 * 최근 N개 콘솔 수집 row 를 집계한다. 빈 배열이면 null.
 * 일평균 DAU 는 존재 일수(rows.length)로 나눈다(데이터 없는 날은 애초에 row 가 없음).
 * 세션 평균은 avgSessionSec 이 null 이 아닌 날만 대상으로 하며, 전부 null 이면 null 이다.
 */
export function aggConsoleWindow(rows: ConsoleWindowRow[]): ConsoleWindowAgg | null {
  if (rows.length === 0) return null;
  const n = rows.length;
  const sum = (f: (r: ConsoleWindowRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const sessRows = rows.filter((r) => r.avgSessionSec != null);
  const dauSum = sum((r) => r.dau);
  return {
    days: n,
    dateMin: rows[n - 1].date,
    dateMax: rows[0].date,
    dauSum,
    dauAvg: dauSum / n,
    newSum: sum((r) => r.newUsers),
    sessAvg: sessRows.length
      ? sessRows.reduce((s, r) => s + (r.avgSessionSec ?? 0), 0) / sessRows.length
      : null,
    iaaImpSum: sum((r) => r.iaaImpressions),
    iaaEarnSum: sum((r) => r.iaaEarningKrw),
  };
}
