import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConsoleResponses } from "./mapper";
export const fixture = () => ({
  dau: { au: [], newAu: [], age: [{ ageGroup: "20대", value: 1 }], referrer: [] },
  session: { metric: [{ dateKey: [2026, 10, 11], value: 3.5 }] },
  android: { dailyReports: [{ date: "2026-10-11", impression: 6, estimatedEarning: 34, ecpm: 10 }] },
  ios: { dailyReports: [{ date: "2026-10-11", impression: 0, estimatedEarning: 0 }] },
  iap: { metric: [{ trxDate: "2026-10-11", trxAmount: 0, settlementAmount: 0, pu: 0 }] },
});
test("확인된 0, 미집계 DAU와 OS 원본을 구분한다", () => {
  const input = fixture(); const result = normalizeConsoleResponses(input, "2026-10-11", "2026-10-11");
  assert.equal(result.days.length, 1); assert.deepEqual(result.missing, []);
  assert.equal(result.days[0].dau, null); assert.equal(result.days[0].avgSessionSec, 3.5);
  assert.equal(result.days[0].iaaEarningKrw, 34); assert.equal(result.days[0].payingUsers, 0);
  assert.deepEqual(result.days[0].raw?.iaaByOs, { ANDROID: input.android.dailyReports[0], IOS: input.ios.dailyReports[0] });
});
test("실패·빈 필수값·음수 횟수·중복 날짜를 0으로 저장하지 않는다", () => {
  for (const change of [
    { ios: { dailyReports: [] } }, { iap: { metric: [] } }, { session: undefined },
    { android: { dailyReports: [{ date: "2026-10-11", impression: -1, estimatedEarning: 0 }] } },
    { iap: { metric: [...fixture().iap.metric, ...fixture().iap.metric] } }, { dau: {} },
  ]) {
    const result = normalizeConsoleResponses({ ...fixture(), ...change }, "2026-10-11", "2026-10-11");
    assert.equal(result.days.length, 0); assert.equal(result.missing.length, 1);
  }
});
