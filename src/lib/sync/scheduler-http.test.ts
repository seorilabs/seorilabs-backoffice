import assert from "node:assert/strict";
import test from "node:test";
import { scheduledRunHttpStatus } from "@/lib/sync/scheduler-http";

test("scheduler completed만 HTTP 200이다", () => {
  assert.equal(
    scheduledRunHttpStatus({ state: "completed", ok: true, failed: 0 }),
    200,
  );
});

test("scheduler busy는 HTTP 409로 재시도 가능하게 드러낸다", () => {
  assert.equal(
    scheduledRunHttpStatus({ state: "busy", ok: false, failed: 0 }),
    409,
  );
});

test("scheduler partial은 HTTP 500으로 실패 처리한다", () => {
  assert.equal(
    scheduledRunHttpStatus({ state: "partial", ok: false, failed: 1 }),
    500,
  );
});
