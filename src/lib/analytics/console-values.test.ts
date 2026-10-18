import assert from "node:assert/strict";
import test from "node:test";
import { mergeConsoleRaw, consoleAdTotal, hasConsoleAdObservation, sumConsoleValues } from "./console-values";

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
  assert.equal(sumConsoleValues([null, 0]), 0);
  assert.equal(sumConsoleValues([null, 3, 7]), 10);
});

test("원본의 특수 키가 광고 원본을 상속시키지 않는다", () => {
  const raw = mergeConsoleRaw(null, JSON.parse(JSON.stringify({ ["__proto__"]: { iaaByOs: { ANDROID: android, IOS: ios } } })));
  assert.equal(Object.getPrototypeOf(raw), Object.prototype);
  assert.equal(consoleAdTotal(raw, "2026-10-11"), null);
});
