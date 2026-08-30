import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  agentExecutionPolicy,
  agentRepositorySingletonScope,
  eligibleForAutopilot,
  MANAGED_WORKER_TEMPLATE_KEYS,
  parseManagedWorkerPolicy,
  SOURCE_REMEDIATION_TEMPLATE_KEY,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
  type AutomationPolicy,
  type SourceRemediationPolicy,
} from "@/lib/control-plane/automation-catalog";
import {
  issueEligibleForSourceRemediation,
  templateRepositoryAutomationEligible,
} from "@/lib/control-plane/source-remediation";
import {
  agentWorkerSessionStateError,
  trustedMutationDisposition,
} from "@/lib/control-plane/agent-mutation-service";
import { prisma } from "@/lib/prisma";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { canonicalJson, type JsonValue } from "@/lib/control-plane/json";
import {
  trustedMutationAdapterConfigured,
  workflowBundleCandidateExecutorConfigured,
} from "@/lib/control-plane/security";

class RepoScopeBusyError extends Error {}

const READ_ONLY_OUTCOME_CODES = new Set(["NO_CHANGES", "READBACK_CONFIRMED", "RESULT_UNKNOWN", "BLOCKED"]);

function resultCostMicros(result: Record<string, unknown>): bigint | null {
  const value = result.costMicros;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

export function agentResultPolicyError(input: {
  policy: AutomationPolicy;
  configuredModel: string | null;
  spentMicros: bigint | null;
  result: Record<string, unknown>;
}): string | null {
  const cost = resultCostMicros(input.result);
  if (cost === null) return "RESULT_COST_REQUIRED";
  if ((input.spentMicros ?? 0n) + cost > BigInt(input.policy.budgetCeilingMicros)) {
    return "BUDGET_CEILING_EXCEEDED";
  }
  if (
    input.policy.approvalPolicy === "READ_ONLY"
    && !READ_ONLY_OUTCOME_CODES.has(String(input.result.outcomeCode ?? ""))
  ) {
    return "APPROVAL_POLICY_VIOLATION";
  }
  if (input.configuredModel && input.result.model !== input.configuredModel) {
    return "MODEL_POLICY_VIOLATION";
  }
  return null;
}

function managedPolicy(definition: {
  template: string;
  agentKind: string | null;
  configuration: Prisma.JsonValue | null;
}): AutomationPolicy | null {
  return parseManagedWorkerPolicy(definition);
}

function internalLeaseNonceHash(): string {
  return crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
}

export function agentSettlementRequestHash(input: {
  outcome: "complete" | "fail" | "unknown";
  result: Record<string, unknown>;
  error?: string;
}): string {
  return crypto.createHash("sha256").update(canonicalJson({
    outcome: input.outcome,
    result: input.result,
    error: input.error ?? null,
  } as JsonValue)).digest("hex");
}

export function agentReadbackRequestHash(input: {
  resolution: "RESUME" | "COMPLETE" | "BLOCKED";
  result: Record<string, unknown>;
}): string {
  return crypto.createHash("sha256").update(canonicalJson({
    resolution: input.resolution,
    result: input.result,
  } as JsonValue)).digest("hex");
}

export { eligibleForAutopilot };

export async function releaseRepoGuard(
  tx: Prisma.TransactionClient,
  runId: string,
  now: Date,
): Promise<void> {
  await tx.agentRepoGuard.updateMany({
    where: { runId, activeScopeKey: { not: null } },
    data: { activeScopeKey: null, releasedAt: now },
  });
}

async function acquireRepoGuard(
  tx: Prisma.TransactionClient,
  run: { id: string; repoFullName: string },
  activeScopeKey: string | null,
  now: Date,
): Promise<boolean> {
  if (!activeScopeKey) return true;
  const existing = await tx.agentRepoGuard.findUnique({ where: { runId: run.id } });
  if (existing?.activeScopeKey === activeScopeKey) return true;
  try {
    if (existing) {
      const changed = await tx.agentRepoGuard.updateMany({
        where: { runId: run.id, activeScopeKey: null },
        data: { activeScopeKey, acquiredAt: now, releasedAt: null },
      });
      return changed.count === 1;
    }
    await tx.agentRepoGuard.create({
      data: { runId: run.id, repoFullName: run.repoFullName, activeScopeKey, acquiredAt: now },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
}

export async function firstSuccessfulClaim<T>(
  candidateIds: readonly string[],
  tryClaim: (candidateId: string) => Promise<T | null>,
): Promise<T | null> {
  for (const candidateId of candidateIds) {
    const claimed = await tryClaim(candidateId);
    if (claimed) return claimed;
  }
  return null;
}

export function validSettlementLease(input: {
  runStatus: string;
  currentGeneration: number;
  requestedGeneration: number;
  leaseActive: boolean;
}): boolean {
  return input.leaseActive
    && input.runStatus === "RUNNING"
    && input.currentGeneration === input.requestedGeneration;
}

export function settlementLeaseError(input: {
  runStatus: string;
  currentGeneration: number;
  requestedGeneration: number;
  sessionError: string | null;
}): string | null {
  if (
    input.sessionError === "SESSION_PRINCIPAL_MISMATCH"
    || input.sessionError === "SESSION_RUNTIME_BINDING_MISMATCH"
  ) return input.sessionError;
  if (
    input.runStatus !== "RUNNING"
    || input.currentGeneration !== input.requestedGeneration
  ) return "STALE_LEASE";
  return input.sessionError;
}

export function expiredLeaseDisposition(input: {
  mutationStarted: boolean;
  readbackRequested: boolean;
  attempts: number;
  maxAttempts: number;
}) {
  const readbackRequired = input.readbackRequested || input.mutationStarted;
  const terminal = !readbackRequired && input.attempts >= input.maxAttempts;
  return {
    readbackRequired,
    terminal,
    status: readbackRequired ? "FAILED" as const : terminal ? "DEAD_LETTER" as const : "PENDING" as const,
    eventType: readbackRequired ? "readback_required" : terminal ? "dead_letter" : "lease_expired",
  };
}

export async function requeueExpiredLeases(now: Date): Promise<void> {
  const expired = await prisma.agentLease.findMany({
    where: { revokedAt: null, expiresAt: { lte: now }, run: { status: "RUNNING" } },
    select: {
      id: true,
      runId: true,
      generation: true,
      run: {
        select: {
          attempts: true,
          maxAttempts: true,
          readbackRequestedAt: true,
          occurrenceId: true,
        },
      },
    },
    take: 100,
  });
  for (const lease of expired) {
    await prisma.$transaction(async (tx) => {
      const revoked = await tx.agentLease.updateMany({
        where: { id: lease.id, revokedAt: null, expiresAt: { lte: now } },
        data: { revokedAt: now, scopeKey: null },
      });
      if (revoked.count !== 1) return;
      await tx.agentWorkerSession.updateMany({
        where: { leaseId: lease.id, revokedAt: null },
        data: { revokedAt: now, expiresAt: now },
      });
      const mutationStarted = await tx.agentMutationExecution.findFirst({
        where: { runId: lease.runId, generation: lease.generation, status: { not: "NOT_APPLIED" } },
        select: { id: true },
      });
      const disposition = expiredLeaseDisposition({
        mutationStarted: mutationStarted !== null,
        readbackRequested: lease.run.readbackRequestedAt !== null,
        attempts: lease.run.attempts,
        maxAttempts: lease.run.maxAttempts,
      });
      const { readbackRequired, terminal } = disposition;
      const runChanged = await tx.agentRun.updateMany({
        where: { id: lease.runId, status: "RUNNING", leaseGeneration: lease.generation },
        data: {
          status: disposition.status,
          eligibleAt: now,
          readbackRequestedAt: readbackRequired ? (lease.run.readbackRequestedAt ?? now) : null,
          error: readbackRequired ? "LEASE_EXPIRED_READBACK_REQUIRED" : "LEASE_EXPIRED",
        },
      });
      if (runChanged.count !== 1) return;
      await tx.agentRunEvent.create({
        data: {
          runId: lease.runId,
          type: disposition.eventType,
          generation: lease.generation,
          actor: "system",
        },
      });
      if (!readbackRequired) {
        await releaseRepoGuard(tx, lease.runId, now);
      }
      await tx.automationOccurrence.update({
        where: { id: lease.run.occurrenceId },
        data: readbackRequired
          ? { status: "RUNNING", completedAt: null, result: { code: "LEASE_EXPIRED_READBACK_REQUIRED" } }
          : terminal
            ? { status: "DEAD_LETTER", completedAt: now, result: { code: "LEASE_EXPIRED" } }
            : { status: "PENDING", completedAt: null, result: { code: "LEASE_EXPIRED" } },
      });
    });
  }
}

export interface ClaimedAgentRun {
  sessionId: string;
  runId: string;
  repoFullName: string;
  issueNumber: number | null;
  template: string;
  agentKind: string;
  model: string | null;
  approvalPolicy: string;
  budgetCeilingMicros: number;
  spentMicros: number;
  remainingBudgetMicros: number;
  taskInput: Prisma.JsonValue | null;
  actionCapabilities: readonly string[];
  resumeMode: "START" | "READBACK_FIRST";
  generation: number;
  expiresAt: Date;
  duplicate: boolean;
}

async function replayClaim(input: {
  requestId: string;
  workerId: string;
  runtimeBindingDigest: string;
  agentKind: "CODEX" | "CLAUDE" | null;
  now: Date;
}): Promise<ClaimedAgentRun | null> {
  const event = await prisma.agentRunEvent.findUnique({
    where: { requestId: input.requestId },
    include: {
      run: {
        include: {
          leases: { include: { workerSession: true } },
          occurrence: { include: { definition: true } },
        },
      },
    },
  });
  if (!event) return null;
  if (event.type !== "claimed" || event.actor !== input.workerId || !event.generation) {
    throw new ControlPlaneError("idempotency key가 다른 agent 작업에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
  }
  if (event.run.occurrence.definition.agentKind !== input.agentKind) {
    throw new ControlPlaneError("claim agent 종류가 기존 요청과 다릅니다.", 409, "IDEMPOTENCY_CONFLICT");
  }
  const lease = event.run.leases.find((candidate) => candidate.generation === event.generation);
  const session = lease?.workerSession;
  if (!lease || !session || lease.revokedAt || session.revokedAt || lease.expiresAt <= input.now || session.expiresAt <= input.now) {
    throw new ControlPlaneError("claim 재생 시점에 lease가 만료되었습니다.", 409, "IDEMPOTENCY_REPLAY_EXPIRED");
  }
  const sessionError = agentWorkerSessionStateError({
    sessionId: session.id,
    sessionRunId: session.runId,
    sessionGeneration: session.generation,
    sessionPrincipalId: session.principalId,
    sessionRuntimeBindingDigest: session.runtimeBindingDigest,
    sessionRepoId: session.repoId,
    sessionRepoFullName: session.repoFullName,
    sessionIssueNumber: session.issueNumber,
    sessionSourceSha: session.sourceSha,
    sessionExpiresAt: session.expiresAt,
    sessionRevokedAt: session.revokedAt,
    requestedPrincipalId: input.workerId,
    requestedRuntimeBindingDigest: input.runtimeBindingDigest,
    leaseRunId: lease.runId,
    leaseGeneration: lease.generation,
    leaseWorkerId: lease.workerId,
    leaseExpiresAt: lease.expiresAt,
    leaseRevokedAt: lease.revokedAt,
    runStatus: event.run.status,
    runGeneration: event.run.leaseGeneration,
    runRepoFullName: event.run.repoFullName,
    runIssueNumber: event.run.issueNumber,
    now: input.now,
  });
  if (sessionError) throw new ControlPlaneError("claim session binding이 유효하지 않습니다.", 409, sessionError);
  const policy = managedPolicy(event.run.occurrence.definition);
  if (!policy) {
    throw new ControlPlaneError("legacy routine claim은 재생할 수 없습니다.", 409, "DEFINITION_CONTRACT_UNMANAGED");
  }
  const spentMicros = Number(event.run.spentMicros ?? 0n);
  const resumeMode = event.run.readbackRequestedAt ? "READBACK_FIRST" as const : "START" as const;
  const executionPolicy = agentExecutionPolicy(policy, resumeMode);
  return {
    sessionId: session.id,
    runId: event.run.id,
    repoFullName: event.run.repoFullName,
    issueNumber: event.run.issueNumber,
    template: event.run.occurrence.definition.template,
    agentKind: event.run.occurrence.definition.agentKind ?? "UNKNOWN",
    model: event.run.occurrence.definition.model,
    approvalPolicy: policy.approvalPolicy,
    budgetCeilingMicros: policy.budgetCeilingMicros,
    spentMicros,
    remainingBudgetMicros: Math.max(0, policy.budgetCeilingMicros - spentMicros),
    taskInput: event.run.taskInput,
    actionCapabilities: executionPolicy.capabilities,
    resumeMode,
    generation: event.generation,
    expiresAt: lease.expiresAt,
    duplicate: true,
  };
}

async function tryClaimRun(input: {
  runId: string;
  workerId: string;
  runtimeBindingDigest: string;
  leaseSeconds: number;
  now: Date;
  idempotencyKey: string;
  trustedMutationRuntimeAvailable?: boolean;
  retryAttempt?: number;
}): Promise<ClaimedAgentRun | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      const run = await tx.agentRun.findUnique({
        where: { id: input.runId },
        include: { occurrence: { include: { definition: true } } },
      });
      if (!run || run.eligibleAt > input.now) {
        return null;
      }
      const readbackClaim = run.status === "FAILED" && run.readbackRequestedAt !== null;
      if (!readbackClaim && run.status !== "PENDING") return null;
      const policy = managedPolicy(run.occurrence.definition);
      if (!policy || (!readbackClaim && (!run.occurrence.definition.enabled || run.occurrence.definition.cancelledAt))) return null;
      const resumeMode = readbackClaim ? "READBACK_FIRST" as const : "START" as const;
      const executionPolicy = agentExecutionPolicy(policy, resumeMode);
      if (
        executionPolicy.repositorySingleton
        && !(input.trustedMutationRuntimeAvailable ?? trustedMutationAdapterConfigured())
      ) return null;
      const registration = await tx.repositoryRegistration.findUnique({
        where: { repoFullName: run.repoFullName },
        select: {
          repoId: true,
          repoFullName: true,
          defaultBranch: true,
          archived: true,
          status: true,
          managementKind: true,
          classification: true,
          lastDefaultPushSha: true,
          lastReconciledSha: true,
          reconcileGeneration: true,
          lastDiscoveryReason: true,
        },
      });
      const priorSession = readbackClaim
        ? await tx.agentWorkerSession.findFirst({
          where: { runId: run.id, generation: { lte: run.leaseGeneration } },
          orderBy: { generation: "desc" },
        })
        : null;
      // source-remediation은 일반 MANAGED guard를 우회하는 유일한 template이다. registration이
      // MANAGED가 아니어도, 정의 생성 시 잠근 generation/source SHA/reason이 지금도 정확히 같을
      // 때만 통과한다 — 다른 모든 template은 기존 repositoryAutomationEligible 그대로다.
      // 같은 판정을 수동 retry(retryAgentRun)와 공유해 두 경로가 어긋나지 않게 한다.
      const isSourceRemediation = run.occurrence.definition.template === SOURCE_REMEDIATION_TEMPLATE_KEY;
      if (!readbackClaim && !templateRepositoryAutomationEligible({
        template: run.occurrence.definition.template,
        configuration: run.occurrence.definition.configuration,
        registration,
      })) return null;
      if (!readbackClaim && isSourceRemediation) {
        const remediationApp = run.appId
          ? await tx.app.findUnique({ where: { id: run.appId }, select: { status: true } })
          : null;
        if (!remediationApp || remediationApp.status !== "ACTIVE") return null;
      }
      if (readbackClaim && !priorSession) return null;
      const repoId = priorSession?.repoId ?? registration?.repoId;
      const sourceSha = priorSession?.sourceSha ?? registration?.lastDefaultPushSha;
      if (!repoId || !sourceSha) return null;
      const spentMicros = Number(run.spentMicros ?? 0n);
      if (!readbackClaim && spentMicros >= policy.budgetCeilingMicros) {
        const exhausted = await tx.agentRun.updateMany({
          where: {
            id: run.id,
            status: run.status,
            leaseGeneration: run.leaseGeneration,
          },
          data: { status: "DEAD_LETTER", completedAt: input.now, error: "BUDGET_CEILING_EXHAUSTED" },
        });
        if (exhausted.count === 1) {
          if (!readbackClaim) await releaseRepoGuard(tx, run.id, input.now);
          await tx.automationOccurrence.update({
            where: { id: run.occurrenceId },
            data: { status: "DEAD_LETTER", completedAt: input.now, result: { code: "BUDGET_CEILING_EXHAUSTED" } },
          });
          await tx.agentRunEvent.create({
            data: { runId: run.id, type: "budget_exhausted", actor: "system:claim" },
          });
        }
        return null;
      }
      if (!readbackClaim && !eligibleForAutopilot(run)) return null;
      if (!readbackClaim && run.issueNumber) {
        const issue = await tx.issueMirror.findUnique({
          where: { repoFullName_number: { repoFullName: run.repoFullName, number: run.issueNumber } },
          select: {
            number: true,
            state: true,
            labels: true,
            title: true,
            priority: true,
            isAutopilot: true,
            isBlocked: true,
          },
        });
        if (!issue || !eligibleForAutopilot({
          issueNumber: issue.number,
          issueState: issue.state,
          labels: issue.labels,
        })) return null;
        // 임의 사용자 편집으로 issue 제목/라벨 scope가 정의 생성 시점과 달라졌으면
        // GitHub readback 재검증에서 fail-closed한다.
        if (isSourceRemediation && !issueEligibleForSourceRemediation(issue, policy as SourceRemediationPolicy)) {
          return null;
        }
      }
      if (!readbackClaim && executionPolicy.repositorySingleton) {
        const openAutopilotPr = await tx.pullRequestMirror.findFirst({
          where: { repoFullName: run.repoFullName, state: "OPEN", isAutopilotPr: true },
          select: { id: true },
        });
        // 재claim run은 기존 PR이 자신이 남긴 결과일 수 있으므로 readback부터 수행한다.
        // 최초 claim만 기존 자율 PR이 있으면 fail-closed한다.
        if (openAutopilotPr && run.leaseGeneration === 0) return null;
      }
      const generation = run.leaseGeneration + 1;
      const changed = await tx.agentRun.updateMany({
        where: {
          id: run.id,
          status: run.status,
          leaseGeneration: run.leaseGeneration,
          ...(readbackClaim ? { readbackRequestedAt: { not: null } } : {}),
        },
        data: {
          status: "RUNNING",
          leaseGeneration: generation,
          ...(!readbackClaim ? { attempts: { increment: 1 } } : {}),
          startedAt: input.now,
          error: null,
        },
      });
      if (changed.count !== 1) return null;
      const activeScopeKey = agentRepositorySingletonScope(run.repoFullName, executionPolicy);
      if (!(await acquireRepoGuard(tx, run, activeScopeKey, input.now))) throw new RepoScopeBusyError();
      const expiresAt = new Date(input.now.getTime() + input.leaseSeconds * 1000);
      const lease = await tx.agentLease.create({
        data: {
          runId: run.id,
          generation,
          tokenHash: internalLeaseNonceHash(),
          workerId: input.workerId,
          scopeKey: activeScopeKey,
          heartbeatAt: input.now,
          expiresAt,
        },
      });
      const session = await tx.agentWorkerSession.create({
        data: {
          id: `agent-session:${crypto.randomUUID()}`,
          leaseId: lease.id,
          runId: run.id,
          generation,
          principalId: input.workerId,
          runtimeBindingDigest: input.runtimeBindingDigest,
          repoId,
          repoFullName: run.repoFullName,
          issueNumber: run.issueNumber,
          sourceSha: sourceSha.toLowerCase(),
          heartbeatAt: input.now,
          expiresAt,
        },
      });
      await tx.automationOccurrence.update({
        where: { id: run.occurrenceId },
        data: { status: "RUNNING" },
      });
      await tx.agentRunEvent.create({
        data: {
          requestId: input.idempotencyKey,
          runId: run.id,
          type: "claimed",
          generation,
          actor: input.workerId,
          payload: {
            sessionId: session.id,
            expiresAt: expiresAt.toISOString(),
            resumeMode,
            repoId: repoId.toString(),
            sourceSha: sourceSha.toLowerCase(),
            runtimeBindingDigest: input.runtimeBindingDigest,
            actionCapabilities: executionPolicy.capabilities,
          },
        },
      });
      return {
        sessionId: session.id,
        runId: run.id,
        repoFullName: run.repoFullName,
        issueNumber: run.issueNumber,
        template: run.occurrence.definition.template,
        agentKind: run.occurrence.definition.agentKind ?? "UNKNOWN",
        model: run.occurrence.definition.model,
        approvalPolicy: policy.approvalPolicy,
        budgetCeilingMicros: policy.budgetCeilingMicros,
        spentMicros,
        remainingBudgetMicros: policy.budgetCeilingMicros - spentMicros,
        taskInput: run.taskInput,
        actionCapabilities: executionPolicy.capabilities,
        resumeMode,
        generation,
        expiresAt,
        duplicate: false,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof RepoScopeBusyError) return null;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && error.code === "P2034"
      && (input.retryAttempt ?? 0) < 2
    ) return tryClaimRun({ ...input, retryAttempt: (input.retryAttempt ?? 0) + 1 });
    throw error;
  }
}

export async function claimAgentRun(input: {
  workerId: string;
  runtimeBindingDigest: string;
  agentKind: "CODEX" | "CLAUDE";
  leaseSeconds: number;
  idempotencyKey: string;
  now?: Date;
}): Promise<ClaimedAgentRun | null> {
  const now = input.now ?? new Date();
  const replay = await replayClaim({ ...input, requestId: input.idempotencyKey, now });
  if (replay) return replay;
  await requeueExpiredLeases(now);
  const candidates = await prisma.agentRun.findMany({
    where: {
      OR: [
        { status: "PENDING" },
        { status: "FAILED", readbackRequestedAt: { not: null } },
      ],
      eligibleAt: { lte: now },
      occurrence: {
        definition: {
          template: { in: [...MANAGED_WORKER_TEMPLATE_KEYS] },
          agentKind: input.agentKind,
          configuration: { not: Prisma.DbNull },
        },
      },
    },
    select: { id: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: 50,
  });
  const claimed = await firstSuccessfulClaim(
    candidates.map(({ id }) => id),
    (runId) => tryClaimRun({ ...input, runId, now }),
  );
  return claimed ?? replayClaim({ ...input, requestId: input.idempotencyKey, now });
}

/**
 * 고정 candidate executor만 agentKind=null 전용 definition을 claim한다. 일반
 * Codex/Claude worker query에는 이 queue가 섞이지 않는다.
 */
export async function claimWorkflowBundleCandidateRun(input: {
  workerId: typeof WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL;
  runtimeBindingDigest: string;
  leaseSeconds: number;
  idempotencyKey: string;
  runId?: string;
  now?: Date;
}): Promise<ClaimedAgentRun | null> {
  if (!workflowBundleCandidateExecutorConfigured()) return null;
  const now = input.now ?? new Date();
  const replay = await replayClaim({ ...input, agentKind: null, requestId: input.idempotencyKey, now });
  if (replay) return replay;
  await requeueExpiredLeases(now);
  const candidates = await prisma.agentRun.findMany({
    where: {
      ...(input.runId ? { id: input.runId } : {}),
      OR: [
        { status: "PENDING" },
        { status: "FAILED", readbackRequestedAt: { not: null } },
      ],
      eligibleAt: { lte: now },
      occurrence: {
        definition: {
          template: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
          agentKind: null,
          configuration: { not: Prisma.DbNull },
        },
      },
    },
    select: { id: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: 10,
  });
  const claimed = await firstSuccessfulClaim(
    candidates.map(({ id }) => id),
    (runId) => tryClaimRun({
      ...input,
      runId,
      now,
      trustedMutationRuntimeAvailable: true,
    }),
  );
  return claimed ?? replayClaim({ ...input, agentKind: null, requestId: input.idempotencyKey, now });
}

export async function heartbeatAgentRun(input: {
  sessionId: string;
  workerId: string;
  runtimeBindingDigest: string;
  leaseSeconds: number;
  idempotencyKey: string;
  now?: Date;
  retryAttempt?: number;
}) {
  const now = input.now ?? new Date();
  const replay = await prisma.agentRunEvent.findUnique({ where: { requestId: input.idempotencyKey } });
  if (replay) {
    const payload = replay.payload as { sessionId?: string; expiresAt?: string; runtimeBindingDigest?: string } | null;
    if (
      payload?.sessionId !== input.sessionId
      || payload.runtimeBindingDigest !== input.runtimeBindingDigest
      || replay.actor !== input.workerId
      || replay.type !== "heartbeat"
    ) {
      throw new ControlPlaneError("idempotency key가 다른 heartbeat에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    const session = await prisma.agentWorkerSession.findUnique({
      where: { id: input.sessionId },
      include: { lease: { include: { run: true } } },
    });
    if (!session || replay.runId !== session.runId || replay.generation !== session.generation) {
      throw new ControlPlaneError("heartbeat replay session binding이 다릅니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    const sessionError = agentWorkerSessionStateError({
      sessionId: session.id,
      sessionRunId: session.runId,
      sessionGeneration: session.generation,
    sessionPrincipalId: session.principalId,
    sessionRuntimeBindingDigest: session.runtimeBindingDigest,
      sessionRepoId: session.repoId,
      sessionRepoFullName: session.repoFullName,
      sessionIssueNumber: session.issueNumber,
      sessionSourceSha: session.sourceSha,
      sessionExpiresAt: session.expiresAt,
      sessionRevokedAt: session.revokedAt,
    requestedPrincipalId: input.workerId,
    requestedRuntimeBindingDigest: input.runtimeBindingDigest,
      leaseRunId: session.lease.runId,
      leaseGeneration: session.lease.generation,
      leaseWorkerId: session.lease.workerId,
      leaseExpiresAt: session.lease.expiresAt,
      leaseRevokedAt: session.lease.revokedAt,
      runStatus: session.lease.run.status,
      runGeneration: session.lease.run.leaseGeneration,
      runRepoFullName: session.lease.run.repoFullName,
      runIssueNumber: session.lease.run.issueNumber,
      now,
    });
    if (sessionError) {
      throw new ControlPlaneError("heartbeat replay session이 더 이상 유효하지 않습니다.", 409, sessionError);
    }
    const replayExpiresAt = new Date(payload.expiresAt ?? 0);
    if (!Number.isFinite(replayExpiresAt.getTime())) {
      throw new ControlPlaneError("heartbeat replay payload가 유효하지 않습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { sessionId: input.sessionId, expiresAt: replayExpiresAt, duplicate: true };
  }
  const expiresAt = new Date(now.getTime() + input.leaseSeconds * 1000);
  try {
    await prisma.$transaction(async (tx) => {
      const session = await tx.agentWorkerSession.findUnique({
        where: { id: input.sessionId },
        include: { lease: { include: { run: true } } },
      });
      if (!session) throw new ControlPlaneError("agent worker session을 찾을 수 없습니다.", 404, "SESSION_NOT_FOUND");
      const sessionError = agentWorkerSessionStateError({
        sessionId: session.id,
        sessionRunId: session.runId,
        sessionGeneration: session.generation,
        sessionPrincipalId: session.principalId,
        sessionRuntimeBindingDigest: session.runtimeBindingDigest,
        sessionRepoId: session.repoId,
        sessionRepoFullName: session.repoFullName,
        sessionIssueNumber: session.issueNumber,
        sessionSourceSha: session.sourceSha,
        sessionExpiresAt: session.expiresAt,
        sessionRevokedAt: session.revokedAt,
        requestedPrincipalId: input.workerId,
        requestedRuntimeBindingDigest: input.runtimeBindingDigest,
        leaseRunId: session.lease.runId,
        leaseGeneration: session.lease.generation,
        leaseWorkerId: session.lease.workerId,
        leaseExpiresAt: session.lease.expiresAt,
        leaseRevokedAt: session.lease.revokedAt,
        runStatus: session.lease.run.status,
        runGeneration: session.lease.run.leaseGeneration,
        runRepoFullName: session.lease.run.repoFullName,
        runIssueNumber: session.lease.run.issueNumber,
        now,
      });
      if (sessionError) throw new ControlPlaneError("유효한 agent session이 아닙니다.", 409, sessionError);
      const updatedLease = await tx.agentLease.updateMany({
        where: { id: session.leaseId, revokedAt: null, expiresAt: { gt: now } },
        data: { heartbeatAt: now, expiresAt },
      });
      const updatedSession = await tx.agentWorkerSession.updateMany({
        where: { id: session.id, revokedAt: null, expiresAt: { gt: now } },
        data: { heartbeatAt: now, expiresAt },
      });
      if (updatedLease.count !== 1 || updatedSession.count !== 1) {
        throw new ControlPlaneError("agent session heartbeat CAS에 실패했습니다.", 409, "STALE_SESSION");
      }
      await tx.agentRunEvent.create({
        data: {
          requestId: input.idempotencyKey,
          runId: session.runId,
          type: "heartbeat",
          generation: session.generation,
          actor: input.workerId,
          payload: {
            sessionId: session.id,
            expiresAt: expiresAt.toISOString(),
            runtimeBindingDigest: input.runtimeBindingDigest,
          },
        },
      });
    });
    return { sessionId: input.sessionId, expiresAt, duplicate: false };
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError)
      || !["P2002", "P2034"].includes(error.code)
      || (input.retryAttempt ?? 0) >= 2
    ) throw error;
    return heartbeatAgentRun({ ...input, now, retryAttempt: (input.retryAttempt ?? 0) + 1 });
  }
}

export async function settleAgentRun(input: {
  sessionId: string;
  workerId: string;
  runtimeBindingDigest: string;
  outcome: "complete" | "fail" | "unknown";
  result: Record<string, unknown>;
  error?: string;
  idempotencyKey: string;
  now?: Date;
  retryAttempt?: number;
}) {
  const now = input.now ?? new Date();
  const requestHash = agentSettlementRequestHash(input);
  const replay = await prisma.agentRunEvent.findUnique({ where: { requestId: input.idempotencyKey } });
  if (replay) {
    const policyEvents = [
      "budget_exceeded",
      "approval_policy_violation",
      "model_policy_violation",
      "result_contract_violation",
    ];
    const expectedTypes = input.outcome === "complete"
      ? ["completed", "readback_required", ...policyEvents]
      : input.outcome === "unknown"
        ? ["readback_required"]
        : ["retry_scheduled", "dead_letter", "readback_required", "human_reauth_required", ...policyEvents];
    if (replay.actor !== input.workerId || !expectedTypes.includes(replay.type)) {
      throw new ControlPlaneError("idempotency key가 다른 completion에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    const payload = replay.payload as {
      sessionId?: string;
      status?: string;
      retry?: boolean;
      requestHash?: string;
      runtimeBindingDigest?: string;
    } | null;
    if (
      payload?.sessionId !== input.sessionId
      || payload.requestHash !== requestHash
      || payload.runtimeBindingDigest !== input.runtimeBindingDigest
    ) {
      throw new ControlPlaneError("idempotency key가 다른 completion payload에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { runId: replay.runId, status: payload.status ?? "UNKNOWN", retry: payload.retry ?? false, duplicate: true };
  }
  try {
    const settled = await prisma.$transaction(async (tx) => {
      const session = await tx.agentWorkerSession.findUnique({
        where: { id: input.sessionId },
        include: { lease: { include: { run: { include: { occurrence: { include: { definition: true } } } } } } },
      });
      if (!session) throw new ControlPlaneError("agent worker session을 찾을 수 없습니다.", 404, "SESSION_NOT_FOUND");
      const sessionError = agentWorkerSessionStateError({
        sessionId: session.id,
        sessionRunId: session.runId,
        sessionGeneration: session.generation,
        sessionPrincipalId: session.principalId,
        sessionRuntimeBindingDigest: session.runtimeBindingDigest,
        sessionRepoId: session.repoId,
        sessionRepoFullName: session.repoFullName,
        sessionIssueNumber: session.issueNumber,
        sessionSourceSha: session.sourceSha,
        sessionExpiresAt: session.expiresAt,
        sessionRevokedAt: session.revokedAt,
        requestedPrincipalId: input.workerId,
        requestedRuntimeBindingDigest: input.runtimeBindingDigest,
        leaseRunId: session.lease.runId,
        leaseGeneration: session.lease.generation,
        leaseWorkerId: session.lease.workerId,
        leaseExpiresAt: session.lease.expiresAt,
        leaseRevokedAt: session.lease.revokedAt,
        runStatus: session.lease.run.status,
        runGeneration: session.lease.run.leaseGeneration,
        runRepoFullName: session.lease.run.repoFullName,
        runIssueNumber: session.lease.run.issueNumber,
        now,
      });
      const lease = session.lease;
      const leaseError = settlementLeaseError({
        runStatus: lease.run.status,
        currentGeneration: lease.run.leaseGeneration,
        requestedGeneration: session.generation,
        sessionError,
      });
      if (leaseError || !validSettlementLease({
        runStatus: lease.run.status,
        currentGeneration: lease.run.leaseGeneration,
        requestedGeneration: session.generation,
        leaseActive: !sessionError,
      })) {
        throw new ControlPlaneError("stale completion은 반영할 수 없습니다.", 409, leaseError ?? "STALE_SESSION");
      }
      const policy = managedPolicy(lease.run.occurrence.definition);
      if (!policy) {
        throw new ControlPlaneError("legacy routine 결과는 반영할 수 없습니다.", 409, "DEFINITION_CONTRACT_UNMANAGED");
      }
      const costMicros = resultCostMicros(input.result);
      const nextSpentMicros = (lease.run.spentMicros ?? 0n) + (costMicros ?? 0n);
      const resultPolicyError = agentResultPolicyError({
        policy,
        configuredModel: lease.run.occurrence.definition.model,
        spentMicros: lease.run.spentMicros,
        result: input.result,
      });
      const mutation = await trustedMutationDisposition(tx, {
        runId: lease.run.id,
        sessionId: session.id,
        currentGeneration: session.generation,
        readbackResolution: false,
        result: input.result,
      });
      const reauthRequestId = typeof input.result.reauthRequestId === "string"
        ? input.result.reauthRequestId
        : null;
      let reauthBindingError: string | null = null;
      if (input.error === "HUMAN_REAUTH_REQUIRED" || reauthRequestId) {
        const reauth = reauthRequestId
          ? await tx.reauthRequest.findUnique({
            where: { id: reauthRequestId },
            select: { appId: true, runId: true, status: true },
          })
          : null;
        if (
          !reauth
          || reauth.appId !== lease.run.appId
          || reauth.runId !== lease.run.id
          || !["HUMAN_REAUTH_REQUIRED", "TRUSTED_LOCAL_PENDING"].includes(reauth.status)
        ) reauthBindingError = "REAUTH_REQUEST_BINDING_MISMATCH";
      }
      const readbackRequired = input.outcome === "unknown"
        || (mutation.mutationStarted && (input.outcome === "fail" || mutation.error !== null));
      const policyError = resultPolicyError ?? reauthBindingError ?? (!readbackRequired ? mutation.error : null);
      const succeeded = input.outcome === "complete" && !policyError && !readbackRequired;
      const humanReauthRequired = input.outcome === "fail"
        && input.error === "HUMAN_REAUTH_REQUIRED"
        && input.result.outcomeCode === "BLOCKED"
        && reauthRequestId !== null
        && reauthBindingError === null;
      const retry = input.outcome === "fail"
        && !policyError
        && !readbackRequired
        && !mutation.mutationStarted
        && !humanReauthRequired
        && lease.run.attempts < lease.run.maxAttempts;
      const runStatus = succeeded
        ? "SUCCEEDED"
        : readbackRequired
          ? "FAILED"
          : retry
            ? "PENDING"
            : "DEAD_LETTER";
      const changed = await tx.agentRun.updateMany({
        where: { id: lease.run.id, status: "RUNNING", leaseGeneration: session.generation },
        data: {
          status: runStatus,
          completedAt: succeeded || (!retry && !readbackRequired) ? now : null,
          eligibleAt: retry ? now : lease.run.eligibleAt,
          spentMicros: nextSpentMicros,
          outcome: input.result as Prisma.InputJsonValue,
          error: succeeded
            ? null
            : (policyError ?? mutation.error ?? input.error ?? (readbackRequired ? "MUTATION_READBACK_REQUIRED" : "WORKER_FAILED")),
          readbackRequestedAt: readbackRequired ? now : null,
        },
      });
      if (changed.count !== 1) {
        throw new ControlPlaneError("stale completion은 반영할 수 없습니다.", 409, "STALE_LEASE");
      }
      await tx.agentLease.update({
        where: { id: lease.id },
        data: { revokedAt: now, scopeKey: null },
      });
      await tx.agentWorkerSession.update({
        where: { id: session.id },
        data: { revokedAt: now, settledAt: now, expiresAt: now },
      });
      if (!mutation.mutationStarted) await releaseRepoGuard(tx, lease.run.id, now);
      await tx.automationOccurrence.update({
        where: { id: lease.run.occurrenceId },
        data: {
          status: succeeded
            ? "COMPLETED"
            : readbackRequired
              ? "RUNNING"
              : retry
                ? "PENDING"
                : "DEAD_LETTER",
          completedAt: succeeded || (!retry && !readbackRequired) ? now : null,
        },
      });
      await tx.agentRunEvent.create({
        data: {
          requestId: input.idempotencyKey,
          runId: lease.run.id,
          type: readbackRequired
            ? "readback_required"
            : humanReauthRequired
              ? "human_reauth_required"
            : policyError === "BUDGET_CEILING_EXCEEDED"
              ? "budget_exceeded"
              : policyError === "RESULT_COST_REQUIRED"
                ? "result_contract_violation"
                : policyError === "REAUTH_REQUEST_BINDING_MISMATCH"
                  ? "result_contract_violation"
                : policyError === "APPROVAL_POLICY_VIOLATION"
                  ? "approval_policy_violation"
                  : policyError === "MODEL_POLICY_VIOLATION"
                    ? "model_policy_violation"
                    : succeeded
                      ? "completed"
                      : retry
                        ? "retry_scheduled"
                        : "dead_letter",
          generation: session.generation,
          actor: input.workerId,
          payload: {
            sessionId: session.id,
            status: runStatus,
            retry,
            budgetCeilingMicros: policy.budgetCeilingMicros,
            spentMicros: Number(nextSpentMicros),
            approvalPolicy: policy.approvalPolicy,
            result: input.result,
            mutationStarted: mutation.mutationStarted,
            ...(mutation.error ? { mutationError: mutation.error } : {}),
            ...(policyError ? { policyError } : {}),
            requestHash,
            runtimeBindingDigest: input.runtimeBindingDigest,
          } as Prisma.InputJsonValue,
        },
      });
      return { runId: lease.run.id, status: runStatus, retry, duplicate: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return settled;
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError)
      || !["P2002", "P2034"].includes(error.code)
      || (input.retryAttempt ?? 0) >= 2
    ) throw error;
    return settleAgentRun({ ...input, now, retryAttempt: (input.retryAttempt ?? 0) + 1 });
  }
}

export async function resolveAgentRunReadback(input: {
  sessionId: string;
  workerId: string;
  runtimeBindingDigest: string;
  resolution: "RESUME" | "COMPLETE" | "BLOCKED";
  result: Record<string, unknown>;
  idempotencyKey: string;
  now?: Date;
  retryAttempt?: number;
}) {
  const now = input.now ?? new Date();
  const requestHash = agentReadbackRequestHash(input);
  const replay = await prisma.agentRunEvent.findUnique({ where: { requestId: input.idempotencyKey } });
  if (replay) {
    const payload = replay.payload as {
      sessionId?: string;
      status?: string;
      requestedResolution?: string;
      requestHash?: string;
      runtimeBindingDigest?: string;
    } | null;
    if (
      replay.actor !== input.workerId
      || !["readback_resumed", "readback_completed", "readback_blocked", "readback_policy_blocked"].includes(replay.type)
      || payload?.sessionId !== input.sessionId
      || payload?.requestedResolution !== input.resolution
      || payload?.requestHash !== requestHash
      || payload?.runtimeBindingDigest !== input.runtimeBindingDigest
    ) {
      throw new ControlPlaneError("idempotency key가 다른 readback에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { runId: replay.runId, status: payload?.status ?? "UNKNOWN", duplicate: true };
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const session = await tx.agentWorkerSession.findUnique({
        where: { id: input.sessionId },
        include: { lease: { include: { run: { include: { occurrence: { include: { definition: true } } } } } } },
      });
      if (!session) throw new ControlPlaneError("agent worker session을 찾을 수 없습니다.", 404, "SESSION_NOT_FOUND");
      const run = session.lease.run;
      const sourceLease = session.lease;
      const sessionError = agentWorkerSessionStateError({
        sessionId: session.id,
        sessionRunId: session.runId,
        sessionGeneration: session.generation,
        sessionPrincipalId: session.principalId,
        sessionRuntimeBindingDigest: session.runtimeBindingDigest,
        sessionRepoId: session.repoId,
        sessionRepoFullName: session.repoFullName,
        sessionIssueNumber: session.issueNumber,
        sessionSourceSha: session.sourceSha,
        sessionExpiresAt: session.expiresAt,
        sessionRevokedAt: session.revokedAt,
        requestedPrincipalId: input.workerId,
        requestedRuntimeBindingDigest: input.runtimeBindingDigest,
        leaseRunId: sourceLease.runId,
        leaseGeneration: sourceLease.generation,
        leaseWorkerId: sourceLease.workerId,
        leaseExpiresAt: sourceLease.expiresAt,
        leaseRevokedAt: sourceLease.revokedAt,
        runStatus: run.status,
        runGeneration: run.leaseGeneration,
        runRepoFullName: run.repoFullName,
        runIssueNumber: run.issueNumber,
        now,
      });
      if (
        sessionError
        || run.status !== "RUNNING"
        || !run.readbackRequestedAt
        || run.leaseGeneration !== session.generation
      ) {
        throw new ControlPlaneError("readback 대기 중인 동일 generation run이 아닙니다.", 409, "READBACK_STATE_CONFLICT");
      }
      const policy = managedPolicy(run.occurrence.definition);
      if (!policy) {
        throw new ControlPlaneError("legacy routine readback은 반영할 수 없습니다.", 409, "DEFINITION_CONTRACT_UNMANAGED");
      }
      const costMicros = resultCostMicros(input.result);
      const nextSpentMicros = (run.spentMicros ?? 0n) + (costMicros ?? 0n);
      let policyError = agentResultPolicyError({
        policy,
        configuredModel: run.occurrence.definition.model,
        spentMicros: run.spentMicros,
        result: input.result,
      });
      const mutation = await trustedMutationDisposition(tx, {
        runId: run.id,
        sessionId: session.id,
        currentGeneration: session.generation,
        readbackResolution: true,
        readbackResolutionAction: input.resolution,
        result: input.result,
      });
      if (!policyError && mutation.error) policyError = mutation.error;
      if (!policyError && input.resolution === "RESUME" && run.attempts >= run.maxAttempts) {
        policyError = "MAX_ATTEMPTS_EXHAUSTED";
      }
      const effectiveResolution = policyError ? "BLOCKED" : input.resolution;
      const status = effectiveResolution === "RESUME"
        ? "PENDING"
        : effectiveResolution === "COMPLETE"
          ? "SUCCEEDED"
          : "DEAD_LETTER";
      const changed = await tx.agentRun.updateMany({
        where: {
          id: run.id,
          status: "RUNNING",
          leaseGeneration: session.generation,
          readbackRequestedAt: { not: null },
        },
        data: {
          status,
          spentMicros: nextSpentMicros,
          eligibleAt: effectiveResolution === "RESUME" ? now : run.eligibleAt,
          completedAt: effectiveResolution === "RESUME" ? null : now,
          readbackRequestedAt: null,
          error: policyError ?? (effectiveResolution === "BLOCKED" ? "READBACK_BLOCKED" : null),
          outcome: input.result as Prisma.InputJsonValue,
        },
      });
      if (changed.count !== 1) {
        throw new ControlPlaneError("readback 상태 CAS에 실패했습니다.", 409, "READBACK_STATE_CONFLICT");
      }
      await tx.agentLease.update({
        where: { id: sourceLease.id },
        data: { revokedAt: now, scopeKey: null },
      });
      await tx.agentWorkerSession.update({
        where: { id: session.id },
        data: { revokedAt: now, settledAt: now, expiresAt: now },
      });
      const retainsPrGuard = mutation.mutationStarted;
      if (!retainsPrGuard) await releaseRepoGuard(tx, run.id, now);
      let workKeyReleased = false;
      if (effectiveResolution === "COMPLETE" && run.issueNumber) {
        const issue = await tx.issueMirror.findUnique({
          where: {
            repoFullName_number: {
              repoFullName: run.repoFullName,
              number: run.issueNumber,
            },
          },
          select: { number: true, state: true, labels: true },
        });
        if (!issue || !eligibleForAutopilot({
          issueNumber: issue.number,
          issueState: issue.state,
          labels: issue.labels,
        })) {
          const released = await tx.agentRun.updateMany({
            where: { id: run.id, workKey: { not: null } },
            data: { workKey: null },
          });
          workKeyReleased = released.count === 1;
        }
      }
      await tx.automationOccurrence.update({
        where: { id: run.occurrenceId },
        data: {
          status: effectiveResolution === "RESUME"
            ? "PENDING"
            : effectiveResolution === "COMPLETE"
              ? "COMPLETED"
              : "DEAD_LETTER",
          completedAt: effectiveResolution === "RESUME" ? null : now,
        },
      });
      await tx.agentRunEvent.create({
        data: {
          requestId: input.idempotencyKey,
          runId: run.id,
          type: policyError
            ? "readback_policy_blocked"
            : effectiveResolution === "RESUME"
            ? "readback_resumed"
            : effectiveResolution === "COMPLETE"
              ? "readback_completed"
              : "readback_blocked",
          generation: session.generation,
          actor: input.workerId,
          payload: {
            sessionId: session.id,
            status,
            requestedResolution: input.resolution,
            result: input.result,
            spentMicros: Number(nextSpentMicros),
            workKeyReleased,
            mutationStarted: mutation.mutationStarted,
            ...(mutation.error ? { mutationError: mutation.error } : {}),
            ...(policyError ? { policyError } : {}),
            requestHash,
            runtimeBindingDigest: input.runtimeBindingDigest,
          } as Prisma.InputJsonValue,
        },
      });
      return { runId: run.id, status, duplicate: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError)
      || !["P2002", "P2034"].includes(error.code)
      || (input.retryAttempt ?? 0) >= 2
    ) throw error;
    return resolveAgentRunReadback({ ...input, now, retryAttempt: (input.retryAttempt ?? 0) + 1 });
  }
}

function resultPullRequestNumber(value: Prisma.JsonValue | null): number | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  return candidate.outcomeCode === "PR_READY"
    && Number.isInteger(candidate.pullRequestNumber)
    && Number(candidate.pullRequestNumber) > 0
    ? Number(candidate.pullRequestNumber)
    : null;
}

/**
 * PR_READY run의 guard는 PR mirror가 CLOSED/MERGED를 관측할 때만 해제한다.
 * PR webhook보다 completion이 먼저 도착하는 공백에서는 mirror 부재를 해제 근거로 쓰지 않는다.
 */
export async function reconcileTerminalRepoGuards(input: {
  repoFullName?: string;
  pullRequestNumber?: number;
  now?: Date;
  limit?: number;
} = {}) {
  const now = input.now ?? new Date();
  const guards = await prisma.agentRepoGuard.findMany({
    where: {
      activeScopeKey: { not: null },
      ...(input.repoFullName ? { repoFullName: input.repoFullName } : {}),
      run: { status: { in: ["SUCCEEDED", "DEAD_LETTER", "CANCELLED"] } },
    },
    include: { run: { select: { id: true, repoFullName: true, outcome: true } } },
    orderBy: { acquiredAt: "asc" },
    take: Math.max(1, Math.min(input.limit ?? 100, 500)),
  });
  let released = 0;
  for (const guard of guards) {
    const pullRequestNumber = resultPullRequestNumber(guard.run.outcome);
    if (!pullRequestNumber || (input.pullRequestNumber && pullRequestNumber !== input.pullRequestNumber)) continue;
    const pullRequest = await prisma.pullRequestMirror.findUnique({
      where: {
        repoFullName_number: {
          repoFullName: guard.run.repoFullName,
          number: pullRequestNumber,
        },
      },
      select: { state: true },
    });
    if (!pullRequest || pullRequest.state === "OPEN") continue;
    await prisma.$transaction(async (tx) => {
      const changed = await tx.agentRepoGuard.updateMany({
        where: { id: guard.id, activeScopeKey: { not: null } },
        data: { activeScopeKey: null, releasedAt: now },
      });
      if (changed.count === 1) {
        await tx.agentRunEvent.create({
          data: {
            runId: guard.run.id,
            type: "repo_guard_released",
            actor: "system:pr-readback",
            payload: { pullRequestNumber, state: pullRequest.state },
          },
        });
      }
      released += changed.count;
    });
  }
  return { scanned: guards.length, released };
}
