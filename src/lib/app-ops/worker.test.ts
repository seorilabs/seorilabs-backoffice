import assert from "node:assert/strict";
import test from "node:test";

import { safeAppOpsErrorForTest } from "./worker";

test("worker 오류에서 bearer와 긴 credential 후보를 제거한다", () => {
  const message = safeAppOpsErrorForTest(
    new Error(`Bearer secret-token ${"a".repeat(100)}`),
  );
  assert.doesNotMatch(message, /secret-token/);
  assert.doesNotMatch(message, /a{80}/);
  assert.match(message, /\[REDACTED\]/);
});
