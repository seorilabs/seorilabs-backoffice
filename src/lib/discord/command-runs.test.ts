import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmationClaimWhere,
  requiresOperatorConfirmation,
} from "@/lib/discord/command-policy";

test("되돌리기 어렵거나 외부에 공개되는 작업만 명시 확인을 요구한다", () => {
  for (const operation of [
    "release_create",
    "deploy",
    "develop_deploy",
    "index",
    "play_promote",
    "appstore_review_submit",
    "appstore_review_cancel",
  ]) {
    assert.equal(requiresOperatorConfirmation(operation), true, operation);
  }
  // 심사 생성·삭제·상태 조회는 같은 카드에서 되돌릴 수 있어 즉시 실행한다.
  for (const operation of [
    "release_preview",
    "develop_preview",
    "plan_generate",
    "appstore_review_create",
    "appstore_review_remove",
    "appstore_refresh",
  ]) {
    assert.equal(requiresOperatorConfirmation(operation), false, operation);
  }
});

test("확인 claim은 같은 요청자와 만료 전 대기 상태를 모두 요구한다", () => {
  const now = new Date("2026-08-18T00:00:00Z");
  assert.deepEqual(confirmationClaimWhere({ id: "run-1", actorDiscordUserId: "user-1", now }), {
    id: "run-1",
    actorDiscordUserId: "user-1",
    status: "AWAITING_CONFIRMATION",
    expiresAt: { gt: now },
  });
});
