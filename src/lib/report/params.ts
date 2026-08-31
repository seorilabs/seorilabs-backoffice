import { isoDate, latestClosedDay, parseIsoDate } from "@/lib/ga4/datasets";

// /report 페이지의 날짜 파라미터 처리(순수). URL 은 사용자가 임의로 조작할 수 있으므로
// 형식·실존 달력 날짜를 함께 검증하고, 데이터 범위 밖 요청은 redirect 대신 clamp 해
// 안내 문구로 드러낸다.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" 형식이면서 실존하는 달력 날짜만 통과. 그 외(2026-02-30 등)는 null. */
export function parseReportDate(raw: string | undefined | null): string | null {
  if (!raw || !DATE_RE.test(raw)) return null;
  const parsed = parseIsoDate(raw);
  return Number.isNaN(parsed.getTime()) || isoDate(parsed) !== raw ? null : raw;
}

export interface ClampedReportDate {
  date: string;
  /** 요청이 범위 밖이라 조정됐는지. true 면 화면에 안내를 남긴다. */
  clamped: boolean;
}

/** ISO 날짜 문자열은 사전순 비교가 시간순 비교와 같다. */
export function clampReportDate(date: string, min: string, max: string): ClampedReportDate {
  if (date < min) return { date: min, clamped: true };
  if (date > max) return { date: max, clamped: true };
  return { date, clamped: false };
}

/** date 에서 delta 일 이동한 "YYYY-MM-DD". 전일/익일 버튼용. */
export function shiftDay(date: string, delta: number): string {
  return isoDate(new Date(parseIsoDate(date).getTime() + delta * 24 * 60 * 60 * 1000));
}

export interface ReportRange {
  /** 피커 이동 가능 범위(데이터가 실제 존재하는 날짜, D-1 상한). */
  min: string;
  max: string;
  /** 실제 표시할 날짜. 요청이 없으면 max(=최신 확정일). */
  selected: string;
  /** 요청 날짜가 범위 밖이라 조정됐는지. */
  clamped: boolean;
}

/**
 * 원본 테이블들의 min/max 날짜와 요청 날짜로 피커 범위·선택일을 해석한다.
 * 기본 선택일은 "오늘"이 아니라 데이터가 존재하는 최신 확정일이다 — 지표는 D-1 확정
 * 수집이라 오늘 날짜에는 데이터가 항상 없고, 수집이 밀린 날에도 빈 화면을 만들지 않는다.
 * 데이터가 전혀 없으면 null.
 */
export function resolveReportRange(input: {
  requested: string | null;
  /** 소스별 (min, max) 날짜 경계. 값이 없는 소스는 null. */
  bounds: ReadonlyArray<{ min: Date | null; max: Date | null }>;
  now: Date;
}): ReportRange | null {
  const mins = input.bounds.map((b) => b.min).filter((d): d is Date => d != null);
  const maxes = input.bounds.map((b) => b.max).filter((d): d is Date => d != null);
  if (mins.length === 0 || maxes.length === 0) return null;

  const min = isoDate(new Date(Math.min(...mins.map((d) => d.getTime()))));
  const dataMax = isoDate(new Date(Math.max(...maxes.map((d) => d.getTime()))));
  // 미래 날짜가 실수로 적재돼도 피커 상한은 최신 확정일(D-1)을 넘지 않는다.
  const cap = isoDate(latestClosedDay(input.now));
  const max = dataMax < cap ? dataMax : cap < min ? min : cap;

  const { date: selected, clamped } = clampReportDate(input.requested ?? max, min, max);
  return { min, max, selected, clamped: input.requested != null && clamped };
}
