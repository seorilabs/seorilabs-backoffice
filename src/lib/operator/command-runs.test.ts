import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmationClaimWhere,
  operationCapability,
  requiresOperatorConfirmation,
} from "@/lib/operator/command-policy";
import { hasOperatorCapability } from "@/lib/operator/roles";

test("되돌리기 어렵거나 외부에 공개되는 작업만 명시 확인을 요구한다", () => {
  for (const operation of [
    "release_create",
    "deploy",
    "snapshot_deploy",
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
    "snapshot_preview",
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
  assert.deepEqual(confirmationClaimWhere({ id: "run-1", actorUserId: "user-1", channelId:"CTEST", now }), {
    id: "run-1",
    actorUserId: "user-1",
    channelId:"CTEST",
    sourceProvider:"SLACK",
    status: "AWAITING_CONFIRMATION",
    expiresAt: { gt: now },
  });
});

test("기획 승인과 출시 승인은 각각의 현재 역할로 실행한다", () => {
  const planning = operationCapability("approval", { gate: "planning" });
  const release = operationCapability("approval", { gate: "release" });
  assert.equal(hasOperatorCapability(["product"], planning), true);
  assert.equal(hasOperatorCapability(["product"], release), false);
  for (const role of ["release_ops", "qa"]) {
    assert.equal(hasOperatorCapability([role], release), true, role);
    assert.equal(hasOperatorCapability([role], planning), false, role);
  }
  for (const gate of [undefined, "unknown", null]) {
    assert.throws(() => operationCapability("approval", { gate }), /승인 종류/);
  }
});

test("출시 승인 역할이 회수되면 기획 역할이 남아도 대기 승인을 실행하지 않는다", () => {
  const queued = { operation: "approval", params: { gate: "release" } };
  const capability = operationCapability(queued.operation, queued.params);
  assert.equal(hasOperatorCapability(["product", "release_ops"], capability), true);
  assert.equal(hasOperatorCapability(["product"], capability), false);
  assert.equal(hasOperatorCapability(["viewer"], capability), false);
});

test("단계 초안 생성은 기획 역할이 회수된 조회 사용자에게 허용되지 않는다", () => {
  const capability = operationCapability("stage_generate");
  assert.equal(hasOperatorCapability(["product"], capability), true);
  assert.equal(hasOperatorCapability(["viewer"], "read"), true);
  assert.equal(hasOperatorCapability(["viewer"], capability), false);
  assert.equal(hasOperatorCapability([], capability), false);
});

test("버그만 작성할 수 있는 역할도 본인 초안 등록을 실행할 수 있다", () => {
  const capability = operationCapability("draft_commit");
  for (const role of ["development", "qa", "cs"]) {
    assert.equal(hasOperatorCapability([role], "bug"), true, role);
    assert.equal(hasOperatorCapability([role], "planning"), false, role);
    assert.equal(hasOperatorCapability([role], capability), true, role);
  }
  assert.equal(hasOperatorCapability(["product"], capability), true);
  assert.equal(hasOperatorCapability(["viewer"], capability), false);
});
