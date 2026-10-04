import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueueNotification, requeueNotification } from "@/lib/notifications/outbox";
import { discordDestinations } from "@/lib/notifications/destinations";
import { getInstallationOctokit, pending, readRun, readTarget, repo } from "./github";
import { monitoringEnabled, providerError, reminderDue, REPOSITORY, targetHash } from "./policy";

export async function approvalAlert(key: string, text: string) {
  await enqueueNotification({ dedupeKey: `platform-approval-alert:${key}`, kind: "OPS_ALERT", payload: { text }, destinations: discordDestinations(["ops-alerts"]) });
}
export async function refreshApprovalCard(id: string) {
  const eventId = await enqueueNotification({ dedupeKey: `platform-approval:${id}`, kind: "OPS_ALERT", payload: { deploymentApprovalId: id }, destinations: discordDestinations(["release-ops"]) });
  await requeueNotification(eventId);
  const reminders = await prisma.notificationEvent.findMany({ where: { dedupeKey: { startsWith: `platform-approval-reminder:${id}:` } }, select: { id: true } });
  for (const reminder of reminders) await requeueNotification(reminder.id);
}
export async function observeApprovalRun(runId: number) {
  if (!monitoringEnabled()) return;
  const client = await getInstallationOctokit();
  try {
    const run = await readRun(client, runId);
    const environments = await pending(client, runId);
    for (const item of environments) {
      const name = item.environment.name;
      const environmentId = item.environment.id;
      if (!name || !environmentId || !["production", "staging"].includes(name)) continue;
      let target; let observationError: string | null = null;
      try { target = await readTarget(client, run, name); } catch { observationError = "배포 대상 artifact 없음 또는 실행·대상 불일치 — GitHub에서 확인"; }
      const now = new Date();
      const previous = await prisma.deploymentApproval.findUnique({ where: { repository_runId_runAttempt_environmentId: { repository: REPOSITORY, runId: BigInt(runId), runAttempt: run.run_attempt!, environmentId: BigInt(environmentId) } } });
      const row = await prisma.deploymentApproval.upsert({
        where: { repository_runId_runAttempt_environmentId: { repository: REPOSITORY, runId: BigInt(runId), runAttempt: run.run_attempt!, environmentId: BigInt(environmentId) } },
        create: { repository: REPOSITORY, runId: BigInt(runId), runAttempt: run.run_attempt!, environmentId: BigInt(environmentId), environment: name, sourceSha: run.head_sha, workflow: run.name ?? run.path, runNumber: run.run_number, waitingSince: now, observedAt: now, target: target ?? Prisma.DbNull, targetHash: target ? targetHash(target) : null, observationError },
        update: { observedAt: now, providerState: "WAITING", observationError, target: target ?? Prisma.DbNull, targetHash: target ? targetHash(target) : null },
      });
      if (previous && (previous.targetHash !== row.targetHash || previous.observationError !== row.observationError)) await refreshApprovalCard(row.id);
      // 카드 내용은 발송 시 live row에서 읽는다. 관측 시각 변경만으로 매분 다시 보내지 않는다.
      await enqueueNotification({ dedupeKey: `platform-approval:${row.id}`, kind: "OPS_ALERT", payload: { deploymentApprovalId: row.id }, destinations: discordDestinations(["release-ops"]) });
    }
    const tracked = await prisma.deploymentApproval.findMany({ where: { repository: REPOSITORY, runId: BigInt(runId) } });
    for (const row of tracked) {
      const stillWaiting = row.runAttempt === run.run_attempt && environments.some(p => String(p.environment.id) === String(row.environmentId));
      const providerState = row.runAttempt !== run.run_attempt ? "SUPERSEDED" : stillWaiting ? "WAITING" : run.status === "completed" ? run.conclusion ?? "completed" : run.status === "in_progress" ? "IN_PROGRESS" : "NOT_PENDING";
      await prisma.deploymentApproval.update({ where: { id: row.id }, data: { providerState, observedAt: new Date(), ...(!stillWaiting ? { observationError: null, nextReminderAt: null } : {}) } });
      if (row.providerState !== providerState) {
        await prisma.auditLog.create({ data: { action: "deployment.observed", entityType: "deployment_approval", entityId: row.id, payload: { previous: row.providerState, providerState, runAttempt: run.run_attempt ?? null } } });
        await refreshApprovalCard(row.id);
      }
    }
  } catch (error) {
    const message = providerError(error);
    await prisma.deploymentApproval.updateMany({ where: { runId: BigInt(runId), repository: REPOSITORY }, data: { observationError: message } });
    const affected = await prisma.deploymentApproval.findMany({ where: { runId: BigInt(runId), repository: REPOSITORY }, select: { id: true } });
    for (const row of affected) await refreshApprovalCard(row.id);
    await approvalAlert(`run:${runId}:${new Date().toISOString().slice(0, 13)}`, `${message}\nhttps://github.com/${REPOSITORY}/actions/runs/${runId}`);
  }
}
export async function reconcileDeploymentApprovals(now = new Date()) {
  if (!monitoringEnabled()) return;
  try {
    const client = await getInstallationOctokit();
    const waiting = await client.paginate(client.rest.actions.listWorkflowRunsForRepo, { ...repo, status: "waiting", per_page: 100 });
    const tracked = await prisma.deploymentApproval.findMany({ where: { providerState: { in: ["WAITING", "IN_PROGRESS", "NOT_PENDING"] } } });
    for (const id of new Set([...waiting.map(r => r.id), ...tracked.map(r => Number(r.runId))])) await observeApprovalRun(id);
    const rows = await prisma.deploymentApproval.findMany({ where: { providerState: "WAITING", actionState: "IDLE" } });
    for (const row of rows) {
      if (!row.initialNotifiedAt) continue;
      const unsent = await prisma.notificationDelivery.count({ where: { status: { in: ["PENDING", "PROCESSING", "DEAD_LETTER"] }, event: { dedupeKey: { startsWith: `platform-approval-reminder:${row.id}:` } } } });
      if (!reminderDue(row, now, unsent > 0)) continue;
      await prisma.$transaction(async tx => {
        const changed = await tx.deploymentApproval.updateMany({ where: { id: row.id, reminderSequence: row.reminderSequence, providerState: "WAITING", actionState: "IDLE" }, data: { reminderSequence: { increment: 1 }, nextReminderAt: new Date(now.getTime() + 120 * 60_000) } });
        if (!changed.count) return;
        await enqueueNotification({ dedupeKey: `platform-approval-reminder:${row.id}:${row.reminderSequence + 1}`, kind: "OPS_ALERT", payload: { deploymentApprovalId: row.id, reminder: true }, destinations: discordDestinations(["release-ops"]) }, tx);
      });
    }
    await prisma.notificationDelivery.updateMany({ where: { status: "DEAD_LETTER", nextAttemptAt: { lte: now }, event: { OR: [{ dedupeKey: { startsWith: "platform-approval:" } }, { dedupeKey: { startsWith: "platform-approval-reminder:" } }] } }, data: { status: "PENDING", attempts: 0 } });
    const failed = await prisma.notificationDelivery.findMany({ where: { lastError: { not: null }, NOT: { lastError: "야간 재알림 보류" }, event: { OR: [{ dedupeKey: { startsWith: "platform-approval:" } }, { dedupeKey: { startsWith: "platform-approval-reminder:" } }] } }, select: { id: true } });
    for (const item of failed) await approvalAlert(`delivery:${item.id}`, "플랫폼 승인 카드 전송 실패 — 알림 대기열과 Discord 채널 설정을 확인하세요.");
  } catch (error) { await approvalAlert(`scan:${now.toISOString().slice(0, 13)}`, providerError(error)); }
}
