import { toDbDay } from "@/lib/analytics/metric-day";
import type { Ga4EventDateBoundary } from "@/lib/ga4/bigquery";

// GA4 property 보고 타임존을 event_date 경계에서 역산한다(순수).
//
// export 의 event_date 는 property 타임존의 달력일이므로, 그 날의 이벤트는 전부
// [D 00:00 로컬, D 24:00 로컬) 안에 있다. UTC 로 본 첫·마지막 이벤트 시각이
// 이 구간에 들어가려면 오프셋이 만족해야 하는 범위가 정해진다.
//
//   D 00:00 로컬 = D 00:00 UTC − offset  이므로
//     first ≥ D 00:00 UTC − offset        →  offset ≥ D00:00UTC − first
//     last  <  D 00:00 UTC − offset + 24h →  offset ≤ D00:00UTC + 24h − last
//
// 날짜를 여러 개 겹칠수록 범위가 좁아진다. 트래픽이 적은 앱은 범위가 넓게 남는데,
// 그때는 "KST 와 모순되지 않는다"까지만 말하고 단정하지 않는다. 기기 시계가 크게
// 어긋난 이벤트가 섞이면 범위가 뒤집힐 수 있으므로 그 경우도 따로 드러낸다.

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/** Asia/Seoul 오프셋(시간). KST 는 1988년 이후 서머타임이 없다. */
export const KST_OFFSET_HOURS = 9;

export interface PropertyOffsetInference {
  days: number;
  /** 관측과 모순되지 않는 오프셋 범위(시간, 양끝 포함). */
  minOffsetHours: number;
  maxOffsetHours: number;
  /** 범위가 뒤집힘 = 기기 시계 이상 등으로 관측이 서로 모순된다. */
  contradictory: boolean;
  /** +09:00 이 범위 안에 있는가. */
  matchesKst: boolean;
  /** UTC(0) 가 범위에서 배제되는가. 배제돼야 "UTC 축이 아니다"를 주장할 수 있다. */
  excludesUtc: boolean;
}

export function inferPropertyOffsetHours(
  rows: readonly Ga4EventDateBoundary[],
): PropertyOffsetInference | null {
  if (rows.length === 0) return null;
  let lowerMs = Number.NEGATIVE_INFINITY;
  let upperMs = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const dayStartUtcMs = toDbDay(row.date).getTime();
    lowerMs = Math.max(lowerMs, dayStartUtcMs - row.firstUtc.getTime());
    upperMs = Math.min(upperMs, dayStartUtcMs + DAY_MS - row.lastUtc.getTime());
  }
  const minOffsetHours = lowerMs / HOUR_MS;
  const maxOffsetHours = upperMs / HOUR_MS;
  const contradictory = minOffsetHours > maxOffsetHours;
  return {
    days: rows.length,
    minOffsetHours,
    maxOffsetHours,
    contradictory,
    matchesKst:
      !contradictory &&
      minOffsetHours <= KST_OFFSET_HOURS &&
      KST_OFFSET_HOURS <= maxOffsetHours,
    excludesUtc: !contradictory && (minOffsetHours > 0 || maxOffsetHours < 0),
  };
}
