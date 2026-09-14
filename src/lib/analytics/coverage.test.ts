import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  METRIC_OBSERVATION_STATES,
  isObserved,
  impliesLanded,
  sealRule,
} from "@/lib/analytics/coverage";

test("관측됨은 값을 본 것과 0 임을 본 것 둘뿐", () => {
  assert.deepEqual(
    METRIC_OBSERVATION_STATES.filter(isObserved),
    ["observed", "empty"],
  );
  // 미착지·실패·대상아님은 분모를 채우지 않는다. 이 셋이 관측으로 새면
  // 합계가 다시 "일부만 센 값"이 된다.
  for (const state of ["not_landed", "failed", "not_applicable"] as const) {
    assert.equal(isObserved(state), false, state);
  }
});

test("소스 테이블 존재를 뜻하는 상태만 landedAt 을 찍는다", () => {
  assert.deepEqual(METRIC_OBSERVATION_STATES.filter(impliesLanded), ["observed", "empty"]);
});

test("GA4 는 같은 상태로 두 번 이상 봐야 봉인한다", () => {
  const base = { source: "ga4" as const, state: "observed" as const };
  // 첫 관측이 미완결 테이블이었을 수 있다. 한 번으로 봉인하면 낮은 값이 영구 고정된다.
  assert.equal(sealRule({ ...base, ageDays: 5, observations: 1 }), false);
  assert.equal(sealRule({ ...base, ageDays: 5, observations: 2 }), true);
  // 경과일도 함께 요구한다.
  assert.equal(sealRule({ ...base, ageDays: 1, observations: 9 }), false);
  assert.equal(sealRule({ ...base, ageDays: 2, observations: 2 }), true);
});

test("활동 0 도 봉인 대상이다(GA4)", () => {
  assert.equal(
    sealRule({ source: "ga4", state: "empty", ageDays: 3, observations: 2 }),
    true,
  );
});

test("콘솔은 경과일만 보고, empty 는 콘솔에 없다", () => {
  assert.equal(
    sealRule({ source: "ait_console", state: "observed", ageDays: 3, observations: 1 }),
    true,
  );
  assert.equal(
    sealRule({ source: "ait_console", state: "observed", ageDays: 2, observations: 9 }),
    false,
  );
  // 콘솔은 push 로만 들어와 "활동 0"을 관측할 수 없다.
  assert.equal(
    sealRule({ source: "ait_console", state: "empty", ageDays: 30, observations: 9 }),
    false,
  );
});

test("미착지·실패는 아무리 오래돼도 봉인되지 않는다", () => {
  for (const source of ["ga4", "ait_console"] as const) {
    for (const state of ["not_landed", "failed", "not_applicable"] as const) {
      assert.equal(
        sealRule({ source, state, ageDays: 365, observations: 99 }),
        false,
        `${source}/${state}`,
      );
    }
  }
});

// 소스 계약: 수집기가 창 전체를 돌지 않고 응답한 날짜만 돌면 "행 없음"이 다시
// 활동 0 과 미착지를 한꺼번에 뜻하게 된다. 그 회귀를 코드 모양으로 막는다.
test("소스 계약: 수집기는 창 전체를 돌고 착지 여부로 갈린다", () => {
  const source = readFileSync("src/lib/core/analytics-collect.ts", "utf8");
  assert.match(source, /for \(const day of days\) \{/u);
  assert.match(source, /if \(!landed\.has\(toGa4TableSuffix\(day\)\)\) \{[\s\S]{0,300}?state: "not_landed"/u);
  assert.match(source, /state: row \? "observed" : "empty"/u);
  // 실패가 관측된 칸을 덮으면 멀쩡한 과거가 "미수집"으로 보고된다.
  assert.match(source, /recordCollectionFailure\(/u);
  assert.doesNotMatch(source, /for \(const a of activity\)/u);
});

// 실패 기록이 관측된 칸을 거르는 것은 이 모듈 안에서만 보장된다.
test("소스 계약: 실패 기록은 observed·empty 칸을 건너뛴다", () => {
  const source = readFileSync("src/lib/analytics/coverage.ts", "utf8");
  assert.match(
    source,
    /recordCollectionFailure[\s\S]{0,900}?state: \{ in: \["observed", "empty"\] \}/u,
  );
});
