import assert from "node:assert/strict";
import test from "node:test";
import {
  clampRetention,
  MIN_D7_AGE_DAYS,
  WINDOW_DAYS,
} from "@/lib/core/analytics-collect";

const cohort = { d1Pct: 40, d3Pct: 20, d7Pct: 10 };

test("clampRetention: 코호트가 충분히 성숙하면 그대로 통과(age>=7)", () => {
  assert.deepEqual(clampRetention(cohort, 7), { d1Pct: 40, d3Pct: 20, d7Pct: 10 });
});

test("clampRetention: 아직 D7 미확정(age<7)이면 d7 만 null", () => {
  assert.deepEqual(clampRetention(cohort, 3), { d1Pct: 40, d3Pct: 20, d7Pct: null });
});

test("clampRetention: age=0(당일 코호트)이면 전부 null", () => {
  assert.deepEqual(clampRetention(cohort, 0), { d1Pct: null, d3Pct: null, d7Pct: null });
});

test("clampRetention: 코호트 데이터 없으면 전부 null", () => {
  assert.deepEqual(clampRetention(undefined, 30), {
    d1Pct: null,
    d3Pct: null,
    d7Pct: null,
  });
});

// ── 수집 창과 D7 의 관계 ────────────────────────────────────────────────
// dateWindow(end, N) 은 end-(N-1)..end 라 코호트 최대 age 가 N-1 이다. 창을 줄여
// N<=MIN_D7_AGE_DAYS 가 되면 d7Pct 를 남길 수 있는 행이 하나도 없고, 이 수집은
// upsert 라 창 안의 기존 d7Pct 까지 null 로 덮는다. 비용을 줄이려다 D7 을 영구히
// 비우는 실수가 조용히 들어오지 않게 고정한다.
test("수집 창은 D7 이 확정될 수 있는 길이여야 한다", () => {
  const maxCohortAge = WINDOW_DAYS - 1;
  assert.ok(
    maxCohortAge >= MIN_D7_AGE_DAYS,
    `창 ${WINDOW_DAYS}일은 최대 age ${maxCohortAge}라 d7(age>=${MIN_D7_AGE_DAYS})을 만들 수 없다`,
  );
  // 확정 기회가 하루뿐이면 수집이 한 번만 실패해도 그 날짜의 D7 이 영구 결손된다.
  assert.ok(maxCohortAge - MIN_D7_AGE_DAYS >= 1, "D7 확정 기회가 2일 이상이어야 한다");
});

test("clampRetention: 창 최대 age 에서 d7 이 실제로 남는다", () => {
  assert.equal(clampRetention(cohort, WINDOW_DAYS - 1).d7Pct, 10);
  assert.equal(clampRetention(cohort, MIN_D7_AGE_DAYS - 1).d7Pct, null);
});
