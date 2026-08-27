import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ControlPlaneError } from "@/lib/control-plane/service";

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
  return !labels.some((label) =>
    label === "blocked" || label === "no-autopilot" || label.startsWith("approval:"),
  );
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

export async function createAutomationOccurrence(input: {
  definitionId: string;
  scheduledFor: Date;
  idempotencyKey: string;
  run: {
    appId?: string;
    repoFullName: string;
    issueNumber?: number;
    issueState?: string;
    labels: string[];
    createsPr?: boolean;
    priority?: number;
  };
}) {
  const replay = await prisma.automationOccurrence.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { runs: true },
  });
  if (replay) return { occurrence: replay, duplicate: true };
  const definition = await prisma.automationDefinition.findUnique({
    where: { id: input.definitionId },
  });
  if (!definition?.enabled) {
    throw new ControlPlaneError("활성 AutomationDefinition을 찾을 수 없습니다.", 404, "DEFINITION_NOT_FOUND");
  }
  if (!eligibleForAutopilot(input.run)) {
    throw new ControlPlaneError("이 실행은 autopilot claim 대상이 아닙니다.", 409, "RUN_NOT_ELIGIBLE");
  }
  try {
    const occurrence = await prisma.automationOccurrence.create({
      data: {
        definitionId: definition.id,
        scheduledFor: input.scheduledFor,
        idempotencyKey: input.idempotencyKey,
        runs: {
          create: {
            appId: input.run.appId,
            repoFullName: input.run.repoFullName,
            issueNumber: input.run.issueNumber,
            issueState: input.run.issueState,
            labels: input.run.labels,
            createsPr: input.run.createsPr ?? true,
            priority: input.run.priority ?? 100,
            maxAttempts: definition.maxAttempts,
          },
        },
      },
      include: { runs: true },
    });
    return { occurrence, duplicate: false };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const duplicate = await prisma.automationOccurrence.findFirst({
      where: {
        OR: [
          { idempotencyKey: input.idempotencyKey },
          { definitionId: definition.id, scheduledFor: input.scheduledFor },
        ],
      },
      include: { runs: true },
    });
    if (!duplicate) throw error;
    return { occurrence: duplicate, duplicate: true };
  }
}

async function requeueExpiredLeases(now: Date): Promise<void> {
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
      await tx.agentRun.updateMany({
        where: { id: lease.runId, status: "RUNNING", leaseGeneration: lease.generation },
        data: {
          status: terminal ? "DEAD_LETTER" : "PENDING",
          eligibleAt: now,
          error: "lease expired",
        },
      });
      await tx.agentRunEvent.create({
        data: {
          runId: lease.runId,
          type: terminal ? "dead_letter" : "lease_expired",
          generation: lease.generation,
          actor: "system",
        },
      });
      if (terminal) {
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
  generation: number;
  leaseToken: string;
  expiresAt: Date;
  duplicate: boolean;
}

async function replayClaim(input: {
  requestId: string;
  workerId: string;
  signingKey: string;
  now: Date;
}): Promise<ClaimedAgentRun | null> {
  const event = await prisma.agentRunEvent.findUnique({
    where: { requestId: input.requestId },
    include: { run: { include: { leases: true } } },
  });
  if (!event) return null;
  if (event.type !== "claimed" || event.actor !== input.workerId || !event.generation) {
    throw new ControlPlaneError("idempotency key가 다른 agent 작업에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
  }
  const lease = event.run.leases.find((candidate) => candidate.generation === event.generation);
  if (!lease || lease.revokedAt || lease.expiresAt <= input.now) {
    throw new ControlPlaneError("claim 재생 시점에 lease가 만료되었습니다.", 409, "IDEMPOTENCY_REPLAY_EXPIRED");
  }
  return {
    runId: event.run.id,
    repoFullName: event.run.repoFullName,
    issueNumber: event.run.issueNumber,
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
      const run = await tx.agentRun.findUnique({ where: { id: input.runId } });
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
        if (openAutopilotPr) return null;
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
      return {
        runId: run.id,
        repoFullName: run.repoFullName,
        issueNumber: run.issueNumber,
        generation,
        leaseToken: token,
        expiresAt,
        duplicate: false,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  }
}

export async function claimAgentRun(input: {
  workerId: string;
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
      occurrence: { definition: { enabled: true } },
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
  outcome: "complete" | "fail";
  result?: Record<string, unknown>;
  error?: string;
  idempotencyKey: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const replay = await prisma.agentRunEvent.findUnique({ where: { requestId: input.idempotencyKey } });
  if (replay) {
    const expectedTypes = input.outcome === "complete"
      ? ["completed"]
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
      include: { run: true },
    });
    if (!lease || !validSettlementLease({
      runStatus: lease.run.status,
      currentGeneration: lease.run.leaseGeneration,
      requestedGeneration: input.generation,
      leaseActive: true,
    })) {
      throw new ControlPlaneError("stale completion은 반영할 수 없습니다.", 409, "STALE_LEASE");
    }
    const retry = input.outcome === "fail" && lease.run.attempts < lease.run.maxAttempts;
    const runStatus = input.outcome === "complete" ? "SUCCEEDED" : retry ? "PENDING" : "DEAD_LETTER";
    const changed = await tx.agentRun.updateMany({
      where: { id: input.runId, status: "RUNNING", leaseGeneration: input.generation },
      data: {
        status: runStatus,
        completedAt: input.outcome === "complete" || !retry ? now : null,
        eligibleAt: retry ? now : lease.run.eligibleAt,
        outcome: input.result ? (input.result as Prisma.InputJsonValue) : undefined,
        error: input.outcome === "fail" ? input.error ?? "worker failed" : null,
      },
    });
    if (changed.count !== 1) throw new ControlPlaneError("stale completion은 반영할 수 없습니다.", 409, "STALE_LEASE");
    await tx.agentLease.update({
      where: { id: lease.id },
      data: { revokedAt: now, scopeKey: null },
    });
    await tx.automationOccurrence.update({
      where: { id: lease.run.occurrenceId },
      data: {
        status: input.outcome === "complete" ? "COMPLETED" : retry ? "PENDING" : "DEAD_LETTER",
        completedAt: input.outcome === "complete" || !retry ? now : null,
      },
    });
    await tx.agentRunEvent.create({
      data: {
        requestId: input.idempotencyKey,
        runId: input.runId,
        type: input.outcome === "complete" ? "completed" : retry ? "retry_scheduled" : "dead_letter",
        generation: input.generation,
        actor: input.workerId,
        payload: {
          status: runStatus,
          retry,
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
