import type { OperatorCommandRun } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { currentDiscordMemberRoles } from "@/lib/notifications/discord";
import { hasDiscordCapability } from "@/lib/discord/roles";
import { assertCanReview, directApprovalEnabled, providerError, targetHash, ApprovalCredentialError, reviewMatches } from "./policy";
import { z } from "zod";
const paramsSchema = z.object({ approvalId: z.string(), targetHash: z.string(), githubId: z.string(), decision: z.enum(["approved", "rejected"]), reason: z.string().max(1000) });

export async function recoverApproval(id: string) {
  const { getInstallationOctokit, repo } = await import("./github");
  const { approvalAlert, refreshApprovalCard, observeApprovalRun } = await import("./monitor");
  const row = await prisma.deploymentApproval.findUniqueOrThrow({ where: { id } });
  if (!row.actionCommandId || !["SENDING", "UNKNOWN"].includes(row.actionState)) return;
  try {
    const client = await getInstallationOctokit();
    const { data } = await client.rest.actions.getReviewsForRun({ ...repo, run_id: Number(row.runId) });
    const found = data.find(review => reviewMatches(review, { commandId: row.actionCommandId!, githubId: String(row.actorGithubId), environmentId: String(row.environmentId), decision: row.decision! }));
    if (found) {
      await prisma.deploymentApproval.update({ where: { id }, data: { actionState: "CONFIRMED", decidedAt: new Date() } });
      await prisma.auditLog.create({ data: { actorLogin: row.actorLogin, action: "deployment.review.recovered", entityType: "deployment_approval", entityId: id, payload: { commandId: row.actionCommandId, decision: row.decision } } });
      await prisma.operatorCommandRun.updateMany({ where: { id: row.actionCommandId, status: { in: ["PROCESSING", "FAILED"] } }, data: { status: "SUCCEEDED", error: null, summary: "GitHub 승인 이력으로 결과 확인", completedAt: new Date() } });
      await observeApprovalRun(Number(row.runId));
      await refreshApprovalCard(id);
      return;
    }
  } catch { /* 조회 실패는 미확정 상태를 유지한다. */ }
  await prisma.deploymentApproval.update({ where: { id }, data: { actionState: "UNKNOWN" } });
  await approvalAlert(`unknown:${id}`, `플랫폼 승인 처리 결과 미확정. 자동 재전송하지 않습니다.\nhttps://github.com/${row.repository}/actions/runs/${row.runId}`);
  await refreshApprovalCard(id);
}
export async function recoverUncertainApprovals() {
  const rows = await prisma.deploymentApproval.findMany({ where: { actionState: { in: ["SENDING", "UNKNOWN"] }, actionStartedAt: { lt: new Date(Date.now() - 60_000) } } });
  for (const row of rows) await recoverApproval(row.id);
}

async function executionDependencies() {
  const { approverClient, readRun, pending, readTarget } = await import("./github");
  const { observeApprovalRun, refreshApprovalCard } = await import("./monitor");
  return { prisma, currentDiscordMemberRoles, hasDiscordCapability, approverClient, readRun, pending, readTarget, observeApprovalRun, refreshApprovalCard, recoverApproval };
}
export async function executeDeploymentApproval(command: OperatorCommandRun, dependencies?: Awaited<ReturnType<typeof executionDependencies>>) {
  const { prisma, currentDiscordMemberRoles, hasDiscordCapability, approverClient, readRun, pending, readTarget, observeApprovalRun, refreshApprovalCard, recoverApproval } = dependencies ?? await executionDependencies();
  const params = paramsSchema.parse(command.params);
  const row = await prisma.deploymentApproval.findUniqueOrThrow({ where: { id: params.approvalId } });
  if (!command.confirmedAt || Date.now() - command.confirmedAt.getTime() > 600_000 || Date.now() - command.createdAt.getTime() > 600_000) throw new Error("승인 확인 만료");
  if (!directApprovalEnabled(row.environment)) throw new Error("Discord 직접 승인 비활성");
  if (params.decision === "rejected" && !params.reason.trim()) throw new Error("거절 사유 필요");
  if (!hasDiscordCapability(await currentDiscordMemberRoles(command.actorDiscordUserId), "release_approval")) throw new Error("현재 Discord 승인 역할 없음");
  const link = await prisma.discordAccountLink.findUnique({ where: { discordUserId: command.actorDiscordUserId } });
  if (!link || String(link.githubId) !== params.githubId) throw new Error("GitHub 계정 연결 변경 또는 해제");
  const user = await prisma.user.findUnique({ where: { githubId: link.githubId } });
  if (!user?.allowlisted) throw new Error("Backoffice 접근 권한 없음");
  let client;
  try { client = await approverClient(link.githubId); } catch (error) { throw new Error(error instanceof ApprovalCredentialError ? error.message : providerError(error)); }
  const run = await readRun(client, Number(row.runId)).catch(error => { throw new Error(providerError(error)); });
  const item = (await pending(client, run.id).catch(error => { throw new Error(providerError(error)); })).find(p => String(p.environment.id) === String(row.environmentId) && p.environment.name === row.environment);
  if (!item) { await observeApprovalRun(run.id); throw new Error("GitHub에서 이미 처리됐거나 환경이 변경됨"); }
  const target = await readTarget(client, run, row.environment).catch(() => { throw new Error("배포 대상 artifact 조회 실패 또는 실행·대상 불일치"); });
  assertCanReview({ currentUserCanApprove: item.current_user_can_approve, githubId: String(link.githubId), triggeringActorId: String(run.triggering_actor?.id), actorId: String(run.actor?.id), expectedAttempt: row.runAttempt, actualAttempt: run.run_attempt!, expectedSha: row.sourceSha, actualSha: run.head_sha, expectedTargetHash: params.targetHash, actualTargetHash: targetHash(target) });
  // 쓰기 직전 요청 단위 CAS. worker 재시작/다른 interaction도 이 행에서 단 한 번만 전송한다.
  const claimed = await prisma.$transaction(async tx => {
    const currentLink = await tx.discordAccountLink.findUnique({ where: { githubId: link.githubId } });
    if (currentLink?.discordUserId !== command.actorDiscordUserId) throw new Error("계정 연결 해제됨");
    const claim = await tx.deploymentApproval.updateMany({ where: { id: row.id, actionState: "IDLE", providerState: "WAITING", targetHash: params.targetHash }, data: { actionState: "SENDING", actionCommandId: command.id, actorGithubId: link.githubId, actorLogin: user.login, decision: params.decision, actionStartedAt: new Date() } });
    if (claim.count) await tx.auditLog.create({ data: { actorLogin: user.login, action: "deployment.review.requested", entityType: "deployment_approval", entityId: row.id, payload: { commandId: command.id, decision: params.decision, reason: params.reason, targetHash: params.targetHash } } });
    return claim.count === 1;
  });
  if (!claimed) throw new Error("이미 처리 중이거나 처리된 승인 요청");
  try {
    await client.rest.actions.reviewPendingDeploymentsForRun({ owner: "seorilabs", repo: "platform", run_id: run.id, environment_ids: [Number(row.environmentId)], state: params.decision, comment: `backoffice:${command.id}\n${params.reason || "Discord에서 승인"}` });
    await prisma.deploymentApproval.update({ where: { id: row.id }, data: { actionState: "CONFIRMED", decidedAt: new Date() } });
  } catch {
    await recoverApproval(row.id);
    const latest = await prisma.deploymentApproval.findUniqueOrThrow({ where: { id: row.id } });
    if (latest.actionState !== "CONFIRMED") throw new Error("GitHub 처리 결과 미확정 — 자동 재전송 중단");
  }
  await prisma.auditLog.create({ data: { actorLogin: user.login, action: "deployment.review.confirmed", entityType: "deployment_approval", entityId: row.id, payload: { commandId: command.id, decision: params.decision } } });
  await observeApprovalRun(run.id);
  await refreshApprovalCard(row.id);
  return { summary: params.decision === "approved" ? "GitHub 승인 반영 — 배포 결과 별도 확인" : "GitHub 거절 반영" };
}
