import type { Ga4Target } from "./datasets";

export function isoDay(suffix: string): string {
  if (!/^\d{8}$/.test(suffix)) throw new Error("날짜 형식 오류");
  const iso = `${suffix.slice(0,4)}-${suffix.slice(4,6)}-${suffix.slice(6,8)}`;
  const date = new Date(iso + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== iso) throw new Error("날짜 범위 오류");
  return iso;
}

/** 달빛 맞고 analytics/cohorts.sql의 이벤트 계약. 보관 기간 안에 실제 착지한 일별 테이블만 사용한다. */
export function buildMatgoCohortsSql(target: Ga4Target, start: string, end: string, landed: Set<string>): string {
  if (!/^[a-z][a-z0-9-]{4,62}$/.test(target.firebaseProject) || !/^analytics_\d+$/.test(target.dataset)) throw new Error("조회 식별자 오류");
  const startDay = `DATE '${isoDay(start)}'`, endDay = `DATE '${isoDay(end)}'`;
  if (start > end) throw new Error("날짜 순서 오류");
  const days = [...landed].sort().filter(day => day >= start && day <= end).map(day => `DATE '${isoDay(day)}'`);
  const observed = days.length ? `[${days.join(", ")}]` : "ARRAY<DATE>[]";
  return `
-- ${startDay}, ${endDay}, ${observed}는 실제로 존재하는 일별 테이블 목록에서 만든다.
WITH events AS (
  SELECT user_pseudo_id AS user_id, event_name, event_timestamp,
    DATE(TIMESTAMP_MICROS(user_first_touch_timestamp), 'Asia/Seoul') AS cohort_day,
    PARSE_DATE('%Y%m%d', event_date) AS active_day,
    platform AS sdk_platform,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key='traffic_type') AS traffic,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key='install_cohort') AS install_cohort,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key='match_ordinal') AS ordinal,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key='outcome') AS outcome,
    EXISTS(SELECT 1 FROM UNNEST(event_params) WHERE key IN ('debug_mode', '_dbg')
      AND (value.int_value=1 OR value.string_value IN ('1', 'true'))) AS is_debug
  FROM \`${target.firebaseProject}.${target.dataset}.events_*\`
  WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', ${startDay}) AND FORMAT_DATE('%Y%m%d', ${endDay})
    AND REGEXP_CONTAINS(_TABLE_SUFFIX, r'^\\d{8}$') AND user_pseudo_id IS NOT NULL
), identities AS (
  SELECT user_id, MIN(cohort_day) AS cohort_day, ANY_VALUE(sdk_platform) AS sdk_platform,
    LOGICAL_OR(traffic='test' OR is_debug) AS test_user,
    LOGICAL_OR(event_name='analytics_ready' AND traffic='production' AND install_cohort='fresh') AS new_install
  FROM events GROUP BY user_id
), facts AS (
  SELECT i.user_id, i.cohort_day, i.sdk_platform,
    ARRAY_AGG(DISTINCT e.active_day) AS active_days,
    MIN(IF(e.event_name='match_begin' AND e.ordinal=1, e.event_timestamp, NULL)) AS first_begin,
    MIN(IF(e.event_name='match_complete' AND e.ordinal=1 AND e.outcome!='forfeit', e.event_timestamp, NULL)) AS first_complete,
    MIN(IF(e.event_name='match_begin' AND e.ordinal=2, e.event_timestamp, NULL)) AS second_begin
  FROM identities i JOIN events e USING(user_id)
  WHERE i.new_install AND NOT COALESCE(i.test_user, FALSE)
    AND i.cohort_day BETWEEN ${startDay} AND ${endDay}
  GROUP BY i.user_id, i.cohort_day, i.sdk_platform
)
SELECT cohort_day,
  IF(sdk_platform='ANDROID', 'google-play', IF(sdk_platform='IOS', 'app-store', sdk_platform)) AS market,
  COUNT(*) AS new_installs,
  COUNTIF(first_begin IS NOT NULL) AS first_match_starters,
  COUNTIF(first_complete >= first_begin) AS first_match_completers,
  SAFE_DIVIDE(COUNTIF(first_complete >= first_begin), COUNTIF(first_begin IS NOT NULL)) AS first_match_completion_rate,
  COUNTIF(second_begin >= first_complete) AS second_match_starters,
  SAFE_DIVIDE(COUNTIF(second_begin >= first_complete), COUNTIF(first_complete IS NOT NULL)) AS second_match_start_rate,
  IF(DATE_ADD(cohort_day, INTERVAL 1 DAY) IN UNNEST(${observed}),
    COUNTIF(DATE_ADD(cohort_day, INTERVAL 1 DAY) IN UNNEST(active_days)), NULL) AS d1_returned,
  IF(DATE_ADD(cohort_day, INTERVAL 1 DAY) IN UNNEST(${observed}),
    SAFE_DIVIDE(COUNTIF(DATE_ADD(cohort_day, INTERVAL 1 DAY) IN UNNEST(active_days)), COUNT(*)), NULL) AS d1_rate,
  IF(DATE_ADD(cohort_day, INTERVAL 7 DAY) IN UNNEST(${observed}),
    COUNTIF(DATE_ADD(cohort_day, INTERVAL 7 DAY) IN UNNEST(active_days)), NULL) AS d7_returned,
  IF(DATE_ADD(cohort_day, INTERVAL 7 DAY) IN UNNEST(${observed}),
    SAFE_DIVIDE(COUNTIF(DATE_ADD(cohort_day, INTERVAL 7 DAY) IN UNNEST(active_days)), COUNT(*)), NULL) AS d7_rate
FROM facts GROUP BY cohort_day, sdk_platform ORDER BY cohort_day, market
`;
}

const counts = ["new_installs", "first_match_starters", "first_match_completers", "second_match_starters"] as const;
const nullable = ["first_match_completion_rate", "second_match_start_rate", "d1_returned", "d1_rate", "d7_returned", "d7_rate"] as const;
const raw = (value: unknown): unknown => value && typeof value === "object" && "value" in value ? (value as {value: unknown}).value : value;
function numeric(value: unknown): number {
  const v = raw(value);
  if ((typeof v !== "number" && typeof v !== "string") || v === "" || !Number.isFinite(Number(v))) throw new Error("조회 숫자 형식 오류");
  return Number(v);
}
export function mapMatgoCohortRow(row: Record<string, unknown>) {
  return {
    cohort_day: String(raw(row.cohort_day)), market: String(row.market),
    ...Object.fromEntries(counts.map(key => [key, numeric(row[key])])) as Record<typeof counts[number], number>,
    ...Object.fromEntries(nullable.map(key => [key, row[key] == null ? null : numeric(row[key])])) as Record<typeof nullable[number], number | null>,
  };
}
