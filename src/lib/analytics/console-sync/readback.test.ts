import test from "node:test";
import assert from "node:assert/strict";
import { verifyConsoleRows } from "./readback";

const now = new Date("2026-10-23T10:00:00Z");
const days = [{ date: "2026-10-22", dau: 4, newUsers: 2, avgSessionSec: 3.5,
  iaaImpressions: 10, iaaEarningKrw: 1.2, iapTrxAmountKrw: 20, iapSettlementKrw: 14, payingUsers: 1 }];
const row = { ...days[0], collectedAt: now, date: new Date("2026-10-22T00:00:00Z"), raw: null };

test("방금 저장한 날짜와 모든 제공된 값이 일치해야 검증한다", () => {
  assert.deepEqual(verifyConsoleRows(days, [row], now), { expected: 1, verified: 1, mismatched: [] });
  const wrong = verifyConsoleRows(days, [{ ...row, dau: 9 }], now);
  assert.equal(wrong.verified, 0);
  assert.deepEqual(wrong.mismatched, ["2026-10-22"]);
});

test("최신 날짜가 같아도 오래된 행, 누락된 행과 다른 날짜는 통과하지 않는다", () => {
  for (const rows of [[], [{ ...row, collectedAt: new Date(now.getTime() - 1) }],
    [{ ...row, date: new Date("2026-10-21T00:00:00Z") }]]) {
    assert.equal(verifyConsoleRows(days, rows, now).verified, 0);
  }
});

test("미집계 값은 0으로 검증하지 않고 제공된 OS별 원값도 대조한다", () => {
  const raw = { iaaByOs: { IOS: { date: "2026-10-22", impression: 2, estimatedEarning: 1 } } };
  const partial = [{ ...days[0], dau: null, raw }];
  assert.equal(verifyConsoleRows(partial, [{ ...row, dau: 8, raw }], now).verified, 1);
  assert.equal(verifyConsoleRows(partial, [{ ...row, raw: { iaaByOs: {} } }], now).verified, 0);
});
