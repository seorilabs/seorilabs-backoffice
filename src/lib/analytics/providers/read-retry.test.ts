import assert from "node:assert/strict";
import test from "node:test";
import { fetchReadWithRetry } from "./read-retry";

test("503 뒤 정상 응답은 개별 읽기만 재시도하며 Retry-After를 따른다", async () => {
  let calls = 0, time = 0; const waits: number[] = [];
  const response = await fetchReadWithRetry("https://example.invalid", {}, { now: () => time, random: () => 0,
    sleep: async (ms) => { waits.push(ms); time += ms; },
    request: async () => ++calls === 1 ? new Response("busy", { status: 503, headers: { "Retry-After": "2" } }) : new Response("ok"),
  });
  assert.equal(response.status, 200); assert.equal(calls, 2); assert.deepEqual(waits, [2000]);
});

test("권한 실패와 남은 예산을 넘는 Retry-After는 반복하지 않는다", async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const response = await fetchReadWithRetry("https://example.invalid", {}, { budgetMs: 1000,
      request: async () => { calls++; return new Response("failed", { status, headers: { "Retry-After": "120" } }); },
      sleep: async () => assert.fail("예산을 넘는 대기"),
    });
    assert.equal(response.status, status); assert.equal(calls, 1);
  }
});

test("시간 초과는 새 signal로 최대 3회, 외부 취소는 즉시 중단한다", async () => {
  const signals = new Set<AbortSignal>(); let calls = 0;
  await assert.rejects(fetchReadWithRetry("https://example.invalid", {}, { sleep: async () => {}, request: async (_, init) => {
    calls++; signals.add(init!.signal!); throw new DOMException("timed out", "TimeoutError");
  } }), /timed out/);
  assert.equal(calls, 3); assert.equal(signals.size, 3);
  const controller = new AbortController(); controller.abort(); calls = 0;
  await assert.rejects(fetchReadWithRetry("https://example.invalid", { signal: controller.signal }, { request: async () => { calls++; throw new DOMException("cancelled", "AbortError"); } }), /cancelled/);
  assert.equal(calls, 1);
});
