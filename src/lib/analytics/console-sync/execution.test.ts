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


test("입력 거부와 저장 대조 실패도 실행 실패다", () => {
  assert.equal(consoleExecutionFailed({ state: "partial", results: [{ errors: [], storageErrors: [], skipped: ["invalid date"] }] }), true);
  assert.equal(consoleExecutionFailed({ state: "partial", results: [{ errors: [], storageErrors: [], verification: { expected: 2, verified: 1, mismatched: ["2026-10-23"] } }] }), true);
});

test("운영 중지에 따른 정상 제외와 잘못된 앱 식별자를 구분한다", () => {
  const base = { state: "partial", results: [{ errors: [], storageErrors: [], skipped: [{ key: "paused", reason: "App 운영 중지(status=PAUSED)", category: "excluded" }], verification: { expected: 0, verified: 0, mismatched: [] } }] };
  assert.equal(consoleExecutionFailed(base), false);
  assert.equal(consoleExecutionFailed({ ...base, results: [{ ...base.results[0], skipped: [{ key: "unknown", reason: "App 매핑 없음", category: "invalid" }] }] }), true);
});
