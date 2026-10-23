import test from "node:test";
import assert from "node:assert/strict";
import { parseBookSalesInput, summarizeBookSales, snapshotRunData } from "./contract";

const now = new Date("2026-10-23T10:00:00Z");
function snapshot() {
  return {
    kind: "snapshot", schemaVersion: 1, runId: "86c49447-08b4-4989-bd01-910a2bd7070d",
    account: "kdp-wellknowngeek", month: "2026-10", periodEnd: "2026-10-23",
    capturedAt: "2026-10-23T09:00:00Z", sourceHash: "a".repeat(64),
    rows: [
      { kind: "royalty", date: "2026-10-10", title: "Example", identifier: "B000000001", marketplace: "Amazon.com", format: "paperback", unitsSold: 3, refunds: 1, netUnits: 2, royalty: "3.58", currency: "USD", transactionType: "Standard - Paperback" },
      { kind: "orders", date: "2026-10-10", title: "Example", identifier: "B000000001", marketplace: "Amazon.com", format: "unknown", paidUnits: 3, freeUnits: 2 },
      { kind: "kenp", date: "2026-10", title: "Other", identifier: "B000000002", marketplace: "Amazon.co.uk", format: "ebook", pagesRead: 42, pagesListened: 7 },
    ],
  };
}

test("주문, 판매, 환불, 무료 배포, 통화와 미연결 확정 금액을 구분한다", () => {
  const input = parseBookSalesInput(snapshot(), now);
  assert.equal(input.kind, "snapshot");
  const summary = summarizeBookSales(input.kind === "snapshot" ? input : null);
  assert.equal(summary.totals?.netUnits, 2);
  assert.equal(summary.totals?.paidOrders, 3);
  assert.equal(summary.totals?.freeOrders, 2);
  assert.equal(summary.totals?.pagesRead, 42);
  assert.deepEqual(summary.totals?.estimatedRoyalties, { USD: "3.58" });
  assert.equal(summary.confirmedRoyalties, null);
  assert.equal(summary.payments, null);
  assert.equal(summary.books.length, 2);
});

test("누락은 0이 아니고 유효한 빈 보고서만 0이다", () => {
  assert.equal(summarizeBookSales(null).totals, null);
  const empty = parseBookSalesInput({ ...snapshot(), rows: [] }, now);
  assert.equal(summarizeBookSales(empty.kind === "snapshot" ? empty : null).totals?.netUnits, 0);
});

test("월, 달력일, 수집 시각, 환불 계산, 불필요한 필드를 검증한다", () => {
  for (const update of [
    { month: "2026-13" }, { periodEnd: "2026-11-01" },
    { capturedAt: "2026-10-24T00:00:00Z" }, { cookies: "secret" },
    { rows: [{ ...snapshot().rows[0], date: "2026-10-32" }] },
    { rows: [{ ...snapshot().rows[0], netUnits: 99 }] },
    { rows: [{ ...snapshot().rows[0], royalty: "NaN" }] },
  ]) assert.throws(() => parseBookSalesInput({ ...snapshot(), ...update }, now));
});

test("큰 금액도 소수점 오차 없이 통화별로만 합친다", () => {
  const base = snapshot().rows[0];
  const input = parseBookSalesInput({ ...snapshot(), rows: [
    { ...base, royalty: "0.1" }, { ...base, royalty: "0.2" }, { ...base, royalty: "0.1234", currency: "GBP" },
  ] }, now);
  assert.deepEqual(summarizeBookSales(input.kind === "snapshot" ? input : null).totals?.estimatedRoyalties, { USD: "0.3", GBP: "0.1234" });
});

test("같은 실행의 식별자는 안정적이고 내용은 지문으로 구분한다", () => {
  const first = snapshotRunData(parseBookSalesInput(snapshot(), now), now);
  const same = snapshotRunData(parseBookSalesInput(snapshot(), now), now);
  const changed = snapshotRunData(parseBookSalesInput({ ...snapshot(), rows: [] }, now), now);
  assert.equal(first.id, same.id);
  assert.equal(first.id, changed.id);
  assert.notEqual(first.coverage.digest, changed.coverage.digest);
});
