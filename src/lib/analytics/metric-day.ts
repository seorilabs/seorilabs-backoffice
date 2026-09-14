// 지표 달력일(metric day) 단일 계약. 백오피스의 모든 일별 지표는 이 축 하나 위에 있다.
//
// 왜 따로 두는가. 지금까지의 지표 결손은 대부분 "날처럼 생긴 Date"에서 나왔다.
// @db.Date 에서 읽은 Date(UTC 자정)와 실제 시각을 담은 Date 는 타입이 같은데,
// 둘을 같은 함수로 문자열화하면서 타임존이 조용히 섞였다. 그래서 이 모듈은
// 두 방향을 이름으로 갈라 놓는다.
//
//   시각 → 달력일          metricDayOf / lastElapsedMetricDay   (KST 기준)
//   달력일 ↔ @db.Date      dbDay / toDbDay                      (UTC 자정 규약)
//
// 축을 KST 로 잡는 이유:
//   - GA4 export 의 event_date 는 property 보고 타임존의 달력일이고, 대상 앱의
//     property 는 모두 Asia/Seoul 이다(1회성 timezone-probe 로 확인한다).
//   - AppsInToss 콘솔 지표의 기준일도 KST 다(schema.prisma 의 AppConsoleMetricDaily 주석).
//   - 운영 요약도 KST 달력일을 쓴다.
// 즉 축이 KST 인 것은 우연이 아니라 계약이다. 반대로 PlatformUserMetricSample 은
// 시각(instant) 축이라 이 달력일 격자에 넣지 않는다.
//
// KST 는 1988년 이후 서머타임이 없어 고정 +09:00 산술로 충분하다(Intl 불필요, 결정적).

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const METRIC_DAY_TZ = "Asia/Seoul";

/**
 * 시각을 그 시각이 속한 KST 달력일로. 임의의 Date 를 날로 바꾸는 유일한 경로다.
 * 다른 곳에서 toISOString().slice(0,10) 을 시각에 직접 쓰면 UTC 달력일이 나와
 * 00:00~08:59 KST 구간에서 하루가 밀린다.
 */
export function metricDayOf(instant: Date): string {
  return new Date(instant.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 달력상 끝난 마지막 날(D-1, KST). "그 날 데이터가 준비됐다"는 주장은 하지 않는다 —
 * 수집 완결 여부는 수집 원장이 판단한다. 이 함수는 달력만 본다.
 */
export function lastElapsedMetricDay(now: Date): string {
  return shiftMetricDay(metricDayOf(now), -1);
}

/** 달력일 00:00 KST 의 UTC 시각. capturedAt/occurredAt 같은 시각 컬럼 범위 질의용. */
export function metricDayStart(day: string): Date {
  return new Date(toDbDay(day).getTime() - KST_OFFSET_MS);
}

/**
 * @db.Date 컬럼에서 읽은 Date 를 달력일로. Prisma 가 DATE 를 UTC 자정 Date 로
 * 준다는 사실에만 의존하므로 시각에는 쓰지 않는다(그 용도는 metricDayOf).
 */
export function dbDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 달력일을 @db.Date 저장·비교용 Date(UTC 자정)로. */
export function toDbDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * 외부 입력(URL query, push payload)용 파싱. 형식과 실존 달력 날짜를 함께 보므로
 * 2026-02-30 같은 값은 통과하지 않는다. 위반이면 null.
 */
export function parseMetricDay(raw: string | null | undefined): string | null {
  if (!raw || !DAY_RE.test(raw)) return null;
  const parsed = toDbDay(raw);
  return Number.isNaN(parsed.getTime()) || dbDay(parsed) !== raw ? null : raw;
}

/** day 에서 delta 일 이동한 달력일. */
export function shiftMetricDay(day: string, delta: number): string {
  return dbDay(new Date(toDbDay(day).getTime() + delta * DAY_MS));
}

/** end(포함) 기준 과거 days 개의 달력일(오래된→최신 순). */
export function metricDayWindow(end: string, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(shiftMetricDay(end, -i));
  return out;
}

/** a 가 b 보다 며칠 뒤인지(정수 일). */
export function metricDaysBetween(a: string, b: string): number {
  return Math.round((toDbDay(a).getTime() - toDbDay(b).getTime()) / DAY_MS);
}

/**
 * GA4 events_YYYYMMDD 접미사. export 의 일별 테이블은 property 보고 타임존의
 * 달력일로 쪼개지므로 이 축과 같은 키다.
 */
export function toGa4TableSuffix(day: string): string {
  return day.replace(/-/g, "");
}
