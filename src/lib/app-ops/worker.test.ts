import assert from "node:assert/strict";
import test from "node:test";

import {
  lizardOperationInputForTest,
  safeAppOpsErrorForTest,
} from "./worker";

test("worker 오류에서 bearer와 긴 credential 후보를 제거한다", () => {
  const message = safeAppOpsErrorForTest(
    new Error(`Bearer secret-token ${"a".repeat(100)}`),
  );
  assert.doesNotMatch(message, /secret-token/);
  assert.doesNotMatch(message, /a{80}/);
  assert.match(message, /\[REDACTED\]/);
});

test("worker는 Production 감사용 운영자와 사유를 adapter에 전달한다", () => {
  const input = lizardOperationInputForTest({
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    operation: "iap-ledger.grant-production-entitlement",
    intent: "mutate",
    params: {
      player_ref: "uid-1",
      entitlement_id: "sp_galaxy_gecko",
    },
    actorLogin: "magicsih",
    reason: "CS 지급",
  } as never);
  assert.equal(input.actorLogin, "magicsih");
  assert.equal(input.reason, "CS 지급");
  assert.deepEqual(input.params, {
    player_ref: "uid-1",
    entitlement_id: "sp_galaxy_gecko",
  });
});
