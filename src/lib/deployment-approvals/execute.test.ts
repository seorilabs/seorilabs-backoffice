import assert from "node:assert/strict";
import test from "node:test";
import type { OperatorCommandRun } from "@prisma/client";
import { executeDeploymentApproval } from "./execute";
import { targetHash, type DeploymentTarget } from "./policy";
const sha = "a".repeat(40);
const target: DeploymentTarget = { version: 1, repository: "seorilabs/platform", runId: "10", runAttempt: 1, sourceSha: sha, imageSha: sha, environment: "staging", workflow: "deploy-staging.yml", image: `asia-northeast3-docker.pkg.dev/seorilabs-platform/platform/platform:${sha}`, targets: ["cloud-run:seorilabs-platform:asia-northeast3:platform-api-stg"] };
function fixture() {
  process.env.PLATFORM_DISCORD_APPROVAL_ENVIRONMENTS = "staging";
  let sends = 0;
  let roles = true;
  let linked = true;
  let allowed = true;
  let canApprove = true;
  let apiError = false;
  let tokenError = false;
  let waiting = true;
  let recovered = false;
  const live = { id: 10, run_attempt: 1, head_sha: sha, actor: { id: 2 }, triggering_actor: { id: 2 } };
  const row = { id: "approval1", runId: 10n, environmentId: 20n, environment: "staging", sourceSha: sha, runAttempt: 1, actionState: "IDLE", targetHash: targetHash(target) };
  const db = {
    deploymentApproval: {
      findUniqueOrThrow: async () => row,
      updateMany: async () => { if (row.actionState !== "IDLE") return { count: 0 }; row.actionState = "SENDING"; return { count: 1 }; },
      update: async ({ data }: { data: { actionState: string } }) => { row.actionState = data.actionState; return row; },
    },
    discordAccountLink: { findUnique: async () => linked ? { githubId: 1n, discordUserId: "discord1" } : null },
    user: { findUnique: async () => ({ allowlisted: allowed, login: "reviewer" }) },
    auditLog: { create: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  const deps = {
    prisma: db,
    currentDiscordMemberRoles: async () => ["release"], hasDiscordCapability: () => roles,
    approverClient: async () => { if (tokenError) throw { status: 401 }; return { rest: { actions: { reviewPendingDeploymentsForRun: async () => { sends++; if (apiError) throw new Error("timeout"); } } } }; },
    readRun: async () => live,
    pending: async () => waiting ? [{ environment: { id: 20, name: "staging" }, current_user_can_approve: canApprove }] : [],
    readTarget: async () => target,
    observeApprovalRun: async () => {}, refreshApprovalCard: async () => {},
    recoverApproval: async () => { row.actionState = recovered ? "CONFIRMED" : "UNKNOWN"; },
  } as unknown as NonNullable<Parameters<typeof executeDeploymentApproval>[1]>;
  const command = { id: "command1", createdAt: new Date(), confirmedAt: new Date(), actorDiscordUserId: "discord1", params: { approvalId: row.id, githubId: "1", targetHash: targetHash(target), decision: "approved", reason: "" } } as unknown as OperatorCommandRun;
  return { row, live, command, deps, sends: () => sends, denyRole: () => { roles = false; }, unlink: () => { linked = false; }, denyUser: () => { allowed = false; }, denyGitHub: () => { canApprove = false; }, expireToken: () => { tokenError = true; }, timeout: () => { apiError = true; }, external: () => { waiting = false; }, recover: () => { recovered = true; } };
}
test("정상 승인·거절은 요청마다 GitHub에 한 번만 전달", async () => {
  for (const decision of ["approved", "rejected"]) {
    const f = fixture(); f.command.params = { ...(f.command.params as object), decision, reason: "배포 중단" };
    await executeDeploymentApproval(f.command, f.deps);
    assert.equal(f.sends(), 1); assert.equal(f.row.actionState, "CONFIRMED");
  }
});
test("중복 클릭과 동시 worker는 같은 승인 요청을 한 번만 실행", async () => {
  const f = fixture();
  const results = await Promise.allSettled([executeDeploymentApproval(f.command, f.deps), executeDeploymentApproval({ ...f.command, id: "command2" }, f.deps)]);
  assert.equal(f.sends(), 1); assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
});
test("권한·계정·토큰·외부 처리·재실행·SHA·확인 만료는 쓰기 이전 차단", async () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [f => f.denyRole(), f => f.unlink(), f => f.denyUser(), f => f.denyGitHub(), f => f.expireToken(), f => f.external(), f => { f.live.run_attempt = 2; }, f => { f.live.head_sha = "b".repeat(40); }, f => { f.command.confirmedAt = new Date(0); }, f => { f.command.params = { ...(f.command.params as object), targetHash: "changed" }; }];
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(executeDeploymentApproval(f.command, f.deps)); assert.equal(f.sends(), 0); }
});
test("timeout 뒤 미확정과 worker 재시작은 자동 재전송하지 않는다", async () => {
  const f = fixture(); f.timeout();
  await assert.rejects(executeDeploymentApproval(f.command, f.deps));
  assert.equal(f.row.actionState, "UNKNOWN");
  await assert.rejects(executeDeploymentApproval(f.command, f.deps));
  assert.equal(f.sends(), 1);
});
test("timeout 뒤 GitHub 이력으로 처리 확인되면 완료로 복구", async () => {
  const f = fixture(); f.timeout(); f.recover();
  await executeDeploymentApproval(f.command, f.deps);
  assert.equal(f.row.actionState, "CONFIRMED"); assert.equal(f.sends(), 1);
});

test("환경 정책이 허용하면 실행자와 같은 승인자도 provider에 한 번 전달", async () => {
  const f = fixture(); f.live.actor.id = 1; f.live.triggering_actor.id = 1;
  await executeDeploymentApproval(f.command, f.deps);
  assert.equal(f.sends(), 1);
});
