import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmationClaimWhere,
  requiresOperatorConfirmation,
} from "@/lib/discord/command-policy";

test("릴리즈 생성·배포·재인덱싱만 명시 확인을 요구한다", () => {
  assert.equal(requiresOperatorConfirmation("release_create"), true);
  assert.equal(requiresOperatorConfirmation("deploy"), true);
  assert.equal(requiresOperatorConfirmation("index"), true);
  assert.equal(requiresOperatorConfirmation("release_preview"), false);
  assert.equal(requiresOperatorConfirmation("plan_generate"), false);
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
