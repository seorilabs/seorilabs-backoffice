import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { parseAutomationPolicy } from "@/lib/control-plane/automation-catalog";
import { prisma } from "@/lib/prisma";
import { ControlPlaneError } from "@/lib/control-plane/service";

class RepoScopeBusyError extends Error {}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
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

export async function requeueExpiredLeases(now: Date): Promise<void> {
  const expired = await prisma.agentLease.findMany({
    where: { revokedAt: null, expiresAt: { lte: now }, run: { status: "RUNNING" } },
    select: { id: true, runId: true, generation: true, run: { select: { attempts: true, maxAttempts: true } } },
    take: 100,
  });
  for (const lease of expired) {
    await prisma.$transaction(async (tx) => {
      const revoked = await tx.agentLease.updateMany({
        where: { id: lease.id, revokedAt: null, expiresAt: { lte: now } },
        data: { revokedAt: now, scopeKey: null },
      });
      if (revoked.count !== 1) return;
      const terminal = lease.run.attempts >= lease.run.maxAttempts;
      const runChanged = await tx.agentRun.updateMany({
        where: { id: lease.runId, status: "RUNNING", leaseGeneration: lease.generation },
        data: {
          status: terminal ? "DEAD_LETTER" : "PENDING",
          eligibleAt: now,
          error: "LEASE_EXPIRED",
        },
      });
      if (runChanged.count !== 1) return;
      await tx.agentRunEvent.create({
        data: {
          runId: lease.runId,
          type: terminal ? "dead_letter" : "lease_expired",
          generation: lease.generation,
          actor: "system",
        },
      });
      if (terminal) {
        await releaseRepoGuard(tx, lease.runId, now);
        const run = await tx.agentRun.findUnique({ where: { id: lease.runId }, select: { occurrenceId: true } });
        if (run) {
          await tx.automationOccurrence.update({
            where: { id: run.occurrenceId },
            data: { status: "DEAD_LETTER", completedAt: now },
          });
        }
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
  const policy = parseAutomationPolicy(event.run.occurrence.definition.configuration);
  return {
    runId: event.run.id,
    repoFullName: event.run.repoFullName,
    issueNumber: event.run.issueNumber,
    template: event.run.occurrence.definition.template,
    agentKind: event.run.occurrence.definition.agentKind ?? "UNKNOWN",
    model: event.run.occurrence.definition.model,
    approvalPolicy: policy.approvalPolicy,
    budgetCeilingMicros: policy.budgetCeilingMicros,
    resumeMode: event.generation > 1 ? "READBACK_FIRST" : "START",
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
      if (!run || run.status !== "PENDING" || run.eligibleAt > input.now || !eligibleForAutopilot(run)) {
        return null;
      }
      if (run.issueNumber) {
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
      if (run.createsPr) {
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
        where: { id: run.id, status: "PENDING", leaseGeneration: run.leaseGeneration },
        data: {
          status: "RUNNING",
          leaseGeneration: generation,
          attempts: { increment: 1 },
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
          payload: { expiresAt: expiresAt.toISOString() },
        },
      });
      const policy = parseAutomationPolicy(run.occurrence.definition.configuration);
      return {
        runId: run.id,
        repoFullName: run.repoFullName,
        issueNumber: run.issueNumber,
        template: run.occurrence.definition.template,
        agentKind: run.occurrence.definition.agentKind ?? "UNKNOWN",
        model: run.occurrence.definition.model,
        approvalPolicy: policy.approvalPolicy,
        budgetCeilingMicros: policy.budgetCeilingMicros,
        resumeMode: generation > 1 ? "READBACK_FIRST" : "START",
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
      status: "PENDING",
      eligibleAt: { lte: now },
      occurrence: { definition: { enabled: true, agentKind: input.agentKind } },
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
  result?: Record<string, unknown>;
  error?: string;
  idempotencyKey: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const replay = await prisma.agentRunEvent.findUnique({ where: { requestId: input.idempotencyKey } });
  if (replay) {
    const expectedTypes = input.outcome === "complete"
      ? ["completed", "budget_exceeded", "approval_policy_violation", "model_policy_violation"]
      : input.outcome === "unknown"
        ? ["readback_required"]
        : ["retry_scheduled", "dead_letter"];
    if (
      replay.runId !== input.runId
      || replay.generation !== input.generation
      || replay.actor !== input.workerId
      || !expectedTypes.includes(replay.type)
    ) {
      throw new ControlPlaneError("idempotency key가 다른 completion에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    const payload = replay.payload as { status?: string; retry?: boolean } | null;
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
    const policy = parseAutomationPolicy(lease.run.occurrence.definition.configuration);
    const costMicros = input.result?.costMicros;
    const budgetExceeded = typeof costMicros === "number" && costMicros > policy.budgetCeilingMicros;
    const approvalViolation = policy.approvalPolicy === "READ_ONLY"
      && input.result?.outcomeCode === "PR_READY";
    const modelViolation = Boolean(lease.run.occurrence.definition.model)
      && Boolean(input.result)
      && input.result?.model !== lease.run.occurrence.definition.model;
    const policyError = budgetExceeded
      ? "BUDGET_CEILING_EXCEEDED"
      : approvalViolation
        ? "APPROVAL_POLICY_VIOLATION"
        : modelViolation
          ? "MODEL_POLICY_VIOLATION"
          : null;
    const effectiveOutcome = policyError ? "fail" : input.outcome;
    const readbackRequired = effectiveOutcome === "unknown";
    const retry = effectiveOutcome === "fail" && !policyError && lease.run.attempts < lease.run.maxAttempts;
    const runStatus = effectiveOutcome === "complete"
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
        completedAt: effectiveOutcome === "complete" || (!retry && !readbackRequired) ? now : null,
        eligibleAt: retry ? now : lease.run.eligibleAt,
        outcome: input.result ? (input.result as Prisma.InputJsonValue) : undefined,
        error: effectiveOutcome === "complete"
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
    if (input.result?.outcomeCode === "PR_READY" && !lease.run.createsPr) {
      await acquireRepoGuard(tx, { ...lease.run, createsPr: true }, now);
    }
    const retainsPrGuard = input.result?.outcomeCode === "PR_READY";
    if ((effectiveOutcome === "complete" && !retainsPrGuard) || (!retry && !readbackRequired && effectiveOutcome !== "complete" && !retainsPrGuard)) {
      await releaseRepoGuard(tx, input.runId, now);
    }
    await tx.automationOccurrence.update({
      where: { id: lease.run.occurrenceId },
      data: {
        status: effectiveOutcome === "complete"
          ? "COMPLETED"
          : readbackRequired
            ? "RUNNING"
            : retry
              ? "PENDING"
              : "DEAD_LETTER",
        completedAt: effectiveOutcome === "complete" || (!retry && !readbackRequired) ? now : null,
      },
    });
    await tx.agentRunEvent.create({
      data: {
        requestId: input.idempotencyKey,
        runId: input.runId,
        type: policyError === "BUDGET_CEILING_EXCEEDED"
          ? "budget_exceeded"
          : policyError === "APPROVAL_POLICY_VIOLATION"
            ? "approval_policy_violation"
            : policyError === "MODEL_POLICY_VIOLATION"
              ? "model_policy_violation"
            : effectiveOutcome === "complete"
              ? "completed"
          : readbackRequired
            ? "readback_required"
            : retry
              ? "retry_scheduled"
              : "dead_letter",
        generation: input.generation,
        actor: input.workerId,
        payload: {
          status: runStatus,
          retry,
          budgetCeilingMicros: policy.budgetCeilingMicros,
          approvalPolicy: policy.approvalPolicy,
          ...(input.result ? { result: input.result } : {}),
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
  const ownedLease = await prisma.agentLease.findFirst({
    where: {
      runId: input.runId,
      generation: input.generation,
      workerId: input.workerId,
      tokenHash: tokenHash(input.leaseToken),
      revokedAt: { not: null },
    },
    select: { id: true },
  });
  if (!ownedLease) {
    throw new ControlPlaneError("readback source lease 소유권이 일치하지 않습니다.", 409, "READBACK_LEASE_MISMATCH");
  }
  const replay = await prisma.agentRunEvent.findUnique({ where: { requestId: input.idempotencyKey } });
  if (replay) {
    const payload = replay.payload as { status?: string; requestedResolution?: string } | null;
    if (
      replay.runId !== input.runId
      || replay.generation !== input.generation
      || replay.actor !== input.workerId
      || !["readback_resumed", "readback_completed", "readback_blocked", "readback_policy_blocked"].includes(replay.type)
      || payload?.requestedResolution !== input.resolution
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
        },
        select: { id: true, revokedAt: true },
      });
      if (
        !run
        || !sourceLease?.revokedAt
        || run.status !== "FAILED"
        || !run.readbackRequestedAt
        || run.leaseGeneration !== input.generation
      ) {
        throw new ControlPlaneError("readback 대기 중인 동일 generation run이 아닙니다.", 409, "READBACK_STATE_CONFLICT");
      }
      const policy = parseAutomationPolicy(run.occurrence.definition.configuration);
      let policyError: string | null = null;
      if (input.resolution === "COMPLETE") {
        if (typeof input.result.costMicros === "number" && input.result.costMicros > policy.budgetCeilingMicros) {
          policyError = "BUDGET_CEILING_EXCEEDED";
        } else if (policy.approvalPolicy === "READ_ONLY" && input.result.outcomeCode === "PR_READY") {
          policyError = "APPROVAL_POLICY_VIOLATION";
        } else if (run.occurrence.definition.model && input.result.model !== run.occurrence.definition.model) {
          policyError = "MODEL_POLICY_VIOLATION";
        }
      }
      const effectiveResolution = policyError ? "BLOCKED" : input.resolution;
      const status = effectiveResolution === "RESUME"
        ? "PENDING"
        : effectiveResolution === "COMPLETE"
          ? "SUCCEEDED"
          : "DEAD_LETTER";
      await tx.agentRun.update({
        where: { id: run.id },
        data: {
          status,
          eligibleAt: effectiveResolution === "RESUME" ? now : run.eligibleAt,
          completedAt: effectiveResolution === "RESUME" ? null : now,
          readbackRequestedAt: null,
          error: policyError ?? (effectiveResolution === "BLOCKED" ? "READBACK_BLOCKED" : null),
          outcome: input.result as Prisma.InputJsonValue,
        },
      });
      const retainsPrGuard = input.result.outcomeCode === "PR_READY";
      if (retainsPrGuard && !run.createsPr) {
        await acquireRepoGuard(tx, { ...run, createsPr: true }, now);
      }
      if (effectiveResolution !== "RESUME" && !retainsPrGuard) await releaseRepoGuard(tx, run.id, now);
      let workKeyReleased = false;
      if (effectiveResolution !== "RESUME" && run.issueNumber) {
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
            workKeyReleased,
            ...(policyError ? { policyError } : {}),
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
