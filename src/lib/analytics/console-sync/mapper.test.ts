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
test("응답 오류·비정상 응답만 빠진 지표로 남기고 확인된 지표는 남긴다", () => {
  for (const change of [
    { ios: undefined }, { iap: { metric: null } }, { session: undefined },
    { android: { dailyReports: [{ date: "2026-10-11", impression: -1, estimatedEarning: 0 }] } },
    { iap: { metric: [...fixture().iap.metric, ...fixture().iap.metric] } }, { dau: {} },
  ]) {
    const result = normalizeConsoleResponses({ ...fixture(), ...change }, "2026-10-11", "2026-10-11");
    assert.equal(result.days.length, 1); assert.equal(result.missing.length, 1);
    assert.equal(result.days[0].avgSessionSec, "session" in change ? undefined : 3.5);
  }
});

test("확정 전 마지막 날의 광고·결제 행 부재는 실패가 아니라 집계 대기다", () => {
  for (const change of [{ ios: { dailyReports: [] } }, { iap: { metric: [] } }]) {
    const result = normalizeConsoleResponses({ ...fixture(), ...change }, "2026-10-11", "2026-10-11");
    assert.deepEqual(result.missing, []);
    assert.equal(result.pending.length, 1);
    assert.deepEqual(result.days[0].raw?.pendingMetrics, result.pending[0].metrics);
  }
});
test("실제 조회와 같은 배열 날짜의 DAU·신규 값을 매핑하고 비정상 키는 보류한다", () => {
  const dau = { au: [{ dateKey: [2026, 10, 11], value: 7 }], newAu: [{ dateKey: [2026, 10, 11], value: 3 }] };
  const result = normalizeConsoleResponses({ ...fixture(), dau }, "2026-10-11", "2026-10-11");
  assert.equal(result.days[0].dau, 7); assert.equal(result.days[0].newUsers, 3);
  const malformed = normalizeConsoleResponses({ ...fixture(), dau: { ...dau, au: [{ dateKey: "2026/10/11", value: 7 }] } }, "2026-10-11", "2026-10-11");
  assert.equal(malformed.days.length, 1); assert.deepEqual(malformed.missing[0].metrics, ["dau"]);
});

test("확정 전 날짜는 IOS 광고와 결제가 없어도 0을 만들지 않고 Android 원본과 DAU·세션만 저장한다", () => {
  const input = { ...fixture(), ios: { dailyReports: [] }, iap: { metric: [] } };
  const result = normalizeConsoleResponses(input, "2026-10-11", "2026-10-11");
  assert.equal(result.days.length, 1);
  const day = result.days[0];
  assert.equal(day.avgSessionSec, 3.5);
  assert.equal(day.iaaEarningKrw, undefined);
  assert.equal(day.iapTrxAmountKrw, undefined);
  assert.deepEqual(day.raw?.iaaByOs, { ANDROID: input.android.dailyReports[0] });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.pending[0].metrics, ["iaa.IOS", "iap"]);
});

test("확정된 날짜는 정상 응답의 광고·결제 행 부재를 활동 0으로 채운다", () => {
  // 실제 콘솔 응답(2026-11-17 조회): happy-farm Android는 노출이 있던 날만 행이 있고, 활동 없는 날은 결제 metric이 빈 배열이다.
  const input = { ...fixture(), ios: { dailyReports: [] }, iap: { metric: [] }, total: { dailyReports: [{ date: "2026-10-11", impression: 6, estimatedEarning: 34 }] } };
  const result = normalizeConsoleResponses(input, "2026-10-11", "2026-10-12");
  const day = result.days.find((row) => row.date === "2026-10-11")!;
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.pending, [{ date: "2026-10-12", metrics: ["iaa.ANDROID", "iaa.IOS", "iap"] }]);
  assert.equal(day.iaaImpressions, 6); assert.equal(day.iaaEarningKrw, 34);
  assert.equal(day.iapTrxAmountKrw, 0); assert.equal(day.iapSettlementKrw, 0); assert.equal(day.payingUsers, 0);
  assert.deepEqual(day.raw?.missingMetrics, []); assert.deepEqual(day.raw?.pendingMetrics, []);
  assert.deepEqual(day.raw?.iaaByOs, { ANDROID: input.android.dailyReports[0] });
});

test("확정된 날짜에 일별 합계가 없으면 OS 행 합으로, OS 행도 없으면 0으로 저장한다", () => {
  const only = normalizeConsoleResponses({ ...fixture(), ios: { dailyReports: [] }, total: { dailyReports: [] } }, "2026-10-11", "2026-10-11", "2026-10-11");
  assert.equal(only.days[0].iaaImpressions, 6); assert.equal(only.days[0].iaaEarningKrw, 34);
  const none = normalizeConsoleResponses({ ...fixture(), android: { dailyReports: [] }, ios: { dailyReports: [] }, total: { dailyReports: [] } }, "2026-10-11", "2026-10-11", "2026-10-11");
  assert.equal(none.days[0].iaaImpressions, 0); assert.equal(none.days[0].iaaEarningKrw, 0);
});

test("응답 오류가 있는 OS는 확정된 날짜라도 0으로 채우지 않는다", () => {
  const result = normalizeConsoleResponses({ ...fixture(), ios: undefined, iap: undefined }, "2026-10-11", "2026-10-11", "2026-10-11");
  assert.equal(result.days[0].iaaEarningKrw, undefined); assert.equal(result.days[0].iapTrxAmountKrw, undefined);
  assert.deepEqual(result.missing[0].metrics, ["iaa.IOS", "iap"]);
});

test("모든 지표가 없는 날짜는 행을 만들지 않고, 확정된 날짜만 활동 0으로 반환한다", () => {
  const input = { dau: { au: [], newAu: [] }, session: { metric: [] }, android: { dailyReports: [] }, ios: { dailyReports: [] }, iap: { metric: [] }, total: { dailyReports: [] } };
  const result = normalizeConsoleResponses(input, "2026-10-10", "2026-10-11");
  assert.equal(result.days.length, 0);
  assert.deepEqual(result.emptyDates, ["2026-10-10"]);
  assert.deepEqual(result.pending.map((row) => row.date), ["2026-10-11"]);
  assert.deepEqual(result.missing, []);
  const failed = normalizeConsoleResponses({ ...input, total: undefined, iap: undefined }, "2026-10-10", "2026-10-11");
  assert.deepEqual(failed.emptyDates, []);
  assert.deepEqual(failed.missing.map((row) => row.metrics), [["iap"], ["iap"]]);
});

test("한 OS가 비어도 공식 합계는 저장하고 확정 전 OS 부재는 집계 대기로 남긴다", () => {
  const input = { ...fixture(), android: { dailyReports: [] },
    total: { dailyReports: [{ date: "2026-10-11", impression: 1, estimatedEarning: 4 }] } };
  const result = normalizeConsoleResponses(input, "2026-10-11", "2026-10-11");
  assert.equal(result.days[0].iaaEarningKrw, 4);
  assert.equal(result.days[0].iaaImpressions, 1);
  assert.deepEqual(result.pending[0].metrics, ["iaa.ANDROID"]);
  assert.deepEqual(result.days[0].raw?.iaaTotal, input.total.dailyReports[0]);
});

test("확정 전 날짜는 일별 공식 합계가 없을 때 기간 합계로 0을 만들지 않는다", () => {
  const input = { ...fixture(), android: { dailyReports: [] }, ios: { dailyReports: [] },
    total: { summary: { totalEstimatedEarning: 0 }, dailyReports: [] } };
  const result = normalizeConsoleResponses(input, "2026-10-11", "2026-10-11");
  assert.equal(result.days[0].iaaEarningKrw, undefined);
});

test("배열 날짜의 한 OS도 원본 병합에 쓸 정규화된 날짜로 보존한다", () => {
  const result = normalizeConsoleResponses({ ...fixture(), android: { dailyReports: [{ date: [2026, 10, 11], impression: 6, estimatedEarning: 34 }] }, ios: { dailyReports: [] } }, "2026-10-11", "2026-10-11");
  assert.deepEqual(result.days[0].raw?.iaaByOs, { ANDROID: { date: "2026-10-11", impression: 6, estimatedEarning: 34 } });
});
