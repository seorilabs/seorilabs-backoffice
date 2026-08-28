import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  MANAGED_WORKER_TEMPLATE_KEYS,
  parseManagedWorkerPolicy,
  type AutomationPolicy,
} from "@/lib/control-plane/automation-catalog";
import { prisma } from "@/lib/prisma";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { canonicalJson, type JsonValue } from "@/lib/control-plane/json";
import { repositoryAutomationEligible } from "@/lib/control-plane/repository-registration";

class RepoScopeBusyError extends Error {}

const READ_ONLY_OUTCOME_CODES = new Set(["NO_CHANGES", "READBACK_CONFIRMED", "RESULT_UNKNOWN", "BLOCKED"]);

const AGENT_ACTION_CAPABILITIES = {
  READ_ONLY: ["github.issue.read", "github.pull_request.read", "provider.readback"],
  READY_PR: [
    "github.issue.read",
    "github.pull_request.read",
    "github.branch.write",
    "github.commit.write",
    "github.pull_request.create",
    "provider.readback",
  ],
} as const;
const READBACK_ACTION_CAPABILITIES = ["github.issue.read", "github.pull_request.read", "provider.readback"] as const;

export function mutationCapabilityBrokerEnforced(): boolean {
  return process.env.AGENT_MUTATION_CAPABILITY_BROKER_ENFORCED === "true";
}

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

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
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

function leaseToken(input: {
  signingKey: string;
  requestId: string;
  workerId: string;
  runId: string;
  generation: number;
}): string {
  if (!input.signingKey) {
    throw new ControlPlaneError("AGENT_LEASE_SIGNING_KEY가 필요합니다.", 503, "LEASE_SIGNING_UNAVAILABLE");
  }
  return crypto.createHmac("sha256", input.signingKey)
    .update(`${input.requestId}:${input.workerId}:${input.runId}:${input.generation}`)
    .digest("base64url");
}

export function repoPrScope(repoFullName: string, createsPr: boolean): string | null {
  return createsPr ? `repo-pr:${repoFullName.toLowerCase()}` : null;
}

export function eligibleForAutopilot(input: {
  issueNumber?: number | null;
  issueState?: string | null;
  labels: unknown;
}): boolean {
  if (input.issueNumber && input.issueState?.toUpperCase() !== "OPEN") return false;
  const labels = Array.isArray(input.labels)
    ? input.labels.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase())
    : [];
  if (input.issueNumber && !labels.includes("autopilot")) return false;
  return !labels.some((label) =>
    label === "blocked" || label === "no-autopilot" || label.startsWith("approval:"),
  );
}

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
  run: { id: string; repoFullName: string; createsPr: boolean },
  now: Date,
): Promise<boolean> {
  const activeScopeKey = repoPrScope(run.repoFullName, run.createsPr);
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

export function expiredLeaseDisposition(input: {
  createsPr: boolean;
  readbackRequested: boolean;
  attempts: number;
  maxAttempts: number;
}) {
  const readbackRequired = input.readbackRequested || input.createsPr;
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
          createsPr: true,
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
      const disposition = expiredLeaseDisposition({
        createsPr: lease.run.createsPr,
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
      if (readbackRequired) {
        await tx.automationOccurrence.update({
          where: { id: lease.run.occurrenceId },
          data: { status: "RUNNING", completedAt: null, result: { code: "LEASE_EXPIRED_READBACK_REQUIRED" } },
        });
      }
      if (terminal) {
        await releaseRepoGuard(tx, lease.runId, now);
        await tx.automationOccurrence.update({
          where: { id: lease.run.occurrenceId },
          data: { status: "DEAD_LETTER", completedAt: now },
        });
      }
    });
  }
}

export interface ClaimedAgentRun {
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
  leaseToken: string;
  expiresAt: Date;
  duplicate: boolean;
}

async function replayClaim(input: {
  requestId: string;
  workerId: string;
  agentKind: "CODEX" | "CLAUDE";
  signingKey: string;
  now: Date;
}): Promise<ClaimedAgentRun | null> {
  const event = await prisma.agentRunEvent.findUnique({
    where: { requestId: input.requestId },
    include: {
      run: {
        include: {
          leases: true,
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
  if (!lease || lease.revokedAt || lease.expiresAt <= input.now) {
    throw new ControlPlaneError("claim 재생 시점에 lease가 만료되었습니다.", 409, "IDEMPOTENCY_REPLAY_EXPIRED");
  }
  const policy = managedPolicy(event.run.occurrence.definition);
  if (!policy) {
    throw new ControlPlaneError("legacy routine claim은 재생할 수 없습니다.", 409, "DEFINITION_CONTRACT_UNMANAGED");
  }
  const spentMicros = Number(event.run.spentMicros ?? 0n);
  const resumeMode = event.run.readbackRequestedAt ? "READBACK_FIRST" as const : "START" as const;
  if (resumeMode === "START") {
    const registration = await prisma.repositoryRegistration.findUnique({
      where: { repoFullName: event.run.repoFullName },
      select: {
        archived: true,
        status: true,
        managementKind: true,
        lastDefaultPushSha: true,
        lastReconciledSha: true,
      },
    });
    if (!repositoryAutomationEligible(registration)) return null;
  }
  return {
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
    actionCapabilities: resumeMode === "READBACK_FIRST"
      ? READBACK_ACTION_CAPABILITIES
      : AGENT_ACTION_CAPABILITIES[policy.approvalPolicy],
    resumeMode,
    generation: event.generation,
    leaseToken: leaseToken({ ...input, runId: event.run.id, generation: event.generation }),
    expiresAt: lease.expiresAt,
    duplicate: true,
  };
}

async function tryClaimRun(input: {
  runId: string;
  workerId: string;
  leaseSeconds: number;
  now: Date;
  idempotencyKey: string;
  signingKey: string;
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
      if (!policy || !run.occurrence.definition.enabled || run.occurrence.definition.cancelledAt) return null;
      if (!readbackClaim) {
        const registration = await tx.repositoryRegistration.findUnique({
          where: { repoFullName: run.repoFullName },
          select: {
            archived: true,
            status: true,
            managementKind: true,
            lastDefaultPushSha: true,
            lastReconciledSha: true,
          },
        });
        if (!repositoryAutomationEligible(registration)) return null;
      }
      if (policy.approvalPolicy === "READY_PR" && !mutationCapabilityBrokerEnforced()) return null;
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
          select: { number: true, state: true, labels: true },
        });
        if (!issue || !eligibleForAutopilot({
          issueNumber: issue.number,
          issueState: issue.state,
          labels: issue.labels,
        })) return null;
      }
      if (!readbackClaim && run.createsPr) {
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
      if (!(await acquireRepoGuard(tx, run, input.now))) throw new RepoScopeBusyError();
      const token = leaseToken({
        signingKey: input.signingKey,
        requestId: input.idempotencyKey,
        workerId: input.workerId,
        runId: run.id,
        generation,
      });
      const expiresAt = new Date(input.now.getTime() + input.leaseSeconds * 1000);
      await tx.agentLease.create({
        data: {
          runId: run.id,
          generation,
          tokenHash: tokenHash(token),
          workerId: input.workerId,
          scopeKey: repoPrScope(run.repoFullName, run.createsPr),
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
            expiresAt: expiresAt.toISOString(),
            resumeMode: readbackClaim ? "READBACK_FIRST" : "START",
            actionCapabilities: readbackClaim
              ? READBACK_ACTION_CAPABILITIES
              : AGENT_ACTION_CAPABILITIES[policy.approvalPolicy],
          },
        },
      });
      return {
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
        actionCapabilities: readbackClaim
          ? READBACK_ACTION_CAPABILITIES
          : AGENT_ACTION_CAPABILITIES[policy.approvalPolicy],
        resumeMode: readbackClaim ? "READBACK_FIRST" : "START",
        generation,
        leaseToken: token,
        expiresAt,
        duplicate: false,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof RepoScopeBusyError) return null;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  }
}

export async function claimAgentRun(input: {
  workerId: string;
  agentKind: "CODEX" | "CLAUDE";
  leaseSeconds: number;
  idempotencyKey: string;
  signingKey: string;
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
          enabled: true,
          cancelledAt: null,
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

async function activeLease(input: {
  runId: string;
  generation: number;
  leaseToken: string;
  workerId: string;
  now: Date;
}) {
  return prisma.agentLease.findFirst({
    where: {
      runId: input.runId,
      generation: input.generation,
      tokenHash: tokenHash(input.leaseToken),
      workerId: input.workerId,
      revokedAt: null,
      expiresAt: { gt: input.now },
    },
  });
}

export async function heartbeatAgentRun(input: {
  runId: string;
  generation: number;
  leaseToken: string;
  workerId: string;
  leaseSeconds: number;
  idempotencyKey: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const replay = await prisma.agentRunEvent.findUnique({ where: { requestId: input.idempotencyKey } });
  if (replay) {
    if (replay.runId !== input.runId || replay.generation !== input.generation || replay.actor !== input.workerId || replay.type !== "heartbeat") {
      throw new ControlPlaneError("idempotency key가 다른 heartbeat에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    const payload = replay.payload as { expiresAt?: string } | null;
    return { expiresAt: new Date(payload?.expiresAt ?? 0), duplicate: true };
  }
  const lease = await activeLease({ ...input, now });
  if (!lease) throw new ControlPlaneError("유효한 agent lease가 아닙니다.", 409, "STALE_LEASE");
  const expiresAt = new Date(now.getTime() + input.leaseSeconds * 1000);
  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.agentLease.updateMany({
        where: { id: lease.id, revokedAt: null, expiresAt: { gt: now } },
        data: { heartbeatAt: now, expiresAt },
      });
      if (updated.count !== 1) throw new ControlPlaneError("agent lease heartbeat CAS에 실패했습니다.", 409, "STALE_LEASE");
      await tx.agentRunEvent.create({
        data: {
          requestId: input.idempotencyKey,
          runId: input.runId,
          type: "heartbeat",
          generation: input.generation,
          actor: input.workerId,
          payload: { expiresAt: expiresAt.toISOString() },
        },
      });
    });
    return { expiresAt, duplicate: false };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    return heartbeatAgentRun({ ...input, now });
  }
}

export async function settleAgentRun(input: {
  runId: string;
  generation: number;
  leaseToken: string;
  workerId: string;
  outcome: "complete" | "fail" | "unknown";
  result: Record<string, unknown>;
  error?: string;
  idempotencyKey: string;
  now?: Date;
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
      ? ["completed", ...policyEvents]
      : input.outcome === "unknown"
        ? ["readback_required"]
        : ["retry_scheduled", "dead_letter", ...policyEvents];
    if (
      replay.runId !== input.runId
      || replay.generation !== input.generation
      || replay.actor !== input.workerId
      || !expectedTypes.includes(replay.type)
    ) {
      throw new ControlPlaneError("idempotency key가 다른 completion에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    const payload = replay.payload as { status?: string; retry?: boolean; requestHash?: string } | null;
    if (payload?.requestHash !== requestHash) {
      throw new ControlPlaneError("idempotency key가 다른 completion payload에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { status: payload?.status ?? "UNKNOWN", retry: payload?.retry ?? false, duplicate: true };
  }
  try {
    const settled = await prisma.$transaction(async (tx) => {
    const lease = await tx.agentLease.findFirst({
      where: {
        runId: input.runId,
        generation: input.generation,
        tokenHash: tokenHash(input.leaseToken),
        workerId: input.workerId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      include: {
        run: { include: { occurrence: { include: { definition: true } } } },
      },
    });
    if (!lease || !validSettlementLease({
      runStatus: lease.run.status,
      currentGeneration: lease.run.leaseGeneration,
      requestedGeneration: input.generation,
      leaseActive: true,
    })) {
      throw new ControlPlaneError("stale completion은 반영할 수 없습니다.", 409, "STALE_LEASE");
    }
    const policy = managedPolicy(lease.run.occurrence.definition);
    if (!policy) {
      throw new ControlPlaneError("legacy routine 결과는 반영할 수 없습니다.", 409, "DEFINITION_CONTRACT_UNMANAGED");
    }
    const costMicros = resultCostMicros(input.result);
    const nextSpentMicros = (lease.run.spentMicros ?? 0n) + (costMicros ?? 0n);
    const policyError = agentResultPolicyError({
      policy,
      configuredModel: lease.run.occurrence.definition.model,
      spentMicros: lease.run.spentMicros,
      result: input.result,
    });
    const readbackRequired = input.outcome === "unknown";
    const succeeded = input.outcome === "complete" && !policyError;
    const retry = input.outcome === "fail" && !policyError && lease.run.attempts < lease.run.maxAttempts;
    const runStatus = succeeded
      ? "SUCCEEDED"
      : readbackRequired
        ? "FAILED"
        : retry
          ? "PENDING"
          : "DEAD_LETTER";
    const changed = await tx.agentRun.updateMany({
      where: { id: input.runId, status: "RUNNING", leaseGeneration: input.generation },
      data: {
        status: runStatus,
        completedAt: succeeded || (!retry && !readbackRequired) ? now : null,
        eligibleAt: retry ? now : lease.run.eligibleAt,
        spentMicros: nextSpentMicros,
        outcome: input.result as Prisma.InputJsonValue,
        error: succeeded
          ? null
          : (policyError ?? input.error ?? (readbackRequired ? "PROVIDER_READBACK_REQUIRED" : "WORKER_FAILED")),
        readbackRequestedAt: readbackRequired ? now : null,
      },
    });
    if (changed.count !== 1) throw new ControlPlaneError("stale completion은 반영할 수 없습니다.", 409, "STALE_LEASE");
    await tx.agentLease.update({
      where: { id: lease.id },
      data: { revokedAt: now, scopeKey: null },
    });
    if (input.result.outcomeCode === "PR_READY" && !lease.run.createsPr) {
      await acquireRepoGuard(tx, { ...lease.run, createsPr: true }, now);
    }
    const retainsPrGuard = input.result.outcomeCode === "PR_READY";
    if ((succeeded && !retainsPrGuard) || (!retry && !readbackRequired && !succeeded && !retainsPrGuard)) {
      await releaseRepoGuard(tx, input.runId, now);
    }
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
        runId: input.runId,
        type: readbackRequired
          ? "readback_required"
          : policyError === "BUDGET_CEILING_EXCEEDED"
          ? "budget_exceeded"
          : policyError === "RESULT_COST_REQUIRED"
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
        generation: input.generation,
        actor: input.workerId,
        payload: {
          status: runStatus,
          retry,
          budgetCeilingMicros: policy.budgetCeilingMicros,
          spentMicros: Number(nextSpentMicros),
          approvalPolicy: policy.approvalPolicy,
          result: input.result,
          ...(policyError ? { policyError } : {}),
          requestHash,
        } as Prisma.InputJsonValue,
      },
    });
    return { status: runStatus, retry, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return settled;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    return settleAgentRun({ ...input, now });
  }
}

export async function resolveAgentRunReadback(input: {
  runId: string;
  generation: number;
  leaseToken: string;
  workerId: string;
  resolution: "RESUME" | "COMPLETE" | "BLOCKED";
  result: Record<string, unknown>;
  idempotencyKey: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const requestHash = agentReadbackRequestHash(input);
  const ownedLease = await prisma.agentLease.findFirst({
    where: {
      runId: input.runId,
      generation: input.generation,
      workerId: input.workerId,
      tokenHash: tokenHash(input.leaseToken),
    },
    select: { id: true },
  });
  if (!ownedLease) {
    throw new ControlPlaneError("readback source lease 소유권이 일치하지 않습니다.", 409, "READBACK_LEASE_MISMATCH");
  }
  const replay = await prisma.agentRunEvent.findUnique({ where: { requestId: input.idempotencyKey } });
  if (replay) {
    const payload = replay.payload as { status?: string; requestedResolution?: string; requestHash?: string } | null;
    if (
      replay.runId !== input.runId
      || replay.generation !== input.generation
      || replay.actor !== input.workerId
      || !["readback_resumed", "readback_completed", "readback_blocked", "readback_policy_blocked"].includes(replay.type)
      || payload?.requestedResolution !== input.resolution
      || payload?.requestHash !== requestHash
    ) {
      throw new ControlPlaneError("idempotency key가 다른 readback에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { status: payload?.status ?? "UNKNOWN", duplicate: true };
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const run = await tx.agentRun.findUnique({
        where: { id: input.runId },
        include: { occurrence: { include: { definition: true } } },
      });
      const sourceLease = await tx.agentLease.findFirst({
        where: {
          runId: input.runId,
          generation: input.generation,
          workerId: input.workerId,
          tokenHash: tokenHash(input.leaseToken),
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true },
      });
      if (
        !run
        || !sourceLease
        || run.status !== "RUNNING"
        || !run.readbackRequestedAt
        || run.leaseGeneration !== input.generation
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
          leaseGeneration: input.generation,
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
      const retainsPrGuard = input.result.outcomeCode === "PR_READY";
      if (retainsPrGuard && !run.createsPr) {
        await acquireRepoGuard(tx, { ...run, createsPr: true }, now);
      }
      if (effectiveResolution === "COMPLETE" && !retainsPrGuard) await releaseRepoGuard(tx, run.id, now);
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
          generation: input.generation,
          actor: input.workerId,
          payload: {
            status,
            requestedResolution: input.resolution,
            result: input.result,
            spentMicros: Number(nextSpentMicros),
            workKeyReleased,
            ...(policyError ? { policyError } : {}),
            requestHash,
          } as Prisma.InputJsonValue,
        },
      });
      return { status, duplicate: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    return resolveAgentRunReadback({ ...input, now });
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
