// AppsInToss 콘솔 지표의 기간(윈도우) 집계. /analytics Overview 의 "최근 N일 집계" 표가 쓴다.
// 순수 함수 — DB/뷰와 독립적으로 테스트한다. rows 는 최신→과거(orderBy date desc) 가정.

export interface ConsoleWindowRow {
  date: Date;
  // null=콘솔 미집계(세션/광고는 있으나 DAU 배열에 부재). 합계에선 0 취급, 평균 분모에선 제외.
  dau: number | null;
  newUsers: number | null;
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
 * 콘솔 광고수익 월 집계 범위. AppConsoleMetricDaily.date 는 토스/KST 기준일을 UTC 자정 Date 로
 * 저장하므로 UTC calendar 연산으로 월 경계를 계산한다. 현재 월은 최신 수집 기준일까지, 전월은
 * 전체 월과 현재 월의 같은 일수만큼인 동기간을 함께 제공한다.
 */
export interface ConsoleMonthWindow {
  reportDate: Date;
  currentStart: Date;
  currentEndExclusive: Date;
  previousStart: Date;
  previousComparableEndExclusive: Date;
  previousEndExclusive: Date;
  currentElapsedDays: number;
  previousComparableDays: number;
  previousCalendarDays: number;
}

/** 최신 수집 기준일을 기준으로 이번 달 MTD·전월 동기간·전월 전체 경계를 계산한다. */
export function consoleMonthWindow(reportDate: Date): ConsoleMonthWindow {
  const year = reportDate.getUTCFullYear();
  const month = reportDate.getUTCMonth();
  const day = reportDate.getUTCDate();
  const currentStart = new Date(Date.UTC(year, month, 1));
  const previousStart = new Date(Date.UTC(year, month - 1, 1));
  const previousEndExclusive = currentStart;
  const previousYear = previousStart.getUTCFullYear();
  const previousMonth = previousStart.getUTCMonth();
  const previousCalendarDays = new Date(
    Date.UTC(previousYear, previousMonth + 1, 0),
  ).getUTCDate();
  const previousComparableDays = Math.min(day, previousCalendarDays);

  return {
    reportDate,
    currentStart,
    currentEndExclusive: new Date(Date.UTC(year, month, day + 1)),
    previousStart,
    previousComparableEndExclusive: new Date(
      Date.UTC(previousYear, previousMonth, previousComparableDays + 1),
    ),
    previousEndExclusive,
    currentElapsedDays: day,
    previousComparableDays,
    previousCalendarDays,
  };
}

/**
 * 같은 길이의 두 기간이 모두 빠짐없이 관측됐을 때만 증감률을 반환한다. 누락된 리스팅-일을
 * 수익 0원으로 해석하거나, 기준값 0원에서 무한대 비율을 만드는 것을 방지한다.
 */
export function completePeriodChangePct({
  currentValue,
  previousValue,
  currentObserved,
  currentExpected,
  previousObserved,
  previousExpected,
}: {
  currentValue: number;
  previousValue: number;
  currentObserved: number;
  currentExpected: number;
  previousObserved: number;
  previousExpected: number;
}): number | null {
  if (
    currentExpected <= 0 ||
    previousExpected <= 0 ||
    currentExpected !== previousExpected ||
    currentObserved !== currentExpected ||
    previousObserved !== previousExpected ||
    previousValue <= 0
  ) {
    return null;
  }
  return ((currentValue - previousValue) / previousValue) * 100;
}

/**
 * 최근 N개 콘솔 수집 row 를 집계한다. 빈 배열이면 null.
 * 일평균 DAU 는 DAU 가 집계된 일수(dau != null)로 나눈다 — 콘솔 미집계일(null)은 분모에서 제외
 * (세션만 있는 날을 0 명으로 눌러 평균을 왜곡하지 않는다). DAU 가 전부 null 이면 dauAvg=0.
 * 세션 평균은 avgSessionSec 이 null 이 아닌 날만 대상으로 하며, 전부 null 이면 null 이다.
 */
export function aggConsoleWindow(rows: ConsoleWindowRow[]): ConsoleWindowAgg | null {
  if (rows.length === 0) return null;
  const n = rows.length;
  const sum = (f: (r: ConsoleWindowRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const sessRows = rows.filter((r) => r.avgSessionSec != null);
  const dauSum = sum((r) => r.dau ?? 0);
  const dauDays = rows.filter((r) => r.dau != null).length;
  return {
    days: n,
    dateMin: rows[n - 1].date,
    dateMax: rows[0].date,
    dauSum,
    dauAvg: dauDays ? dauSum / dauDays : 0,
    newSum: sum((r) => r.newUsers ?? 0),
    sessAvg: sessRows.length
      ? sessRows.reduce((s, r) => s + (r.avgSessionSec ?? 0), 0) / sessRows.length
      : null,
    iaaImpSum: sum((r) => r.iaaImpressions),
    iaaEarnSum: sum((r) => r.iaaEarningKrw),
  };
}

/**
 * 기간 집계 항목을 DAU 합 내림차순으로 정렬한다. 집계가 없는 항목(agg=null, 수집 데이터 없음)은
 * dauSum 을 -1 로 취급해 항상 뒤로 보낸다. 원본 배열은 변경하지 않는다(복사 후 정렬).
 */
export function rankConsoleWindows<T extends { agg: ConsoleWindowAgg | null }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => (b.agg?.dauSum ?? -1) - (a.agg?.dauSum ?? -1));
}

/** 집계 표 한 행의 표시 문자열. 값이 없으면 모두 "—"(0 이 아님). */
export interface ConsoleWindowRowDisplay {
  period: string;
  dauSum: string;
  dauAvg: string;
  newSum: string;
  sessAvg: string;
  iaaImpSum: string;
  iaaEarnKrw: string;
}

const DASH = "—";

/**
 * 기간 집계 한 행을 표 셀 문자열로 포맷한다. 집계가 없으면(agg=null, 수집 데이터 없음) 모든 셀이
 * "—" 이며 0 으로 표기하지 않는다. 세션 평균이 null 인 날짜집합도 "—". fmtDate 는 날짜 포맷터 주입.
 */
export function formatConsoleWindowRow(
  agg: ConsoleWindowAgg | null,
  fmtDate: (d: Date) => string,
): ConsoleWindowRowDisplay {
  if (!agg) {
    return {
      period: DASH,
      dauSum: DASH,
      dauAvg: DASH,
      newSum: DASH,
      sessAvg: DASH,
      iaaImpSum: DASH,
      iaaEarnKrw: DASH,
    };
  }
  return {
    period: `${fmtDate(agg.dateMin)}~${fmtDate(agg.dateMax)}`,
    dauSum: String(agg.dauSum),
    dauAvg: agg.dauAvg.toFixed(1),
    newSum: String(agg.newSum),
    sessAvg: agg.sessAvg != null ? `${Math.round(agg.sessAvg)}초` : DASH,
    iaaImpSum: String(agg.iaaImpSum),
    iaaEarnKrw: `₩${Math.round(agg.iaaEarnSum).toLocaleString("ko-KR")}`,
  };
}
