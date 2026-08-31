import { isoDate, parseIsoDate } from "@/lib/ga4/datasets";

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
