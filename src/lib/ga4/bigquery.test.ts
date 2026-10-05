import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDailyBreakdownsSql,
  buildDailyActivitySql,
  buildCohortRetentionSql,
  decideLocation,
  mapDailyActivityRow,
} from "@/lib/ga4/bigquery";

test("decideLocation: override 가 최우선", () => {
  assert.equal(
    decideLocation({ override: "asia-northeast3", cached: "US", fetched: "europe-west1" }),
    "asia-northeast3",
  );
});

test("decideLocation: override 없으면 캐시", () => {
  assert.equal(decideLocation({ cached: "asia-southeast3", fetched: "US" }), "asia-southeast3");
});

test("decideLocation: 캐시 없으면 메타 조회값", () => {
  assert.equal(decideLocation({ fetched: "asia-northeast3" }), "asia-northeast3");
});

test("decideLocation: 셋 다 없으면 US 폴백 대신 에러(비US 리전 오조회 방지)", () => {
  assert.throws(() => decideLocation({ fetched: null }), /location 을 확인할 수 없음/);
  assert.throws(() => decideLocation({}), /location 을 확인할 수 없음/);
});

test("decideLocation: 공백 override 는 무시하고 폴백 체인", () => {
  assert.equal(decideLocation({ override: "  ", cached: "asia-northeast3" }), "asia-northeast3");
});

test("mapDailyActivityRow: 광의 이벤트·CTA·완료·실제 노출을 서로 섞지 않는다", () => {
  const row = mapDailyActivityRow({
    date: "2026-07-29",
    dau: { value: "9" },
    new_users: 1,
    engaged_users: 7,
    avg_engage_sec: 120.5,
    ad_users: 9,
    broad_ad_events: 14185,
    ad_cta_users: 9,
    ad_cta_impressions: 14136,
    ad_completed_users: 1,
    ad_completions: 2,
    network_ad_users: 0,
    network_ad_impressions: 0,
  });

  assert.equal(row.adImpressions, 14185);
  assert.equal(row.adCtaImpressions, 14136);
  assert.equal(row.adCompletions, 2);
  assert.equal(row.networkAdImpressions, 0);
  assert.equal(row.adCtaUsers, 9);
  assert.equal(row.adCompletedUsers, 1);
});

test("buildDailyBreakdownsSql: event platform을 GA4 stream platform보다 우선한다", () => {
  const sql = buildDailyBreakdownsSql(
    { firebaseProject: "slotmachine-game-495cc", dataset: "analytics_547294653" },
    "20260801",
    "20260808",
  );

  const eventPlatform = "WHERE ep.key = 'platform'";
  const streamPlatform = "NULLIF(UPPER(platform), '')";
  assert.ok(sql.indexOf(eventPlatform) >= 0, "event_params.platform 추출이 빠졌습니다");
  assert.ok(sql.indexOf(streamPlatform) > sql.indexOf(eventPlatform), "stream platform이 먼저 적용됩니다");
  assert.match(sql, /slotmachine-game-495cc\.analytics_547294653\.events_\*/);
  assert.match(sql, /_TABLE_SUFFIX BETWEEN '20260801' AND '20260808'/);
});

// 앱 버전 분해가 빠지면 "권장 안내를 켠 뒤 최신 버전 비중이 올랐나"를
// 답할 방법이 없다. presence 분포는 최근 150초 창이라 추세를 못 준다.
test("buildDailyBreakdownsSql: 앱 버전 차원을 같은 스캔에서 집계한다", () => {
  const sql = buildDailyBreakdownsSql(
    { firebaseProject: "happy-farm-tycoon", dataset: "analytics_1" },
    "20260801",
    "20260808",
  );

  assert.match(sql, /IFNULL\(NULLIF\(app_info\.version, ''\), '\(unknown\)'\) AS app_version_dim/);
  assert.match(sql, /UNION ALL SELECT date, 'app_version', app_version_dim/);
  // base CTE를 한 번만 스캔한다. 차원이 늘어도 events_* 스캔은 하나다.
  assert.equal((sql.match(/FROM `happy-farm-tycoon/g) ?? []).length, 1);
});


test("신규 사용자: 앱 first_open과 웹 first_visit을 사용자 단위로 집계한다", () => {
  const sql = buildDailyActivitySql({ firebaseProject: "alley-market-match", dataset: "analytics_551185839" }, "20261001", "20261005");
  assert.match(sql, /COUNT\(DISTINCT IF\(event_name IN \('first_open', 'first_visit'\), user_pseudo_id, NULL\)\) AS new_users/);
});

test("신규 코호트: 첫 활동을 설치로 추정하지 않고 수집 경로별 첫 실행으로 연결한다", () => {
  const sql = buildCohortRetentionSql({ firebaseProject: "alley-market-match", dataset: "analytics_551185839" }, "20261001", "20261005");
  assert.match(sql, /AND event_name IN \('first_open', 'first_visit'\)/);
  assert.match(sql, /JOIN cohort c USING \(stream_id, user_pseudo_id\)/);
  assert.doesNotMatch(sql, /MIN\(d\) AS cohort_day FROM activity/);
});

test("수집 경로: 기존 MP 플랫폼 값과 별개로 실제 GA4 스트림을 표시한다", () => {
  const sql = buildDailyBreakdownsSql({ firebaseProject: "alley-market-match", dataset: "analytics_551185839" }, "20261001", "20261005");
  assert.match(sql, /CONCAT\(IFNULL\(NULLIF\(platform, ''\), '\(unknown\)'\), ' · ', stream_id\) AS stream_dim/);
  assert.match(sql, /UNION ALL SELECT date, 'stream', stream_dim/);
});


test("잔존율: 관찰 기간이 아직 끝나지 않은 D1/D3/D7을 0%로 만들지 않는다", () => {
  const sql = buildCohortRetentionSql({ firebaseProject: "alley-market-match", dataset: "analytics_551185839" }, "20261001", "20261003");
  for (const n of [1, 3, 7]) {
    assert.ok(sql.includes(`IF(DATE_ADD(cohort_day, INTERVAL ${n} DAY) <= PARSE_DATE('%Y%m%d', '20261003')`));
  }
  assert.match(sql, /NULL\) AS d7_pct/);
});
