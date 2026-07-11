import assert from "node:assert/strict";
import test from "node:test";
import { runPooled } from "@/lib/core/foam-content-collect";

test("runPooled: 모든 아이템을 처리하고 완료 수를 반환", async () => {
  const seen: number[] = [];
  const done = await runPooled([1, 2, 3, 4, 5], 2, async (n) => {
    seen.push(n);
  });
  assert.equal(done, 5);
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test("runPooled: 동시 실행 수가 limit 를 넘지 않는다", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await runPooled(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
  });
  assert.ok(maxInFlight <= 4, `maxInFlight ${maxInFlight} should be <= 4`);
});

test("runPooled: 빈 배열은 0 을 반환하고 fn 을 호출하지 않는다", async () => {
  let calls = 0;
  const done = await runPooled([], 4, async () => {
    calls++;
  });
  assert.equal(done, 0);
  assert.equal(calls, 0);
});

test("runPooled: fn 이 reject 하면 그대로 전파", async () => {
  await assert.rejects(
    runPooled([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
    }),
    /boom/,
  );
});
