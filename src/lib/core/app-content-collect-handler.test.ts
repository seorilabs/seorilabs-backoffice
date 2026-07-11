import assert from "node:assert/strict";
import test from "node:test";
import { computeAppContentCollect } from "@/lib/core/app-content-collect-handler";
import type { ContentCollectResult } from "@/lib/core/app-content-metrics-collect";

// app-content-collect 라우트 핸들러 회귀 테스트(next/server 비의존). CronJob 이 치는
// 핵심 트리거의 인수조건(401/200 spread/500)을 잠근다.

const TOKEN = "secret-admin-token";

const sampleResult: ContentCollectResult = {
  endDate: "2026-07-10",
  windowDays: 3,
  targetApps: 1,
  upserts: 3,
  skipped: [],
  errors: [],
};

test("token 미제공 → 401, collect 미호출", async () => {
  let called = false;
  const res = await computeAppContentCollect(null, TOKEN, async () => {
    called = true;
    return sampleResult;
  });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: "unauthorized" });
  assert.equal(called, false);
});

test("token 불일치 → 401", async () => {
  const res = await computeAppContentCollect("wrong", TOKEN, async () => sampleResult);
  assert.equal(res.status, 401);
});

test("adminToken 미설정 → 401(누구도 통과 못함)", async () => {
  const res = await computeAppContentCollect(TOKEN, undefined, async () => sampleResult);
  assert.equal(res.status, 401);
});

test("token 일치 → 200 + collect 결과 spread", async () => {
  const res = await computeAppContentCollect(TOKEN, TOKEN, async () => sampleResult);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    ok: true,
    endDate: "2026-07-10",
    windowDays: 3,
    targetApps: 1,
    upserts: 3,
    skipped: [],
    errors: [],
  });
});

test("collect 예외 → 500 + 내부 메시지 미노출", async () => {
  const res = await computeAppContentCollect(TOKEN, TOKEN, async () => {
    throw new Error("BigQuery 내부 사정 blah blah");
  });
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "app content collect failed" });
  // 원문 에러 메시지가 응답에 새지 않는다.
  assert.ok(!JSON.stringify(res.body).includes("BigQuery"));
});
