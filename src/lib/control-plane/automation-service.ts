import crypto from "node:crypto";
import { Prisma } from "@prisma/client";

import {
  AUTOMATION_TEMPLATE_KEY,
  automationPolicy,
  automationIdempotencyKey,
  cadenceForSchedule,
  definitionKey,
  dueScheduleSlots,
  fleetProjectFields,
  isManagedAutomationDefinition,
  parseManagedAutomationPolicy,
  scheduleForCadence,
  type AutomationAgentKind,
  type AutomationApprovalPolicy,
  type AutomationCadence,
} from "@/lib/control-plane/automation";
import {
  eligibleForAutopilot,
  mutationCapabilityBrokerEnforced,
  reconcileTerminalRepoGuards,
  releaseRepoGuard,
} from "@/lib/control-plane/agent-queue";
import { canonicalJson, type JsonValue } from "@/lib/control-plane/json";
import {
  durableIssueObservation,
  durableIngressEnvelopeHash,
  durableIssueToMirrorInput,
  parseDurableIssueObservation,
  parseDurableStableTagPush,
  type DurableIssueObservation,
  type DurableStableTagPush,
} from "@/lib/control-plane/automation-inbox";
import {
  beginAutomationMutation,
  completeAutomationMutation,
} from "@/lib/control-plane/automation-mutation";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";
import type { GhIssueInput } from "@/lib/sync/mirror";

const ISSUE_TRIGGER_ACTIONS = new Set(["opened", "reopened", "labeled", "unlabeled", "edited"]);
const CANCELLABLE_RUN_STATUSES = ["PENDING", "RUNNING"] as const;

function projectionHash(value: JsonValue): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function issueWorkKey(repoFullName: string, issueNumber: number): string {
  return `issue:${repoFullName.toLowerCase()}#${issueNumber}`;
}

function retryDelay(attempts: number): number {
  return Math.min(60 * 60_000, 2 ** Math.max(0, attempts - 1) * 30_000);
}

export async function recordWebhookDelivery(input: {
  deliveryId: string;
  event: string;
  action?: string | null;
  repoFullName?: string | null;
  issueNumber?: number | null;
  issueNodeId?: string | null;
  occurredAt?: Date | null;
  issue?: DurableIssueObservation | null;
  stableTagPush?: DurableStableTagPush | null;
}): Promise<{ duplicate: boolean }> {
  const sourceKey = `github:${input.deliveryId}`;
  const action = input.action ?? null;
  const durablePayload = input.issue ?? input.stableTagPush ?? null;
  const shouldEnqueue = Boolean(
    input.repoFullName
    && (
      (input.event === "issues" && input.issueNumber && input.issueNodeId && input.issue)
      || (input.event === "push" && input.stableTagPush)
    ),
  );
  const payloadHash = shouldEnqueue && input.repoFullName && durablePayload
    ? durableIngressEnvelopeHash({
      sourceKey,
      event: input.event,
      action,
      repoFullName: input.repoFullName,
      payload: durablePayload,
    })
    : null;
  let duplicateDetected = false;
  try {
    const inserted = await prisma.$transaction(async (tx) => {
      const delivery = await tx.webhookDelivery.createMany({
        data: [{ deliveryId: input.deliveryId, event: input.event, action }],
        skipDuplicates: true,
      });
      if (delivery.count === 0) return false;
      if (shouldEnqueue && input.repoFullName && durablePayload) {
        await tx.automationIngressEvent.create({
          data: {
            sourceKey,
            event: input.event,
            action,
            repoFullName: input.repoFullName,
            issueNumber: input.issueNumber,
            issueNodeId: input.issueNodeId,
            payload: durablePayload as Prisma.InputJsonValue,
            payloadHash,
            occurredAt: input.occurredAt ?? new Date(),
          },
        });
      }
      return true;
    });
    if (inserted) return { duplicate: false };
    duplicateDetected = true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    duplicateDetected = true;
  }
  if (duplicateDetected) {
    const delivery = await prisma.webhookDelivery.findUnique({ where: { deliveryId: input.deliveryId } });
    if (!delivery) throw new Error("duplicate webhook delivery row missing");
    if (delivery.event !== input.event || delivery.action !== action) {
      throw new ControlPlaneError("같은 delivery ID가 다른 webhook에 사용되었습니다.", 409, "WEBHOOK_DELIVERY_CONFLICT");
    }
    if (shouldEnqueue && input.repoFullName && durablePayload && payloadHash) {
      let ingress = await prisma.automationIngressEvent.findUnique({ where: { sourceKey } });
      if (!ingress) {
        await prisma.automationIngressEvent.createMany({
          data: [{
            sourceKey,
            event: input.event,
            action,
            repoFullName: input.repoFullName,
            issueNumber: input.issueNumber,
            issueNodeId: input.issueNodeId,
            payload: durablePayload as Prisma.InputJsonValue,
            payloadHash,
            occurredAt: input.occurredAt ?? new Date(),
          }],
          skipDuplicates: true,
        });
        ingress = await prisma.automationIngressEvent.findUnique({ where: { sourceKey } });
      }
      if (
        !ingress
        || ingress.event !== input.event
        || ingress.action !== action
        || ingress.repoFullName.toLowerCase() !== input.repoFullName.toLowerCase()
        || ingress.issueNumber !== (input.issueNumber ?? null)
        || ingress.issueNodeId !== (input.issueNodeId ?? null)
        || ingress.payloadHash !== payloadHash
      ) {
        throw new ControlPlaneError("같은 delivery ID의 durable payload가 일치하지 않습니다.", 409, "WEBHOOK_DELIVERY_CONFLICT");
      }
    }
    return { duplicate: true };
  }
  throw new Error("webhook delivery recording reached an invalid state");
}

async function eligibleIssue(input: {
  repoFullName: string;
  issueNumber?: number;
}) {
  const candidates = await prisma.issueMirror.findMany({
    where: {
      repoFullName: input.repoFullName,
      state: "OPEN",
      isAutopilot: true,
      isBlocked: false,
      ...(input.issueNumber ? { number: input.issueNumber } : {}),
    },
    select: {
      appId: true,
      number: true,
      state: true,
      labels: true,
      priority: true,
      ghCreatedAt: true,
    },
    orderBy: [{ priority: "asc" }, { ghCreatedAt: "asc" }],
    take: input.issueNumber ? 1 : 100,
  });
  const workKeys = candidates.map((issue) => issueWorkKey(input.repoFullName, issue.number));
  const consumed = workKeys.length === 0
    ? []
    : await prisma.agentRun.findMany({
      where: { workKey: { in: workKeys } },
      select: { workKey: true },
    });
  const consumedKeys = new Set(consumed.map(({ workKey }) => workKey));
  return candidates.find((issue) => eligibleForAutopilot({
    issueNumber: issue.number,
    issueState: issue.state,
    labels: issue.labels,
  }) && !consumedKeys.has(issueWorkKey(input.repoFullName, issue.number))) ?? null;
}

async function createNoWorkOccurrence(input: {
  definitionId: string;
  scheduledFor: Date;
  idempotencyKey: string;
  triggerKind: "MANUAL" | "SCHEDULE" | "WEBHOOK";
  triggerKey: string;
  code: "NO_ELIGIBLE_ISSUE" | "WORK_ALREADY_CLAIMED";
}) {
  try {
    return await prisma.automationOccurrence.create({
      data: {
        definitionId: input.definitionId,
        scheduledFor: input.scheduledFor,
        idempotencyKey: input.idempotencyKey,
        triggerKind: input.triggerKind,
        triggerKey: `${input.definitionId}:${input.triggerKey}`.slice(0, 191),
        status: "COMPLETED",
        result: { code: input.code },
        completedAt: new Date(),
      },
      include: { runs: true },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const replay = await prisma.automationOccurrence.findFirst({
      where: { OR: [{ idempotencyKey: input.idempotencyKey }, { definitionId: input.definitionId, scheduledFor: input.scheduledFor }] },
      include: { runs: true },
    });
    if (!replay) throw error;
    return replay;
  }
}

async function dispatchDefinition(input: {
  definition: {
    id: string;
    appId: string | null;
    enabled: boolean;
    cancelledAt: Date | null;
    maxAttempts: number;
    configuration: Prisma.JsonValue | null;
    template: string;
    agentKind: string | null;
    app: { repoFullName: string; status: string } | null;
  };
  triggerKind: "MANUAL" | "SCHEDULE" | "WEBHOOK";
  triggerKey: string;
  scheduledFor: Date;
  issueNumber?: number;
}) {
  const { definition } = input;
  if (!definition.enabled || definition.cancelledAt || !definition.app || definition.app.status !== "ACTIVE") {
    throw new ControlPlaneError("활성 routine이 아닙니다.", 409, "DEFINITION_INACTIVE");
  }
  if (!isManagedAutomationDefinition(definition)) {
    throw new ControlPlaneError(
      "legacy 또는 계약 불명 routine은 Fleet worker에 dispatch할 수 없습니다.",
      409,
      "DEFINITION_CONTRACT_UNMANAGED",
    );
  }
  const idempotencyKey = automationIdempotencyKey({
    definitionId: definition.id,
    triggerKind: input.triggerKind,
    triggerKey: input.triggerKey,
  });
  const replay = await prisma.automationOccurrence.findUnique({
    where: { idempotencyKey },
    include: { runs: true },
  });
  if (replay) return { occurrence: replay, duplicate: true };

  const issue = await eligibleIssue({
    repoFullName: definition.app.repoFullName,
    issueNumber: input.issueNumber,
  });
  if (!issue) {
    const occurrence = await createNoWorkOccurrence({
      ...input,
      definitionId: definition.id,
      idempotencyKey,
      code: "NO_ELIGIBLE_ISSUE",
    });
    return { occurrence, duplicate: false };
  }

  try {
    const labels = Array.isArray(issue.labels)
      ? issue.labels.filter((label): label is string => typeof label === "string")
      : [];
    const policy = parseManagedAutomationPolicy(definition.configuration)!;
    const occurrence = await prisma.automationOccurrence.create({
      data: {
        definitionId: definition.id,
        scheduledFor: input.scheduledFor,
        idempotencyKey,
        triggerKind: input.triggerKind,
        triggerKey: `${definition.id}:${input.triggerKey}`.slice(0, 191),
        runs: {
          create: {
            appId: issue.appId ?? definition.appId,
            repoFullName: definition.app.repoFullName,
            issueNumber: issue.number,
            workKey: issueWorkKey(definition.app.repoFullName, issue.number),
            issueState: issue.state,
            labels,
            createsPr: policy.createsPr,
            priority: issue.priority ? Number(issue.priority.slice(1)) : 100,
            maxAttempts: definition.maxAttempts,
          },
        },
      },
      include: { runs: true },
    });
    return { occurrence, duplicate: false };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const duplicate = await prisma.automationOccurrence.findUnique({
      where: { idempotencyKey },
      include: { runs: true },
    });
    if (duplicate) return { occurrence: duplicate, duplicate: true };
    const occurrence = await createNoWorkOccurrence({
      ...input,
      definitionId: definition.id,
      idempotencyKey,
      code: "WORK_ALREADY_CLAIMED",
    });
    return { occurrence, duplicate: false };
  }
}

export async function createAutomationDefinition(input: {
  repoId: bigint;
  template: typeof AUTOMATION_TEMPLATE_KEY;
  agentKind: AutomationAgentKind;
  cadence: AutomationCadence;
  approvalPolicy: AutomationApprovalPolicy;
  budgetCeilingMicros: number;
  model?: string;
  maxAttempts: number;
  actor: string;
  idempotencyKey: string;
}) {
  if (input.approvalPolicy === "READY_PR" && !mutationCapabilityBrokerEnforced()) {
    throw new ControlPlaneError(
      "신뢰된 mutation capability broker가 강제되기 전에는 READY_PR routine을 만들 수 없습니다.",
      503,
      "MUTATION_CAPABILITY_BROKER_REQUIRED",
    );
  }
  const mutationRequest = {
    repoId: input.repoId.toString(),
    template: input.template,
    agentKind: input.agentKind,
    cadence: input.cadence,
    approvalPolicy: input.approvalPolicy,
    budgetCeilingMicros: input.budgetCeilingMicros,
    model: input.model ?? null,
    maxAttempts: input.maxAttempts,
  } satisfies JsonValue;
  const mutationIdentity = {
    requestId: input.idempotencyKey,
    actor: input.actor,
    operation: "CREATE",
    targetKey: `repo:${input.repoId.toString()}:${input.template}:${input.agentKind}:${input.cadence}`,
    request: mutationRequest,
  } as const;
  const mutation = await beginAutomationMutation(mutationIdentity);
  if (mutation.replay) {
    const replay = mutation.replay as { definition?: { id?: string } };
    const definitionId = replay.definition?.id;
    const definition = definitionId
      ? await prisma.automationDefinition.findUnique({ where: { id: definitionId } })
      : null;
    if (!definition) {
      throw new ControlPlaneError("완료된 routine 생성 원장의 대상을 찾을 수 없습니다.", 409, "MUTATION_TARGET_MISSING");
    }
    return { definition, duplicate: true };
  }
  const app = await prisma.app.findUnique({
    where: { repoId: input.repoId },
    select: { id: true, repoFullName: true, status: true },
  });
  if (!app || app.status !== "ACTIVE") {
    throw new ControlPlaneError("ACTIVE managed app을 찾을 수 없습니다.", 404, "APP_NOT_MANAGED");
  }
  const key = definitionKey({
    appId: app.id,
    template: input.template,
    agentKind: input.agentKind,
    cadence: input.cadence,
  });
  const existing = await prisma.automationDefinition.findUnique({ where: { key } });
  const schedule = scheduleForCadence(input.cadence);
  const configuration = automationPolicy({
    approvalPolicy: input.approvalPolicy,
    budgetCeilingMicros: input.budgetCeilingMicros,
  });
  const complete = async (definition: NonNullable<typeof existing>, duplicate: boolean) => {
    const sealed = await completeAutomationMutation({
      ...mutationIdentity,
      requestHash: mutation.requestHash,
      response: { definition, duplicate },
      audit: {
        action: "automation.create",
        entityType: "AutomationDefinition",
        entityId: definition.id,
        payload: mutationRequest,
      },
    });
    const sealedDuplicate = Boolean((sealed as { duplicate?: unknown }).duplicate);
    return { definition, duplicate: sealedDuplicate };
  };
  if (existing) {
    const existingPolicy = parseManagedAutomationPolicy(existing.configuration);
    if (
      existing.appId !== app.id
      || existing.template !== input.template
      || existing.agentKind !== input.agentKind
      || existing.schedule !== schedule
      || existing.model !== (input.model ?? null)
      || existing.maxAttempts !== input.maxAttempts
      || !existingPolicy
      || canonicalJson(existingPolicy) !== canonicalJson(configuration)
    ) {
      throw new ControlPlaneError("같은 routine key가 다른 설정으로 이미 존재합니다.", 409, "DEFINITION_CONFLICT");
    }
    return complete(existing, true);
  }
  try {
    const definition = await prisma.automationDefinition.create({
      data: {
        key,
        appId: app.id,
        template: input.template,
        schedule,
        agentKind: input.agentKind,
        model: input.model,
        configuration,
        maxAttempts: input.maxAttempts,
      },
    });
    return complete(definition, false);
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const concurrent = await prisma.automationDefinition.findUnique({ where: { key } });
    if (!concurrent) throw error;
    const concurrentPolicy = parseManagedAutomationPolicy(concurrent.configuration);
    if (
      concurrent.appId !== app.id
      || concurrent.template !== input.template
      || concurrent.agentKind !== input.agentKind
      || concurrent.schedule !== schedule
      || concurrent.model !== (input.model ?? null)
      || concurrent.maxAttempts !== input.maxAttempts
      || !concurrentPolicy
      || canonicalJson(concurrentPolicy) !== canonicalJson(configuration)
    ) {
      throw new ControlPlaneError("같은 routine key가 다른 설정으로 동시에 생성되었습니다.", 409, "DEFINITION_CONFLICT");
    }
    return complete(concurrent, true);
  }
}

async function loadDefinition(definitionId: string) {
  const definition = await prisma.automationDefinition.findUnique({
    where: { id: definitionId },
    include: { app: { select: { repoFullName: true, status: true } } },
  });
  if (!definition) throw new ControlPlaneError("routine을 찾을 수 없습니다.", 404, "DEFINITION_NOT_FOUND");
  if (!isManagedAutomationDefinition(definition)) {
    throw new ControlPlaneError(
      "legacy 또는 계약 불명 routine은 Fleet 명령으로 제어할 수 없습니다.",
      409,
      "DEFINITION_CONTRACT_UNMANAGED",
    );
  }
  return definition;
}

export async function triggerAutomationNow(input: {
  definitionId: string;
  requestId: string;
  now?: Date;
}) {
  const definition = await loadDefinition(input.definitionId);
  const result = await dispatchDefinition({
    definition,
    triggerKind: "MANUAL",
    triggerKey: input.requestId,
    scheduledFor: input.now ?? new Date(),
  });
  const runId = result.occurrence.runs[0]?.id;
  if (runId) await refreshRunFleetProjection(runId);
  return result;
}

export async function setAutomationPaused(input: {
  definitionId: string;
  paused: boolean;
  requestId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const definition = await loadDefinition(input.definitionId);
  if (definition.cancelledAt) throw new ControlPlaneError("취소된 routine은 재개할 수 없습니다.", 409, "DEFINITION_CANCELLED");
  if (definition.enabled === !input.paused) return { definition, changed: false };
  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.automationDefinition.updateMany({
      where: { id: definition.id, enabled: input.paused },
      data: { enabled: !input.paused, pausedAt: input.paused ? now : null },
    });
    if (changed.count !== 1) return null;
    if (!input.paused && definition.schedule) {
      const triggerKey = `resume:${input.requestId}`;
      await tx.automationOccurrence.create({
        data: {
          definitionId: definition.id,
          scheduledFor: now,
          idempotencyKey: automationIdempotencyKey({
            definitionId: definition.id,
            triggerKind: "SCHEDULE",
            triggerKey,
          }),
          triggerKind: "SCHEDULE",
          triggerKey: `${definition.id}:${triggerKey}`.slice(0, 191),
          status: "COMPLETED",
          result: { code: "RESUMED_AFTER_PAUSE" },
          completedAt: now,
        },
      });
    }
    return tx.automationDefinition.findUniqueOrThrow({ where: { id: definition.id } });
  });
  return { definition: updated ?? await loadDefinition(definition.id), changed: Boolean(updated) };
}

export async function cancelAgentRun(input: { runId: string; actor: string; requestId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const replay = await prisma.agentRunEvent.findUnique({ where: { requestId: input.requestId } });
  if (replay) {
    if (
      replay.runId !== input.runId
      || replay.actor !== input.actor
      || !["cancelled", "cancellation_readback_required"].includes(replay.type)
    ) {
      throw new ControlPlaneError("idempotency key가 다른 cancel에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    const payload = replay.payload as { status?: "CANCELLED" | "READBACK_REQUIRED" } | null;
    return { runId: input.runId, status: payload?.status ?? "CANCELLED", duplicate: true };
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const run = await tx.agentRun.findUnique({ where: { id: input.runId } });
      if (!run) throw new ControlPlaneError("run을 찾을 수 없습니다.", 404, "RUN_NOT_FOUND");
      if (["SUCCEEDED", "CANCELLED"].includes(run.status)) {
        throw new ControlPlaneError("완료된 run은 취소할 수 없습니다.", 409, "RUN_TERMINAL");
      }
      if (run.status === "FAILED" && run.readbackRequestedAt) {
        throw new ControlPlaneError("결과 불명 run은 readback으로 먼저 판정해야 합니다.", 409, "READBACK_REQUIRED");
      }
      await tx.agentLease.updateMany({
        where: { runId: run.id, revokedAt: null },
        data: { revokedAt: now, scopeKey: null },
      });
      const readbackRequired = run.status === "RUNNING" && run.createsPr;
      if (!readbackRequired) await releaseRepoGuard(tx, run.id, now);
      await tx.agentRun.update({
        where: { id: run.id },
        data: readbackRequired
          ? {
            status: "FAILED",
            readbackRequestedAt: now,
            error: "CANCELLED_READBACK_REQUIRED",
          }
          : {
            status: "CANCELLED",
            workKey: null,
            cancelledAt: now,
            completedAt: now,
            error: "CANCELLED_BY_OPERATOR",
          },
      });
      await tx.automationOccurrence.update({
        where: { id: run.occurrenceId },
        data: readbackRequired
          ? { status: "RUNNING", result: { code: "CANCELLED_READBACK_REQUIRED" } }
          : { status: "FAILED", completedAt: now, result: { code: "CANCELLED" } },
      });
      await tx.agentRunEvent.create({
        data: {
          requestId: input.requestId,
          runId: run.id,
          type: readbackRequired ? "cancellation_readback_required" : "cancelled",
          actor: input.actor,
          payload: {
            status: readbackRequired ? "READBACK_REQUIRED" : "CANCELLED",
            workKeyReleased: !readbackRequired && run.workKey !== null,
          },
        },
      });
      return {
        runId: run.id,
        status: readbackRequired ? "READBACK_REQUIRED" as const : "CANCELLED" as const,
        duplicate: false,
      };
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    return cancelAgentRun({ ...input, now });
  }
}

export async function retryAgentRun(input: { runId: string; actor: string; requestId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const replay = await prisma.agentRunEvent.findUnique({ where: { requestId: input.requestId } });
  if (replay) {
    if (replay.runId !== input.runId || replay.actor !== input.actor || replay.type !== "manual_retry") {
      throw new ControlPlaneError("idempotency key가 다른 retry에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { runId: input.runId, status: "PENDING" as const, duplicate: true };
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const run = await tx.agentRun.findUnique({
        where: { id: input.runId },
        include: {
          occurrence: { include: { definition: true } },
          repoGuard: { select: { activeScopeKey: true } },
        },
      });
      if (!run) throw new ControlPlaneError("run을 찾을 수 없습니다.", 404, "RUN_NOT_FOUND");
      if (run.readbackRequestedAt || run.repoGuard?.activeScopeKey) {
        throw new ControlPlaneError("결과 불명 run은 worker readback으로 먼저 판정해야 합니다.", 409, "READBACK_REQUIRED");
      }
      if (run.status !== "DEAD_LETTER") {
        throw new ControlPlaneError("dead-letter run만 수동 재시도할 수 있습니다.", 409, "RUN_NOT_RETRYABLE");
      }
      await tx.agentRun.update({
        where: { id: run.id },
        data: {
          status: "PENDING",
          eligibleAt: now,
          completedAt: null,
          error: null,
          maxAttempts: { increment: run.occurrence.definition.maxAttempts },
        },
      });
      await tx.automationOccurrence.update({
        where: { id: run.occurrenceId },
        data: { status: "PENDING", completedAt: null },
      });
      await tx.agentRunEvent.create({
        data: { requestId: input.requestId, runId: run.id, type: "manual_retry", actor: input.actor },
      });
      return { runId: run.id, status: "PENDING" as const, duplicate: false };
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    return retryAgentRun({ ...input, now });
  }
}

export async function executeAutomationCommand(input: {
  definitionId: string;
  command:
    | { command: "PAUSE" }
    | { command: "RESUME" }
    | { command: "RUN_NOW" }
    | { command: "CANCEL_RUN"; runId: string }
    | { command: "RETRY_RUN"; runId: string };
  actor: string;
  requestId: string;
}) {
  const mutationRequest = input.command as unknown as JsonValue;
  const mutationIdentity = {
    requestId: input.requestId,
    actor: input.actor,
    operation: input.command.command,
    targetKey: `definition:${input.definitionId}`,
    request: mutationRequest,
  } as const;
  const mutation = await beginAutomationMutation(mutationIdentity);
  if (mutation.replay) return mutation.replay;
  const definition = await loadDefinition(input.definitionId);
  if ("runId" in input.command) {
    const run = await prisma.agentRun.findUnique({
      where: { id: input.command.runId },
      select: { occurrence: { select: { definitionId: true } } },
    });
    if (run?.occurrence.definitionId !== definition.id) {
      throw new ControlPlaneError("run이 이 routine에 속하지 않습니다.", 409, "RUN_DEFINITION_MISMATCH");
    }
  }
  let result: unknown;
  switch (input.command.command) {
    case "PAUSE":
      result = await setAutomationPaused({ definitionId: definition.id, paused: true, requestId: input.requestId });
      break;
    case "RESUME":
      result = await setAutomationPaused({ definitionId: definition.id, paused: false, requestId: input.requestId });
      break;
    case "RUN_NOW":
      result = await triggerAutomationNow({ definitionId: definition.id, requestId: input.requestId });
      break;
    case "CANCEL_RUN":
      result = await cancelAgentRun({ runId: input.command.runId, actor: input.actor, requestId: input.requestId });
      break;
    case "RETRY_RUN":
      result = await retryAgentRun({ runId: input.command.runId, actor: input.actor, requestId: input.requestId });
      break;
  }
  if ("runId" in input.command) await refreshRunFleetProjection(input.command.runId);
  return completeAutomationMutation({
    ...mutationIdentity,
    requestHash: mutation.requestHash,
    response: result,
    audit: {
      action: `automation.${input.command.command.toLowerCase()}`,
      entityType: "AutomationDefinition",
      entityId: definition.id,
      payload: mutationRequest,
    },
  });
}

async function cancelIneligibleIssueRuns(repoFullName: string, issueNumber: number, now: Date): Promise<void> {
  const runs = await prisma.agentRun.findMany({
    where: {
      repoFullName,
      issueNumber,
      OR: [
        { status: { in: [...CANCELLABLE_RUN_STATUSES] } },
      ],
    },
    select: { id: true },
  });
  for (const run of runs) {
    await cancelAgentRun({
      runId: run.id,
      actor: "scheduler:eligibility",
      requestId: `eligibility:${run.id}:${now.toISOString()}`,
      now,
    });
  }
  const keyedRuns = await prisma.agentRun.findMany({
    where: {
      repoFullName,
      issueNumber,
      workKey: { not: null },
      NOT: { status: "FAILED", readbackRequestedAt: { not: null } },
    },
    select: { id: true },
  });
  for (const run of keyedRuns) {
    await prisma.$transaction(async (tx) => {
      const released = await tx.agentRun.updateMany({
        where: { id: run.id, workKey: { not: null } },
        data: { workKey: null },
      });
      if (released.count === 1) {
        await tx.agentRunEvent.create({
          data: {
            runId: run.id,
            type: "work_key_released_ineligible",
            actor: "scheduler:eligibility",
          },
        });
      }
    });
  }
}

export async function upsertFleetProjectProjection(repoFullName: string, issueNumber: number) {
  const issue = await prisma.issueMirror.findUnique({
    where: { repoFullName_number: { repoFullName, number: issueNumber } },
    include: {
      app: { select: { id: true, slug: true, currentStage: true, projectV2Id: true } },
    },
  });
  if (!issue?.app) return null;
  const run = await prisma.agentRun.findFirst({
    where: { workKey: issueWorkKey(repoFullName, issueNumber) },
    orderBy: { updatedAt: "desc" },
    select: {
      status: true,
      readbackRequestedAt: true,
      occurrence: { select: { definition: { select: { agentKind: true } } } },
    },
  });
  const labels = Array.isArray(issue.labels)
    ? issue.labels.filter((label): label is string => typeof label === "string")
    : [];
  const desired = fleetProjectFields({
    appSlug: issue.app.slug,
    lifecycle: issue.app.currentStage,
    priority: issue.priority,
    labels,
    agentKind: run?.occurrence.definition.agentKind,
    runStatus: run?.readbackRequestedAt ? "READBACK_REQUIRED" : run?.status,
    issueState: issue.state,
  });
  const desiredHash = projectionHash(desired);
  const projectNodeId = issue.app.projectV2Id ?? `UNCONFIGURED:${issue.app.id}`;
  const conflictingBinding = issue.app.projectV2Id
    ? await prisma.app.findFirst({
      where: {
        id: { not: issue.app.id },
        status: "ACTIVE",
        projectV2Id: { not: null, notIn: [issue.app.projectV2Id] },
      },
      select: { id: true },
    })
    : null;
  const bindingError = !issue.app.projectV2Id
    ? "Seorilabs Fleet Project node ID가 필요합니다."
    : conflictingBinding
      ? "ACTIVE managed app의 Project node ID가 단일 Seorilabs Fleet Project로 일치하지 않습니다."
      : null;
  const status = bindingError ? "NEEDS_INPUT" : "PENDING";
  const existing = await prisma.fleetProjectProjection.findUnique({
    where: { projectNodeId_issueNodeId: { projectNodeId, issueNodeId: issue.nodeId } },
  });
  return prisma.fleetProjectProjection.upsert({
    where: { projectNodeId_issueNodeId: { projectNodeId, issueNodeId: issue.nodeId } },
    create: {
      appId: issue.app.id,
      projectNodeId,
      issueNodeId: issue.nodeId,
      repoFullName,
      issueNumber,
      desired,
      desiredHash,
      status,
      lastError: bindingError,
    },
    update: bindingError
      ? { repoFullName, issueNumber, desired, desiredHash, status, lastError: bindingError }
      : existing?.desiredHash === desiredHash
        ? {
          repoFullName,
          issueNumber,
          ...(existing.status === "NEEDS_INPUT" ? { status: "PENDING", lastError: null } : {}),
        }
        : { desired, desiredHash, status, observed: Prisma.DbNull, lastError: null, appliedAt: null },
  });
}

export async function refreshRunFleetProjection(runId: string): Promise<void> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { repoFullName: true, issueNumber: true },
  });
  if (run?.issueNumber) await upsertFleetProjectProjection(run.repoFullName, run.issueNumber);
}

async function processIngressEvent(event: {
  id: string;
  sourceKey: string;
  event: string;
  action: string | null;
  repoFullName: string;
  issueNumber: number | null;
  issueNodeId: string | null;
  payload: Prisma.JsonValue | null;
  payloadHash: string | null;
  occurredAt: Date;
  attempts: number;
}, now: Date, assertClaim: () => Promise<void>): Promise<void> {
  if (event.event === "push") {
    const tag = parseDurableStableTagPush({
      payload: event.payload,
      payloadHash: event.payloadHash,
      sourceKey: event.sourceKey,
      event: event.event,
      action: event.action,
      repoFullName: event.repoFullName,
    });
    const { shouldBackofficeAutoPublishReleaseNotes } = await import("@/lib/core/release-ownership");
    const { env } = await import("@/lib/env");
    if (!shouldBackofficeAutoPublishReleaseNotes(event.repoFullName, env.githubOrg())) return;
    await assertClaim();
    const { resolveRefSha } = await import("@/lib/github/write");
    const currentSha = await resolveRefSha(event.repoFullName, tag.version);
    if (currentSha.toLowerCase() !== tag.headSha.toLowerCase()) {
      throw new Error("provider tag SHA does not match durable observation");
    }
    const { generateAndPublishReleaseNotes } = await import("@/lib/core/release-ops");
    await generateAndPublishReleaseNotes({
      repoFullName: event.repoFullName,
      version: tag.version,
      headSha: tag.headSha,
    }, {
      assertOwnership: assertClaim,
    });
    return;
  }
  if (event.event !== "issues") throw new Error("unsupported automation inbox event");
  if (!event.issueNumber) throw new Error("issueNumber missing");
  const durableObservation = parseDurableIssueObservation({
    payload: event.payload,
    payloadHash: event.payloadHash,
    sourceKey: event.sourceKey,
    event: event.event,
    action: event.action,
    repoFullName: event.repoFullName,
  });
  const [owner, repo, ...rest] = event.repoFullName.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error("invalid inbox repoFullName");
  const { getInstallationOctokit } = await import("@/lib/github/app");
  const response = await (await getInstallationOctokit()).rest.issues.get({
    owner,
    repo,
    issue_number: event.issueNumber,
  });
  const observation = durableIssueObservation(response.data as unknown as GhIssueInput);
  if (
    durableObservation
    && new Date(observation.updatedAt) < new Date(durableObservation.updatedAt)
  ) {
    throw new Error("provider issue readback is older than durable observation");
  }
  if (
    observation.number !== event.issueNumber
    || (event.issueNodeId && observation.nodeId !== event.issueNodeId)
  ) {
    throw new Error("automation inbox issue identity mismatch");
  }
  const { upsertIssue } = await import("@/lib/sync/mirror");
  await upsertIssue(event.repoFullName, durableIssueToMirrorInput(observation));
  const issue = await prisma.issueMirror.findUnique({
    where: { repoFullName_number: { repoFullName: event.repoFullName, number: event.issueNumber } },
  });
  if (
    !issue
    || issue.nodeId !== observation.nodeId
    || issue.ghUpdatedAt < new Date(observation.updatedAt)
  ) {
    throw new Error("issue mirror did not converge to inbox observation");
  }
  await upsertFleetProjectProjection(event.repoFullName, event.issueNumber);
  const eligible = eligibleForAutopilot({
    issueNumber: issue.number,
    issueState: issue.state,
    labels: issue.labels,
  });
  if (!eligible) {
    await cancelIneligibleIssueRuns(event.repoFullName, event.issueNumber, now);
    await upsertFleetProjectProjection(event.repoFullName, event.issueNumber);
    return;
  }
  if (!ISSUE_TRIGGER_ACTIONS.has(event.action ?? "")) return;
  const definitions = await prisma.automationDefinition.findMany({
    where: {
      appId: issue.appId,
      enabled: true,
      cancelledAt: null,
      template: AUTOMATION_TEMPLATE_KEY,
      agentKind: { in: ["CODEX", "CLAUDE"] },
      configuration: { not: Prisma.DbNull },
    },
    include: { app: { select: { repoFullName: true, status: true } } },
    orderBy: { key: "asc" },
  });
  for (const definition of definitions) {
    await dispatchDefinition({
      definition,
      triggerKind: "WEBHOOK",
      triggerKey: event.sourceKey,
      scheduledFor: event.occurredAt,
      issueNumber: event.issueNumber,
    });
  }
  await upsertFleetProjectProjection(event.repoFullName, event.issueNumber);
}

export async function drainAutomationIngress(input: {
  now?: Date;
  limit?: number;
  sourceKey?: string;
} = {}) {
  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - 5 * 60_000);
  const events = await prisma.automationIngressEvent.findMany({
    where: {
      ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}),
      OR: [
        { status: { in: ["PENDING", "FAILED"] }, eligibleAt: { lte: now } },
        { status: "PROCESSING", updatedAt: { lte: staleBefore } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(input.limit ?? 100, 500)),
  });
  let processed = 0;
  let failed = 0;
  let deadLetter = 0;
  for (const event of events) {
    const claimGeneration = event.attempts + 1;
    const claimed = await prisma.automationIngressEvent.updateMany({
      where: { id: event.id, status: event.status, attempts: event.attempts },
      data: { status: "PROCESSING", attempts: { increment: 1 }, error: null },
    });
    if (claimed.count !== 1) continue;
    const assertClaim = async () => {
      const alive = await prisma.automationIngressEvent.updateMany({
        where: { id: event.id, status: "PROCESSING", attempts: claimGeneration },
        data: { updatedAt: new Date() },
      });
      if (alive.count !== 1) throw new Error("automation inbox claim lost");
    };
    let heartbeatError: unknown = null;
    let heartbeatChain: Promise<void> = Promise.resolve();
    const heartbeat = setInterval(() => {
      heartbeatChain = heartbeatChain
        .then(assertClaim)
        .catch((error: unknown) => { heartbeatError = error; });
    }, 60_000);
    heartbeat.unref();
    let processingError: unknown = null;
    try {
      await processIngressEvent(event, now, assertClaim);
    } catch (error) {
      processingError = error;
    } finally {
      clearInterval(heartbeat);
      await heartbeatChain;
    }
    if (!processingError && heartbeatError) processingError = heartbeatError;
    if (!processingError) {
      try {
        await assertClaim();
      } catch (error) {
        processingError = error;
      }
    }
    if (!processingError) {
      const completed = await prisma.automationIngressEvent.updateMany({
        where: { id: event.id, status: "PROCESSING", attempts: claimGeneration },
        data: { status: "PROCESSED", processedAt: now },
      });
      processed += completed.count;
      continue;
    }
    const terminal = claimGeneration >= 5;
    const failedUpdate = await prisma.automationIngressEvent.updateMany({
        where: { id: event.id, status: "PROCESSING", attempts: claimGeneration },
        data: {
          status: terminal ? "DEAD_LETTER" : "FAILED",
          eligibleAt: new Date(now.getTime() + retryDelay(claimGeneration)),
          error: processingError instanceof Error ? processingError.message.slice(0, 1_000) : "ingress failed",
        },
      });
    if (failedUpdate.count === 1) {
      if (terminal) deadLetter += 1;
      else failed += 1;
    }
  }
  return { scanned: events.length, processed, failed, deadLetter };
}

export async function scheduleDueAutomations(input: { now?: Date; perDefinitionLimit?: number } = {}) {
  const now = input.now ?? new Date();
  const definitions = await prisma.automationDefinition.findMany({
    where: {
      enabled: true,
      cancelledAt: null,
      schedule: { not: null },
      template: AUTOMATION_TEMPLATE_KEY,
      agentKind: { in: ["CODEX", "CLAUDE"] },
      configuration: { not: Prisma.DbNull },
      app: { status: "ACTIVE" },
    },
    include: {
      app: { select: { repoFullName: true, status: true } },
      occurrences: {
        where: { triggerKind: "SCHEDULE" },
        orderBy: { scheduledFor: "desc" },
        take: 1,
        select: { scheduledFor: true },
      },
    },
  });
  let created = 0;
  let duplicate = 0;
  let unsupported = 0;
  for (const definition of definitions) {
    const cadence = cadenceForSchedule(definition.schedule);
    if (!cadence) {
      unsupported += 1;
      continue;
    }
    const slots = dueScheduleSlots({
      cadence,
      createdAt: definition.createdAt,
      lastScheduledFor: definition.occurrences[0]?.scheduledFor ?? null,
      now,
      limit: input.perDefinitionLimit,
    });
    for (const slot of slots) {
      const result = await dispatchDefinition({
        definition,
        triggerKind: "SCHEDULE",
        triggerKey: slot.toISOString(),
        scheduledFor: slot,
      });
      const runId = result.occurrence.runs[0]?.id;
      if (runId) await refreshRunFleetProjection(runId);
      if (result.duplicate) duplicate += 1;
      else created += 1;
    }
  }
  return { definitions: definitions.length, created, duplicate, unsupported };
}

export async function reconcileAutomationScheduler(input: { now?: Date } = {}) {
  const now = input.now ?? new Date();
  const [ingress, schedule, repoGuards] = await Promise.all([
    drainAutomationIngress({ now }),
    scheduleDueAutomations({ now }),
    reconcileTerminalRepoGuards({ now }),
  ]);
  return { ingress, schedule, repoGuards };
}
