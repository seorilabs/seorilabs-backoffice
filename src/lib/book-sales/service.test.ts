import test from "node:test";
import assert from "node:assert/strict";
import { ingestBookSales, readBookSales, type BookSalesStore, type StoredBookRun } from "./service";
import { handleBookSalesPost, BOOK_SALES_MAX_BODY_BYTES } from "./http";
import { parseBookSalesInput } from "./contract";

function memoryStore(): BookSalesStore {
  const runs = new Map<string, StoredBookRun>();
  return {
    async save(data) { if (!runs.has(data.id)) runs.set(data.id, data); return runs.get(data.id)!; },
    async latest(target, successOnly) { return [...runs.values()].filter((r) => r.target === target && (!successOnly || ["observed", "empty"].includes(r.status))).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null; },
  };
}
const now = new Date("2026-10-23T10:00:00Z");
const base = { schemaVersion: 1, account: "kdp-wellknowngeek", month: "2026-10", capturedAt: "2026-10-23T09:00:00Z", runId: "86c49447-08b4-4989-bd01-910a2bd7070d" };
const success = { ...base, kind: "snapshot", periodEnd: "2026-10-23", sourceHash: "a".repeat(64), rows: [{ kind: "orders", date: "2026-10-10", title: "Example", identifier: "B000000001", marketplace: "Amazon.com", format: "unknown", paidUnits: 2, freeUnits: 0 }] };

test("재전송은 같은 관측을 유지하고 실행 ID의 내용 충돌을 거부한다", async () => {
  const store = memoryStore();
  const first = await ingestBookSales(success, now, store);
  assert.deepEqual(await ingestBookSales(success, now, store), first);
  await assert.rejects(ingestBookSales({ ...success, rows: [] }, now, store), /BOOK_SALES_RUN_CONFLICT/);
});

test("정정 보고서에서 사라진 판매를 이전 보고서와 더하지 않는다", async () => {
  const store = memoryStore();
  await ingestBookSales(success, now, store);
  await ingestBookSales({ ...success, rows: [], runId: "846aeab9-c873-4de5-ab97-3e5d2452abec", capturedAt: "2026-10-23T09:30:00Z" }, now, store);
  const result = await readBookSales("2026-10", now, store);
  assert.equal(result.state, "empty");
  assert.equal(result.totals?.paidOrders, 0);
});

test("저장한 최신 변화만 한 번 알리고 늦은 과거 보고서와 재수집은 알리지 않는다", async () => {
  const store = memoryStore(); const events: unknown[] = [];
  store.notify = async (event) => { events.push(event); };
  await ingestBookSales(success, now, store);
  await ingestBookSales(success, now, store);
  assert.equal(events.length, 1);
  await ingestBookSales({ ...success, runId: "846aeab9-c873-4de5-ab97-3e5d2452abec", capturedAt: "2026-10-23T08:30:00Z", rows: [] }, now, store);
  await ingestBookSales({ ...success, runId: "846aeab9-c873-4de5-ab97-3e5d2452abed", capturedAt: "2026-10-23T09:30:00Z", sourceHash: "b".repeat(64) }, now, store);
  assert.equal(events.length, 1);
});

test("인증 실패는 마지막 성공 수량을 보존하고 재인증 상태를 표시한다", async () => {
  const store = memoryStore();
  await ingestBookSales(success, now, store);
  await ingestBookSales({ ...base, kind: "failure", errorCode: "KDP_AUTH_REQUIRED", runId: "846aeab9-c873-4de5-ab97-3e5d2452abec", capturedAt: "2026-10-23T09:30:00Z" }, now, store);
  const result = await readBookSales("2026-10", now, store);
  assert.equal(result.state, "needs_input");
  assert.equal(result.totals?.paidOrders, 2);
  assert.equal(result.errorCode, "KDP_AUTH_REQUIRED");
});

test("미수집과 오래된 성공을 구분하고 미래 월을 조회하지 않는다", async () => {
  const store = memoryStore();
  assert.equal((await readBookSales("2026-10", now, store)).totals, null);
  await ingestBookSales(success, now, store);
  assert.equal((await readBookSales("2026-10", new Date("2026-10-26T00:00:00Z"), store)).state, "stale");
  await assert.rejects(readBookSales("2026-13", now, store));
});

test("토큰을 검사한 뒤에만 본문과 저장 함수를 실행한다", async () => {
  let reads = 0;
  let writes = 0;
  const body = async () => { reads++; return JSON.stringify(success); };
  const save = async () => { writes++; return { runId: "test", status: "observed" }; };
  assert.equal((await handleBookSalesPost(null, "token", body, save)).status, 401);
  assert.equal(reads, 0); assert.equal(writes, 0);
  assert.equal((await handleBookSalesPost("token", "token", body, save)).status, 200);
  assert.equal(writes, 1);
  assert.equal((await handleBookSalesPost("token", "token", async () => "{", save)).status, 400);
  assert.equal((await handleBookSalesPost("token", "token", async () => "x".repeat(BOOK_SALES_MAX_BODY_BYTES + 1), save)).status, 413);
  assert.equal(writes, 1);
});

// 이전 2MB 한도를 넘는 정상 보고서를 보존한다.
test("8,000행의 정상 보고서는 전송 한도 안에서 저장 함수에 전달된다", async () => {
  const raw = { ...success, rows: Array.from({ length: 8_000 }, () => ({ ...success.rows[0], title: "책".repeat(600) })) };
  const body = JSON.stringify(raw);
  assert.ok(Buffer.byteLength(body) > 2_000_000);
  assert.ok(Buffer.byteLength(body) < BOOK_SALES_MAX_BODY_BYTES);
  const result = await handleBookSalesPost("token", "token", async () => body, async (value) => {
    const input = parseBookSalesInput(value, now);
    assert.equal(input.kind === "snapshot" ? input.rows.length : 0, 8_000);
    return { runId: "large-report", status: "observed" };
  });
  assert.equal(result.status, 200);
  assert.throws(() => parseBookSalesInput({ ...raw, rows: [...raw.rows, raw.rows[0]] }, now));
});
