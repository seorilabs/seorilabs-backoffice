import assert from "node:assert/strict";
import test from "node:test";
import { consoleExecutionFailed } from "./execution";

test("자료 결측만 남은 부분 완료와 실제 조회·저장·알림 실패를 구분한다", () => {
  const partial = { state: "partial", blocked: [], results: [{ errors: [], storageErrors: [] }] };
  assert.equal(consoleExecutionFailed(partial), false);
  assert.equal(consoleExecutionFailed({ ...partial, blocked: ["rate limit"] }), true);
  assert.equal(consoleExecutionFailed({ ...partial, results: [{ errors: ["timeout"], storageErrors: [] }] }), true);
  assert.equal(consoleExecutionFailed({ ...partial, results: [{ errors: [], storageErrors: ["db"] }] }), true);
  assert.equal(consoleExecutionFailed({ ...partial, notification: { state: "failed" } }), true);
  assert.equal(consoleExecutionFailed({ state: "failed" }), true);
});
