import assert from "node:assert/strict";
import test from "node:test";
import type { DeploymentApproval } from "@prisma/client";
import { deliverApproval } from "./delivery";
function fixture() {
  const row = { id: "one", repository: "seorilabs/platform", sourceSha: "a".repeat(40), workflow: "Deploy", environment: "staging", runId: 1n, runAttempt: 1, runNumber: 1, providerState: "WAITING", actionState: "IDLE", waitingSince: new Date(), target: null } as DeploymentApproval;
  let sends = 0, edits = 0, recorded = 0, fail = false;
  const deps = { prisma: { deploymentApproval: { findUnique: async () => row, updateMany: async () => { recorded++; } } }, sendDiscord: async () => { sends++; return { ok: !fail, messageId: fail ? undefined : "message" }; }, editDiscord: async () => { edits++; return { ok: true, messageId: "message" }; } } as unknown as NonNullable<Parameters<typeof deliverApproval>[3]>;
  return { row, deps, sends: () => sends, edits: () => edits, recorded: () => recorded, fail: () => { fail = true; }, recover: () => { fail = false; } };
}
test("최초 알림은 야간에도 보내고 재알림만 09시까지 유예", async () => {
  const f = fixture(), now = new Date("2026-10-04T14:00:00Z");
  await deliverApproval({ deploymentApprovalId: "one" }, "release-ops", null, f.deps, now);
  const result = await deliverApproval({ deploymentApprovalId: "one", reminder: true }, "release-ops", null, f.deps, now);
  assert.equal(f.sends(), 1); assert.equal(result.ok, false); assert.equal(result.retryAfterMs, 10 * 60 * 60_000);
  await deliverApproval({ deploymentApprovalId: "one", reminder: true }, "release-ops", null, f.deps, new Date("2026-10-05T00:00:00Z"));
  assert.equal(f.sends(), 2);
});
test("처리된 요청의 발송 대기 재알림을 중단하고 기존 카드는 편집", async () => {
  const f = fixture(); f.row.providerState = "IN_PROGRESS";
  await deliverApproval({ deploymentApprovalId: "one", reminder: true }, "release-ops", null, f.deps);
  assert.equal(f.sends(), 0);
  await deliverApproval({ deploymentApprovalId: "one" }, "release-ops", "message", f.deps);
  assert.equal(f.edits(), 1); assert.equal(f.sends(), 0);
});
test("Discord 전송 실패 시 최초 발송 시각을 기록하지 않고 재시도 성공 뒤 기록", async () => {
  const f = fixture(); f.fail();
  assert.equal((await deliverApproval({ deploymentApprovalId: "one" }, "release-ops", null, f.deps)).ok, false);
  assert.equal(f.recorded(), 0); f.recover();
  assert.equal((await deliverApproval({ deploymentApprovalId: "one" }, "release-ops", null, f.deps)).ok, true);
  assert.equal(f.recorded(), 1);
});
