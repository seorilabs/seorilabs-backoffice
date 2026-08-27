import assert from "node:assert/strict";
import test from "node:test";
import { computeReconcile } from "@/lib/sync/reconcile-handler";

const TOKEN = "test-admin-token";

test("reconcile token이 없으면 401이고 작업을 호출하지 않는다", async () => {
  let called = false;
  const response = await computeReconcile(null, TOKEN, async () => {
    called = true;
    return {
      repos: 1,
      succeeded: 1,
      failed: 0,
      state: "completed",
      ok: true,
    };
  });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: "unauthorized" });
  assert.equal(called, false);
});

test("reconcile token이 일치하면 결과를 반환한다", async () => {
  const response = await computeReconcile(TOKEN, TOKEN, async () => ({
    repos: 12,
    succeeded: 12,
    failed: 0,
    state: "completed",
    ok: true,
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    repos: 12,
    succeeded: 12,
    failed: 0,
    state: "completed",
    ok: true,
  });
});

test("reconcile busy는 409로 반환한다", async () => {
  const response = await computeReconcile(TOKEN, TOKEN, async () => ({
    repos: 0,
    succeeded: 0,
    failed: 0,
    state: "busy",
    ok: false,
  }));

  assert.equal(response.status, 409);
});

test("reconcile partial failure는 500으로 반환한다", async () => {
  const response = await computeReconcile(TOKEN, TOKEN, async () => ({
    repos: 12,
    succeeded: 11,
    failed: 1,
    state: "partial",
    ok: false,
  }));

  assert.equal(response.status, 500);
  assert.equal(response.body.failed, 1);
});

test("reconcile 내부 오류 원문을 응답에 노출하지 않는다", async () => {
  const response = await computeReconcile(TOKEN, TOKEN, async () => {
    throw new Error("provider private detail");
  });

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: "reconcile failed" });
  assert.ok(!JSON.stringify(response.body).includes("private detail"));
});
