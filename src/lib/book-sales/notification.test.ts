import test from "node:test";
import assert from "node:assert/strict";
import { bookSalesChangeNotification } from "./notification";
import { parseBookSalesInput, type BookSalesSnapshot } from "./contract";
import { reportDecision } from "@/lib/notifications/report-policy";

const now = new Date("2026-10-23T10:00:00Z");
const base = { schemaVersion: 1, account: "kdp-wellknowngeek", month: "2026-10",
  capturedAt: now.toISOString(), runId: "86c49447-08b4-4989-bd01-910a2bd7070d",
  kind: "snapshot", periodEnd: "2026-10-23", sourceHash: "a".repeat(64), rows: [] };
const snapshot = (rows: unknown[] = []): BookSalesSnapshot => parseBookSalesInput({ ...base, rows }, now) as BookSalesSnapshot;
const order = { kind: "orders", date: "2026-10-10", title: "Example", identifier: "B000000001",
  marketplace: "Amazon.com", format: "unknown", paidUnits: 2, freeUnits: 0 };

test("신규 판매와 정정을 운영알림에 보내고 발송 정책이 숨기지 않는다", () => {
  const event = bookSalesChangeNotification(snapshot(), snapshot([order]), now)!;
  assert.deepEqual(event.destinations, [{ provider: "DISCORD", key: "ops-alerts" }]);
  assert.match(event.payload.text, /2/);
  assert.equal(reportDecision(event).send, true);
  assert.ok(bookSalesChangeNotification(snapshot([order]), snapshot(), now));
});

test("같은 사실의 재수집과 빈 첫 관측은 알리지 않는다", () => {
  assert.equal(bookSalesChangeNotification(null, snapshot(), now), null);
  const current = snapshot([order]);
  assert.equal(bookSalesChangeNotification(current, { ...current, sourceHash: "b".repeat(64),
    periodEnd: "2026-10-24", capturedAt: "2026-10-24T00:00:00Z" }, now), null);
  assert.equal(bookSalesChangeNotification(snapshot([order, { ...order, date: "2026-10-11" }]),
    snapshot([{ ...order, date: "2026-10-11" }, order]), now), null);
});

test("되돌림은 새 실행 ID로 알리고 금액은 예상값과 통화를 보존한다", () => {
  const previous = snapshot([order]); const current = snapshot();
  const first = bookSalesChangeNotification(previous, current, now)!;
  const reverted = bookSalesChangeNotification(current, { ...previous, runId: "846aeab9-c873-4de5-ab97-3e5d2452abec" }, now)!;
  assert.notEqual(first.dedupeKey, reverted.dedupeKey);
  assert.match(reverted.payload.text, /예상/);
});
