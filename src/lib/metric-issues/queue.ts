import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { retryPrismaConflict } from "@/lib/prisma-conflict";
import { beginAutomationMutation } from "@/lib/control-plane/automation-mutation";
import type { JsonValue } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { registrationSlot, type RegistrationPolicy } from "./contracts";
import type { RegistrationResult } from "./engine";
import { isRejectedStatus } from "./post-outcome";
import { unresolvedRegistrationAttempts } from "./recovery";
export const REGISTRATION_KEY = "central-metric-issue-registration";
export const REGISTRATION_TEMPLATE = "metric-issue-registration-v1";
const actor = "system:metric-issue-registration", scope = "metric-issue-registration";
export const registrationConfigurationSchema = z.object({ enabled: z.boolean(), expectedUpdatedAt: z.string().datetime().nullable(), maxElapsedMs: z.number().int().min(60_000).max(600_000), maxTokens: z.number().int().min(2400).max(40000) }).strict();
const budgetSchema = registrationConfigurationSchema.omit({ enabled: true, expectedUpdatedAt: true });
export async function configureMetricRegistration(input: z.infer<typeof registrationConfigurationSchema> & { actor: string; requestId: string }) {
  const config = registrationConfigurationSchema.parse({ enabled: input.enabled, expectedUpdatedAt: input.expectedUpdatedAt, maxElapsedMs: input.maxElapsedMs, maxTokens: input.maxTokens }), identity = { requestId: input.requestId, actor: input.actor, operation: "metric-registration.configure", targetKey: REGISTRATION_KEY, request: config as unknown as JsonValue };
  const mutation = await beginAutomationMutation(identity);
  if (mutation.replay) return mutation.replay;
  return retryPrismaConflict(() => prisma.$transaction(async (db) => {
    const request = await db.automationMutationRequest.findUniqueOrThrow({ where: { requestId: input.requestId } });
    if (request.status === "COMPLETED") return request.response as JsonValue;
    const existing = await db.automationDefinition.findUnique({ where: { key: REGISTRATION_KEY } });
    if (existing && existing.updatedAt.toISOString() !== config.expectedUpdatedAt || !existing && config.expectedUpdatedAt !== null) throw new ControlPlaneError("설정 버전이 변경되었습니다.", 409, "VERSION_CONFLICT");
    const data = { template: REGISTRATION_TEMPLATE, agentKind: "API", maxAttempts: 1, schedule: "central-policy", enabled: config.enabled, pausedAt: config.enabled ? null : new Date(), configuration: { maxElapsedMs: config.maxElapsedMs, maxTokens: config.maxTokens } };
    const definition = existing ? await db.automationDefinition.update({ where: { id: existing.id }, data }) : await db.automationDefinition.create({ data: { key: REGISTRATION_KEY, ...data } });
    const response = { definitionId: definition.id, enabled: definition.enabled, updatedAt: definition.updatedAt.toISOString() };
    await db.automationMutationRequest.update({ where: { requestId: input.requestId }, data: { status: "COMPLETED", response, completedAt: new Date() } });
    await db.auditLog.create({ data: { actorLogin: input.actor, action: "analytics.issue-registration.configure", entityType: "AutomationDefinition", entityId: definition.id, payload: { requestId: input.requestId, enabled: config.enabled, maxElapsedMs: config.maxElapsedMs, maxTokens: config.maxTokens } } });
    return response;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
export async function claimMetricRegistration(policy: RegistrationPolicy, now = new Date()) {
  return retryPrismaConflict(() => prisma.$transaction(async (db) => {
    const definition = await db.automationDefinition.findUnique({ where: { key: REGISTRATION_KEY } });
    if (!definition?.enabled || definition.cancelledAt || definition.template !== REGISTRATION_TEMPLATE) return null;
    const budget = budgetSchema.parse(definition.configuration);
    const guard = await db.agentRepoGuard.findUnique({ where: { activeScopeKey: scope }, include: { run: { include: { leases: { where: { revokedAt: null }, orderBy: { generation: "desc" }, take: 1 } } } } });
    if (guard?.run.leases.some((lease) => lease.expiresAt > now)) return null;
    if (guard) {
      const generation = guard.run.leaseGeneration + 1;
      await db.agentLease.updateMany({ where: { runId: guard.runId, revokedAt: null }, data: { revokedAt: now, scopeKey: null } });
      const lease = await db.agentLease.create({ data: { runId: guard.runId, generation, tokenHash: createHash("sha256").update(randomUUID()).digest("hex"), workerId: actor, scopeKey: scope, expiresAt: new Date(now.getTime() + 1800_000), heartbeatAt: now } });
      await db.agentRun.update({ where: { id: guard.runId }, data: { leaseGeneration: generation, attempts: { increment: 1 } } });
      return { runId: guard.runId, leaseId: lease.id, generation, budget: budgetSchema.parse((guard.run.taskInput as { budget: unknown }).budget), recovery: true };
    }
    const slot = registrationSlot(now, policy.data.schedules.registration.localTimes);
    // 지난 예약을 한꺼번에 보충하지 않고 최신 슬롯만 한 번 실행한다.
    const occurrence = await db.automationOccurrence.upsert({ where: { definitionId_scheduledFor: { definitionId: definition.id, scheduledFor: slot } }, create: { definitionId: definition.id, scheduledFor: slot, idempotencyKey: `${scope}:${slot.toISOString()}`, triggerKind: "central-policy", status: "PENDING", result: { policySha: policy.sha, budget } }, update: {} });
    if (occurrence.status !== "PENDING") return null;
    const claimed = await db.automationOccurrence.updateMany({ where: { id: occurrence.id, status: "PENDING" }, data: { status: "RUNNING" } });
    if (!claimed.count) return null;
    const run = await db.agentRun.create({ data: { occurrenceId: occurrence.id, repoFullName: "seorilabs/.github", createsPr: false, labels: [], taskInput: { policySha: policy.sha, documentHash: policy.documentHash, budget }, status: "RUNNING", leaseGeneration: 1, attempts: 1, maxAttempts: 1, startedAt: now } });
    await db.agentRepoGuard.create({ data: { runId: run.id, repoFullName: run.repoFullName, activeScopeKey: scope } });
    const lease = await db.agentLease.create({ data: { runId: run.id, generation: 1, tokenHash: createHash("sha256").update(randomUUID()).digest("hex"), workerId: actor, scopeKey: scope, expiresAt: new Date(now.getTime() + 1800_000), heartbeatAt: now } });
    await db.agentRunEvent.create({ data: { runId: run.id, type: "METRIC_REGISTRATION_CLAIMED", actor, generation: 1, payload: { policySha: policy.sha, slot: slot.toISOString(), budget } } });
    return { runId: run.id, leaseId: lease.id, generation: 1, budget, recovery: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
export type RegistrationClaim = NonNullable<Awaited<ReturnType<typeof claimMetricRegistration>>>;
export async function registrationActive(claim: RegistrationClaim) {
  const now = new Date();
  return await prisma.agentLease.count({ where: { id: claim.leaseId, generation: claim.generation, revokedAt: null, expiresAt: { gt: new Date(now.getTime() + 60_000) }, run: { status: "RUNNING", leaseGeneration: claim.generation, occurrence: { definition: { enabled: true, cancelledAt: null } } } } }) === 1;
}
export async function registrationEvent(claim: RegistrationClaim, type: string, payload: unknown, requestId?: string) {
  const data = { runId: claim.runId, actor, type, generation: claim.generation, payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue, ...(requestId ? { requestId } : {}) };
  if (requestId) return prisma.agentRunEvent.createMany({ data: [data], skipDuplicates: true });
  return prisma.agentRunEvent.create({ data });
}
export function registrationAttemptId(runId: string, marker: string) { return `${runId}:attempt:${marker}`; }
export async function registrationAttempt(claim: RegistrationClaim, marker: string, intent: unknown) {
  return retryPrismaConflict(() => prisma.$transaction(async (db) => {
    // POST 직전 durable capability와 운영 중지 상태를 잠그고 재확인한다.
    const lease = await db.agentLease.findUnique({ where: { id: claim.leaseId }, include: { run: { include: { occurrence: { include: { definition: true } } } } } });
    if (!lease || lease.revokedAt || lease.expiresAt.getTime() <= Date.now() + 60_000 || lease.generation !== claim.generation || lease.run.leaseGeneration !== claim.generation || lease.run.status !== "RUNNING" || !lease.run.occurrence.definition.enabled || lease.run.occurrence.definition.cancelledAt) return false;
    if (!lease.run.startedAt || lease.run.startedAt.getTime() + claim.budget.maxElapsedMs <= Date.now() + 31_000) return false;
    const target = z.object({ appId: z.string(), repository: z.string() }).parse(intent);
    const app = await db.app.findUnique({ where: { id: target.appId }, select: { status: true, repoFullName: true } });
    if (!app || app.status !== "ACTIVE" || app.repoFullName !== target.repository) return false;
    const created = await db.agentRunEvent.createMany({ data: [{ runId: claim.runId, generation: claim.generation, actor, type: "METRIC_ISSUE_ATTEMPT", requestId: registrationAttemptId(claim.runId, marker), payload: JSON.parse(JSON.stringify({ marker, ...intent as object, attemptId: registrationAttemptId(claim.runId, marker) })) }], skipDuplicates: true });
    return created.count === 1;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
export async function registrationResult(claim: RegistrationClaim, row: RegistrationResult) {
  const attempted = row.attempted || row.status === "registered" || isRejectedStatus(row.rejectedStatus);
  const attemptId = attempted && row.marker ? row.attemptId ?? registrationAttemptId(claim.runId, row.marker) : undefined;
  const settled = row.status === "registered" || row.status === "needs_input" && isRejectedStatus(row.rejectedStatus);
  // 후보의 사전 판단과 실제 POST의 결과는 서로의 idempotency key를 사용하지 않는다.
  const requestId = attemptId ? `${attemptId}:${settled ? "settled" : "pending"}`
    : row.marker ? `${claim.runId}:candidate:${row.marker}:${row.status}` : undefined;
  await registrationEvent(claim, "METRIC_ISSUE_RESULT", { ...row, ...(attemptId ? { attemptId } : {}) }, requestId);
}
export async function finishMetricRegistration(claim: RegistrationClaim, reason: string, summary: unknown) {
  const now = new Date();
  await retryPrismaConflict(() => prisma.$transaction(async (db) => {
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: claim.runId } });
    if (run.leaseGeneration !== claim.generation || run.status !== "RUNNING") return;
    const events = await db.agentRunEvent.findMany({ where: { runId: run.id, type: { in: ["METRIC_ISSUE_ATTEMPT", "METRIC_ISSUE_RESULT"] } }, select: { type: true, payload: true } });
    const blocked = unresolvedRegistrationAttempts(events).length > 0;
    if (blocked) reason = "global-safety-blocked";
    await db.agentRunEvent.create({ data: { runId: run.id, type: "METRIC_REGISTRATION_FINISHED", actor, generation: claim.generation, payload: JSON.parse(JSON.stringify({ reason, summary })) } });
    if (blocked) {
      // 응답 불명의 guard는 유지한다. 다음 실행도 먼저 readback하며 새 POST를 하지 않는다.
      await db.agentLease.updateMany({ where: { id: claim.leaseId, generation: claim.generation }, data: { expiresAt: new Date(now.getTime() + 1800_000), heartbeatAt: now } });
      return;
    }
    await db.agentRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", outcome: JSON.parse(JSON.stringify({ reason, summary })), completedAt: now } });
    await db.automationOccurrence.update({ where: { id: run.occurrenceId }, data: { status: "COMPLETED", completedAt: now, result: JSON.parse(JSON.stringify({ reason, summary })) } });
    await db.agentLease.updateMany({ where: { runId: run.id, revokedAt: null }, data: { revokedAt: now, scopeKey: null } });
    await db.agentRepoGuard.updateMany({ where: { runId: run.id, activeScopeKey: scope }, data: { activeScopeKey: null, releasedAt: now } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
