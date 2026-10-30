import assert from "node:assert/strict";
import test from "node:test";
import { buildMatgoCohortsSql, mapMatgoCohortRow } from "./matgo-cohorts-sql";
import { queryMatgoCohorts } from "./matgo-cohorts";

const target = { firebaseProject: "matgo-seori", dataset: "analytics_561605001" };
test("실제 내보내기 날짜와 동의한 신규 저장, 테스트 제외를 조회한다", () => {
  const sql = buildMatgoCohortsSql(target, "20261023", "20261030", new Set(["20261023", "20261030"]));
  assert.match(sql, /analytics_ready/);
  assert.match(sql, /traffic='production' AND install_cohort='fresh'/);
  assert.match(sql, /NOT COALESCE\(i.test_user, FALSE\)/);
  assert.match(sql, /debug_mode/);
  assert.match(sql, /_dbg/);
  assert.match(sql, /first_complete >= first_begin/);
  assert.match(sql, /second_begin >= first_complete/);
  assert.match(sql, /INTERVAL 7 DAY\) IN UNNEST\(\[DATE '2026-10-23', DATE '2026-10-30'\]\)/);
  assert.doesNotMatch(sql, /@[a-z_]+/);
});
test("날짜와 데이터셋 식별자 오염은 쿼리 전에 차단한다", () => {
  assert.throws(() => buildMatgoCohortsSql(target, "20260230", "20261030", new Set()), /날짜/);
  assert.throws(() => buildMatgoCohortsSql({ ...target, dataset: "analytics_1` WHERE TRUE" }, "20261023", "20261030", new Set()), /식별자/);
});
test("미성숙 재방문과 없는 비율은 null로 보존한다", () => {
  const row = mapMatgoCohortRow({ cohort_day: { value: "2026-10-23" }, market: "google-play", new_installs: { value: "2" }, first_match_starters: "0", first_match_completers: "0", second_match_starters: "0", first_match_completion_rate: null, second_match_start_rate: null, d1_returned: "0", d1_rate: "0", d7_returned: null, d7_rate: null });
  assert.equal(row.new_installs, 2);
  assert.equal(row.d1_rate, 0);
  assert.equal(row.d7_rate, null);
  assert.equal(row.first_match_completion_rate, null);
  assert.throws(() => mapMatgoCohortRow({ ...row, new_installs: "not a number" }), /숫자/);
});
test("내보내기가 없으면 원시 조회나 0행 지표를 만들지 않는다", async () => {
  let queries = 0;
  const result = await queryMatgoCohorts(target, "20261023", "20261030", {
    landed: async () => new Set(), query: async () => { queries++; return []; },
  });
  assert.equal(queries, 0);
  assert.equal(result.status, "unavailable");
  assert.equal(result.missingDays.length, 8);
  assert.deepEqual(result.cohorts, []);
});
test("일부 날짜 누락과 관측된 신규 코호트 없음은 구분한다", async () => {
  const result = await queryMatgoCohorts(target, "20261023", "20261030", {
    landed: async () => new Set(["20261023"]), query: async () => [],
  });
  assert.equal(result.status, "partial");
  assert.equal(result.observedThrough, "2026-10-23");
  assert.equal(result.missingDays.length, 7);
  const complete = await queryMatgoCohorts(target, "20261030", "20261030", {
    landed: async () => new Set(["20261030"]), query: async () => [],
  });
  assert.equal(complete.status, "no_new_install_cohort");
});
