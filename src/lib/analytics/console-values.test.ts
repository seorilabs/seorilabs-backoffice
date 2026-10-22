import assert from "node:assert/strict";
import test from "node:test";
import { mergeConsoleRaw, consoleAdTotal, consoleCoveredAdMetrics, hasConsoleAdObservation, sumConsoleValues, isCompleteConsoleMetric } from "./console-values";

const android = { date: "2026-10-11", impression: 6, estimatedEarning: 34 };
const ios = { date: "2026-10-11", impression: 2, estimatedEarning: 12 };
test("다른 수집에서 확인한 OS 원본을 합치고 빈 값은 건너뛴다", () => {
  const raw = mergeConsoleRaw({ iaaByOs: { IOS: ios }, age: [1] }, { iaaByOs: { ANDROID: android, IOS: null }, age: null });
  assert.deepEqual(raw, { iaaByOs: { ANDROID: android, IOS: ios }, age: [1] });
  assert.deepEqual(consoleAdTotal(raw, "2026-10-11"), { iaaImpressions: 8, iaaEarningKrw: 46 });
  assert.equal(consoleAdTotal(raw, "2026-10-12"), null);
  assert.equal(consoleAdTotal({ iaaByOs: { ANDROID: android } }, "2026-10-11"), null);
  assert.equal(hasConsoleAdObservation({ iaaByOs: { ANDROID: { ...android, impression: -1 } } }, "2026-10-11"), false);
});
test("광고 원본의 명시적인 0도 이전 값보다 우선한다", () => {
  const raw = mergeConsoleRaw({ iaaByOs: { ANDROID: android, IOS: ios } }, { iaaByOs: { IOS: { ...ios, impression: 0, estimatedEarning: 0 } } });
  assert.deepEqual(consoleAdTotal(raw, "2026-10-11"), { iaaImpressions: 6, iaaEarningKrw: 34 });
});
test("미확인 값의 합계는 0과 구별한다", () => {
  assert.equal(sumConsoleValues([null, undefined]), null);
  assert.equal(sumConsoleValues([null, 0]), null);
  assert.equal(sumConsoleValues([null, 3, 7]), null);
  assert.equal(sumConsoleValues([0, 3, 7]), 10);
});

test("공식 합계가 있어도 없는 OS 원본을 확인한 것으로 바꾸지 않는다", () => {
  const raw = { iaaTotal: { ...ios, estimatedEarning: 4 }, iaaByOs: { IOS: ios } };
  assert.equal(consoleAdTotal(raw, ios.date)?.iaaEarningKrw, 4);
  assert.deepEqual(consoleCoveredAdMetrics(raw, ios.date), ["iaa.IOS"]);
});

test("조회 구간이 바뀌면 이전 구간의 분포·잔존 집계를 섞지 않는다", () => {
  const raw = mergeConsoleRaw({ window: { start: "2026-09-01", end: "2026-10-11" }, referrer: [1], age: [2], retention: { value: 3 }, iaaByOs: { IOS: ios } },
    { window: { start: "2026-10-01", end: "2026-10-11" }, gender: [4] });
  assert.equal(raw.referrer, undefined); assert.equal(raw.age, undefined); assert.equal(raw.retention, undefined);
  assert.deepEqual(raw.gender, [4]); assert.deepEqual(raw.iaaByOs, { IOS: ios });
});

test("같은 조회 구간의 키 순서만 달라지면 확인된 분포를 보존한다", () => {
  const raw = mergeConsoleRaw({ window: { start: "2026-10-01", end: "2026-10-11" }, age: [2] },
    { window: { end: "2026-10-11", start: "2026-10-01" } });
  assert.deepEqual(raw.age, [2]);
});

test("원장 백필과 수집은 부분 행을 완료로 승격하지 않는다", () => {
  const row = { iaaImpressions: 0, iaaEarningKrw: 0, iapTrxAmountKrw: 0, iapSettlementKrw: 0, payingUsers: 0 };
  assert.equal(isCompleteConsoleMetric(row), true);
  assert.equal(isCompleteConsoleMetric({ ...row, iapTrxAmountKrw: null }), false);
  assert.equal(isCompleteConsoleMetric({ ...row, raw: { missingMetrics: ["session"] } }), false);
  assert.equal(isCompleteConsoleMetric({ ...row, raw: { missingMetrics: [] } }), true);
});

test("원본의 특수 키가 광고 원본을 상속시키지 않는다", () => {
  const raw = mergeConsoleRaw(null, JSON.parse(JSON.stringify({ ["__proto__"]: { iaaByOs: { ANDROID: android, IOS: ios } } })));
  assert.equal(Object.getPrototypeOf(raw), Object.prototype);
  assert.equal(consoleAdTotal(raw, "2026-10-11"), null);
});
