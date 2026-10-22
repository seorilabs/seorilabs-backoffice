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
  assert.equal(result.days[0].dau, undefined); assert.equal(result.days[0].avgSessionSec, 3.5);
  assert.equal(result.days[0].iaaEarningKrw, 34); assert.equal(result.days[0].payingUsers, 0);
  assert.deepEqual(result.days[0].raw?.missingMetrics, []);
  assert.deepEqual(result.days[0].raw?.iaaByOs, { ANDROID: input.android.dailyReports[0], IOS: input.ios.dailyReports[0] });
});
test("빠진 지표만 건너뛰고 확인된 지표는 남긴다", () => {
  for (const change of [
    { ios: { dailyReports: [] } }, { iap: { metric: [] } }, { session: undefined },
    { android: { dailyReports: [{ date: "2026-10-11", impression: -1, estimatedEarning: 0 }] } },
    { iap: { metric: [...fixture().iap.metric, ...fixture().iap.metric] } }, { dau: {} },
  ]) {
    const result = normalizeConsoleResponses({ ...fixture(), ...change }, "2026-10-11", "2026-10-11");
    assert.equal(result.days.length, 1); assert.equal(result.missing.length, 1);
    assert.equal(result.days[0].avgSessionSec, "session" in change ? undefined : 3.5);
  }
});
test("실제 조회와 같은 배열 날짜의 DAU·신규 값을 매핑하고 비정상 키는 보류한다", () => {
  const dau = { au: [{ dateKey: [2026, 10, 11], value: 7 }], newAu: [{ dateKey: [2026, 10, 11], value: 3 }] };
  const result = normalizeConsoleResponses({ ...fixture(), dau }, "2026-10-11", "2026-10-11");
  assert.equal(result.days[0].dau, 7); assert.equal(result.days[0].newUsers, 3);
  const malformed = normalizeConsoleResponses({ ...fixture(), dau: { ...dau, au: [{ dateKey: "2026/10/11", value: 7 }] } }, "2026-10-11", "2026-10-11");
  assert.equal(malformed.days.length, 1); assert.deepEqual(malformed.missing[0].metrics, ["dau"]);
});

test("IOS 광고와 결제가 없어도 Android 원본과 DAU·세션은 저장 대상으로 반환한다", () => {
  const input = { ...fixture(), ios: { dailyReports: [] }, iap: { metric: [] } };
  const result = normalizeConsoleResponses(input, "2026-10-11", "2026-10-11");
  assert.equal(result.days.length, 1);
  const day = result.days[0];
  assert.equal(day.avgSessionSec, 3.5);
  assert.equal(day.iaaEarningKrw, undefined);
  assert.equal(day.iapTrxAmountKrw, undefined);
  assert.deepEqual(day.raw?.iaaByOs, { ANDROID: input.android.dailyReports[0] });
  assert.deepEqual(result.missing[0].metrics, ["iaa.IOS", "iap"]);
});

test("모든 지표가 없는 날짜는 행을 만들지 않는다", () => {
  const input = { dau: { au: [], newAu: [] }, session: { metric: [] }, android: { dailyReports: [] }, ios: { dailyReports: [] }, iap: { metric: [] } };
  assert.equal(normalizeConsoleResponses(input, "2026-10-11", "2026-10-11").days.length, 0);
});

test("한 OS가 비어도 공식 합계는 저장하고 OS 결측은 그대로 남긴다", () => {
  const input = { ...fixture(), android: { dailyReports: [] },
    total: { dailyReports: [{ date: "2026-10-11", impression: 1, estimatedEarning: 4 }] } };
  const result = normalizeConsoleResponses(input, "2026-10-11", "2026-10-11");
  assert.equal(result.days[0].iaaEarningKrw, 4);
  assert.equal(result.days[0].iaaImpressions, 1);
  assert.deepEqual(result.missing[0].metrics, ["iaa.ANDROID"]);
  assert.deepEqual(result.days[0].raw?.iaaTotal, input.total.dailyReports[0]);
});

test("일별 공식 합계가 없는 날짜는 기간 합계로 0을 만들지 않는다", () => {
  const input = { ...fixture(), android: { dailyReports: [] }, ios: { dailyReports: [] },
    total: { summary: { totalEstimatedEarning: 0 }, dailyReports: [] } };
  const result = normalizeConsoleResponses(input, "2026-10-11", "2026-10-11");
  assert.equal(result.days[0].iaaEarningKrw, undefined);
});

test("배열 날짜의 한 OS도 원본 병합에 쓸 정규화된 날짜로 보존한다", () => {
  const result = normalizeConsoleResponses({ ...fixture(), android: { dailyReports: [{ date: [2026, 10, 11], impression: 6, estimatedEarning: 34 }] }, ios: { dailyReports: [] } }, "2026-10-11", "2026-10-11");
  assert.deepEqual(result.days[0].raw?.iaaByOs, { ANDROID: { date: "2026-10-11", impression: 6, estimatedEarning: 34 } });
});
