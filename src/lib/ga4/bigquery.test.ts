import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDailyBreakdownsSql,
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
