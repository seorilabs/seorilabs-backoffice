import crypto from "node:crypto";
import { Prisma, type FleetProjectProjection } from "@prisma/client";

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
  reconcileTerminalRepoGuards,
  releaseRepoGuard,
} from "@/lib/control-plane/agent-queue";
import {
  parseSourceRemediationPolicy,
  SOURCE_REMEDIATION_TEMPLATE_KEY,
} from "@/lib/control-plane/automation-catalog";
import { templateRepositoryAutomationEligible } from "@/lib/control-plane/source-remediation";
import { canonicalJson, type JsonValue } from "@/lib/control-plane/json";
import {
  durableIssueObservation,
  durableIngressEnvelopeHash,
  durableIssueToMirrorInput,
  parseDurableIssueObservation,
  parseDurableRepositoryDiscovery,
  parseDurableStableTagPush,
  type DurableIssueObservation,
  type DurableRepositoryDiscovery,
  type DurableStableTagPush,
} from "@/lib/control-plane/automation-inbox";
import {
  beginAutomationMutation,
  completeAutomationMutation,
} from "@/lib/control-plane/automation-mutation";
import {
  FLEET_PROJECT_UNCONFIGURED_ID,
  resolveFleetProjectSource,
} from "@/lib/control-plane/fleet-project-binding";
import { ControlPlaneError } from "@/lib/control-plane/service";
import {
  invalidateRepositoryDiscoveryInTransaction,
  repositoryAutomationEligible,
  type RegisterRepositoryWebhookInput,
} from "@/lib/control-plane/repository-registration";
import { prisma } from "@/lib/prisma";
import { trustedMutationAdapterConfigured } from "@/lib/control-plane/security";
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

const repositoryAutomationSelect = {
  archived: true,
  status: true,
  managementKind: true,
  classification: true,
  lastDefaultPushSha: true,
  lastReconciledSha: true,
  // 단발 source-remediation run의 retry는 정의가 잠근 generation/reason까지 대조한다.
  reconcileGeneration: true,
  lastDiscoveryReason: true,
} as const;

async function assertRepositoryAutomationManaged(repoFullName: string): Promise<void> {
  const registration = await prisma.repositoryRegistration.findUnique({
    where: { repoFullName },
    select: repositoryAutomationSelect,
  });
  if (!repositoryAutomationEligible(registration)) {
    throw new ControlPlaneError(
      "현재 source가 재조정된 MANAGED repository만 Fleet automation을 실행할 수 있습니다.",
      409,
      "REPOSITORY_NOT_MANAGED",
    );
  }
}

function repositoryDiscoveryRegistrationInput(
  discovery: DurableRepositoryDiscovery,
  deliveryId: string,
) {
  return {
    event: discovery.event,
    action: discovery.action ?? undefined,
    repository: {
      id: discovery.repository.id,
      full_name: discovery.repository.fullName,
      name: discovery.repository.name ?? undefined,
      default_branch: discovery.repository.defaultBranch,
      archived: discovery.repository.archived,
      private: discovery.repository.private,
    },
    ref: discovery.ref ?? undefined,
    after: discovery.after ?? undefined,
    deliveryId,
    organization: discovery.organization,
  };
}

type RepositoryDiscoveryReadback = (
  discovery: DurableRepositoryDiscovery,
  sourceKey: string,
) => Promise<RegisterRepositoryWebhookInput>;

const defaultRepositoryDiscoveryReadback: RepositoryDiscoveryReadback = async (
  discovery,
  sourceKey,
) => {
  const [observedOwner, observedRepo, ...observedRest] = discovery.repository.fullName.split("/");
  if (!observedOwner || !observedRepo || observedRest.length > 0) {
    throw new Error("invalid repository discovery identity");
  }
  const { getInstallationOctokit } = await import("@/lib/github/app");
  const octokit = await getInstallationOctokit();
  let repository: {
    id?: unknown;
    full_name?: unknown;
    name?: unknown;
    default_branch?: unknown;
    archived?: unknown;
    private?: unknown;
  };
  try {
    repository = (await octokit.rest.repos.get({ owner: observedOwner, repo: observedRepo })).data;
  } catch (error) {
    if ((error as { status?: number }).status !== 404 || discovery.action !== "deleted") throw error;
    repository = {
      id: discovery.repository.id,
      full_name: discovery.repository.fullName,
      name: discovery.repository.name,
      default_branch: discovery.repository.defaultBranch,
      archived: true,
      private: discovery.repository.private,
    };
  }
  if (
    repository.id !== discovery.repository.id
    || typeof repository.full_name !== "string"
    || !repository.full_name.startsWith(`${discovery.organization}/`)
    || typeof repository.archived !== "boolean"
    || typeof repository.private !== "boolean"
    || (repository.name !== undefined && repository.name !== null && typeof repository.name !== "string")
    || (
      repository.default_branch !== undefined
      && repository.default_branch !== null
      && typeof repository.default_branch !== "string"
    )
  ) {
    throw new Error("repository discovery provider identity mismatch");
  }
  const [owner, repo, ...rest] = repository.full_name.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error("invalid repository discovery provider identity");

  let headSha: string | undefined;
  const defaultBranch = typeof repository.default_branch === "string"
    ? repository.default_branch
    : null;
  if (!repository.archived && defaultBranch) {
    try {
      const commit = (await octokit.rest.repos.getCommit({ owner, repo, ref: defaultBranch })).data;
      if (typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/i.test(commit.sha)) {
        throw new Error("repository discovery provider HEAD invalid");
      }
      headSha = commit.sha.toLowerCase();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 404 && status !== 409) throw error;
    }
  }
  const readbackVector = {
    sourceKey,
    repoId: discovery.repository.id,
    repoFullName: repository.full_name,
    defaultBranch,
    archived: repository.archived,
    private: repository.private,
    headSha: headSha ?? null,
  } as JsonValue;
  return {
    event: "reconcile",
    action: "provider-readback",
    repository: {
      id: discovery.repository.id,
      full_name: repository.full_name,
      name: typeof repository.name === "string" ? repository.name : repo,
      default_branch: defaultBranch,
      archived: repository.archived,
      private: repository.private,
    },
    after: headSha,
    deliveryId: `provider-readback:${projectionHash(readbackVector)}`,
    organization: discovery.organization,
  };
};

type AutomationIngressDependencies = {
  repositoryDiscoveryReadback: RepositoryDiscoveryReadback;
  issueReadback?: (repoFullName: string, issueNumber: number) => Promise<GhIssueInput>;
  issueMirrorWrite?: (repoFullName: string, issue: GhIssueInput) => Promise<void>;
};

const defaultIssueReadback = async (
  repoFullName: string,
  issueNumber: number,
): Promise<GhIssueInput> => {
  const [owner, repo, ...rest] = repoFullName.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error("invalid inbox repoFullName");
  const { getInstallationOctokit } = await import("@/lib/github/app");
  const response = await (await getInstallationOctokit()).rest.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });
  return response.data as unknown as GhIssueInput;
};

const defaultIssueMirrorWrite = async (
  repoFullName: string,
  issue: GhIssueInput,
): Promise<void> => {
  const { upsertIssue } = await import("@/lib/sync/mirror");
  await upsertIssue(repoFullName, issue);
};

const defaultAutomationIngressDependencies: AutomationIngressDependencies = {
  repositoryDiscoveryReadback: defaultRepositoryDiscoveryReadback,
  issueReadback: defaultIssueReadback,
  issueMirrorWrite: defaultIssueMirrorWrite,
};

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
  repositoryDiscovery?: DurableRepositoryDiscovery | null;
}): Promise<{ duplicate: boolean }> {
  const sourceKey = `github:${input.deliveryId}`;
  const action = input.action ?? null;
  const payloads = [input.issue, input.stableTagPush, input.repositoryDiscovery]
    .filter((payload): payload is DurableIssueObservation | DurableStableTagPush | DurableRepositoryDiscovery => Boolean(payload));
  if (payloads.length > 1) throw new Error("webhook delivery has multiple durable payloads");
  const durablePayload = payloads[0] ?? null;
  const shouldEnqueue = Boolean(
    input.repoFullName
    && (
      (input.event === "issues" && input.issueNumber && input.issueNodeId && input.issue)
      || (input.event === "push" && input.stableTagPush)
      || ((input.event === "push" || input.event === "repository") && input.repositoryDiscovery)
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
  const occurredAt = input.occurredAt ?? new Date();
  return prisma.$transaction(async (tx) => {
    const inserted = await tx.webhookDelivery.createMany({
      data: [{ deliveryId: input.deliveryId, event: input.event, action }],
      skipDuplicates: true,
    });
    const ingressInserted = shouldEnqueue && input.repoFullName && durablePayload
      ? await tx.automationIngressEvent.createMany({
        data: [{
          sourceKey,
          event: input.event,
          action,
          repoFullName: input.repoFullName,
          issueNumber: input.issueNumber,
          issueNodeId: input.issueNodeId,
          payload: durablePayload as Prisma.InputJsonValue,
          payloadHash,
          occurredAt,
        }],
        skipDuplicates: true,
      })
      : { count: 0 };
    if (input.repositoryDiscovery && (inserted.count === 1 || ingressInserted.count === 1)) {
      await invalidateRepositoryDiscoveryInTransaction(
        repositoryDiscoveryRegistrationInput(input.repositoryDiscovery, input.deliveryId),
        tx,
        occurredAt,
      );
    }
    const delivery = await tx.webhookDelivery.findUnique({ where: { deliveryId: input.deliveryId } });
    if (!delivery) throw new Error("webhook delivery row missing after durable write");
    if (delivery.event !== input.event || delivery.action !== action) {
      throw new ControlPlaneError("같은 delivery ID가 다른 webhook에 사용되었습니다.", 409, "WEBHOOK_DELIVERY_CONFLICT");
    }
    if (shouldEnqueue && input.repoFullName && durablePayload && payloadHash) {
      const ingress = await tx.automationIngressEvent.findUnique({ where: { sourceKey } });
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
    return { duplicate: inserted.count === 0 };
  });
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
  await assertRepositoryAutomationManaged(definition.app.repoFullName);
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
  if (input.approvalPolicy === "READY_PR" && !trustedMutationAdapterConfigured()) {
    throw new ControlPlaneError(
      "신뢰된 seori-auth mutation adapter identity가 준비되기 전에는 READY_PR routine을 만들 수 없습니다.",
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
  await assertRepositoryAutomationManaged(app.repoFullName);
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

/**
 * PAUSE/RESUME/RUN_NOW는 cadence가 있는 repo-task-autopilot-v1 정의에만 의미가 있어 기존 gate를 그대로 둔다.
 * CANCEL_RUN/RETRY_RUN은 run 범위 명령이라 단발 source-remediation 정의에도 허용한다. 이 template은
 * 정의를 두 번 만들 수 없고(DEFINITION_CONFLICT) dead-letter run이 workKey를 계속 잡고 있어
 * (SOURCE_REMEDIATION_WORK_ALREADY_CLAIMED) 이 경로가 없으면 P7 catch-22가 영구화된다.
 */
const RUN_SCOPED_AUTOMATION_COMMANDS = new Set(["CANCEL_RUN", "RETRY_RUN"]);

async function loadDefinition(definitionId: string, command?: string) {
  const definition = await prisma.automationDefinition.findUnique({
    where: { id: definitionId },
    include: { app: { select: { repoFullName: true, status: true } } },
  });
  if (!definition) throw new ControlPlaneError("routine을 찾을 수 없습니다.", 404, "DEFINITION_NOT_FOUND");
  const runScopedSourceRemediation = command !== undefined
    && RUN_SCOPED_AUTOMATION_COMMANDS.has(command)
    && definition.template === SOURCE_REMEDIATION_TEMPLATE_KEY
    && parseSourceRemediationPolicy(definition.configuration) !== null;
  if (!isManagedAutomationDefinition(definition) && !runScopedSourceRemediation) {
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
  if (!input.paused && definition.app) {
    await assertRepositoryAutomationManaged(definition.app.repoFullName);
  }
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

export async function cancelAgentRun(input: {
  runId: string;
  actor: string;
  requestId: string;
  now?: Date;
  retryAttempt?: number;
}) {
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
      await tx.agentWorkerSession.updateMany({
        where: { runId: run.id, revokedAt: null },
        data: { revokedAt: now, expiresAt: now },
      });
      const mutationStarted = run.status === "RUNNING" && Boolean(await tx.agentMutationExecution.findFirst({
        where: { runId: run.id, generation: run.leaseGeneration, status: { not: "NOT_APPLIED" } },
        select: { id: true },
      }));
      const readbackRequired = mutationStarted;
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
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError)
      || error.code !== "P2002"
      || (input.retryAttempt ?? 0) >= 2
    ) throw error;
    return cancelAgentRun({ ...input, now, retryAttempt: (input.retryAttempt ?? 0) + 1 });
  }
}

export async function retryAgentRun(input: {
  runId: string;
  actor: string;
  requestId: string;
  now?: Date;
  retryAttempt?: number;
}) {
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
      const registration = await tx.repositoryRegistration.findUnique({
        where: { repoFullName: run.repoFullName },
        select: repositoryAutomationSelect,
      });
      // claim(tryClaimRun)과 정확히 같은 template 분기를 쓴다. source-remediation은 정의가 잠근
      // generation/source SHA/reason이 지금도 같을 때만 통과하므로 재시도가 gate를 넓히지 않는다.
      if (!templateRepositoryAutomationEligible({
        template: run.occurrence.definition.template,
        configuration: run.occurrence.definition.configuration,
        registration,
      })) {
        throw new ControlPlaneError(
          "현재 source가 재조정되지 않은 repository의 run은 재시도할 수 없습니다.",
          409,
          "REPOSITORY_NOT_MANAGED",
        );
      }
      if (run.occurrence.definition.template === SOURCE_REMEDIATION_TEMPLATE_KEY) {
        const app = run.appId
          ? await tx.app.findUnique({ where: { id: run.appId }, select: { status: true } })
          : null;
        if (!app || app.status !== "ACTIVE") {
          throw new ControlPlaneError(
            "ACTIVE App에 결합된 source-remediation run만 재시도할 수 있습니다.",
            409,
            "APP_NOT_ELIGIBLE",
          );
        }
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
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError)
      || error.code !== "P2002"
      || (input.retryAttempt ?? 0) >= 2
    ) throw error;
    return retryAgentRun({ ...input, now, retryAttempt: (input.retryAttempt ?? 0) + 1 });
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
  const definition = await loadDefinition(input.definitionId, input.command.command);
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
  // 모든 eligible issue는 앱별 ID가 아닌 조직 단일 Seorilabs Fleet Project resolver를 공유한다.
  const issue = await prisma.issueMirror.findUnique({
    where: { repoFullName_number: { repoFullName, number: issueNumber } },
    include: {
      app: {
        select: {
          id: true,
          slug: true,
          currentStage: true,
          status: true,
          repoId: true,
          repoFullName: true,
        },
      },
    },
  });
  if (!issue?.app) return null;
  const source = await resolveFleetProjectSource(issue.app);
  if (source.kind === "INELIGIBLE") {
    await prisma.fleetProjectProjection.updateMany({
      where: { issueNodeId: issue.nodeId, status: { not: "SUPERSEDED" } },
      data: { status: "SUPERSEDED", lastError: source.reason },
    });
    return null;
  }
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
  const projectNodeId = source.kind === "CURRENT"
    ? source.projectNodeId
    : FLEET_PROJECT_UNCONFIGURED_ID;
  const bindingRevision = source.kind === "CURRENT" ? source.bindingRevision : null;
  const bindingError = source.kind === "CURRENT" ? null : source.reason;
  const status = source.kind === "CURRENT"
    ? "PENDING"
    : source.kind === "READBACK_REQUIRED"
      ? "READBACK_REQUIRED"
      : "NEEDS_INPUT";
  const existing = await prisma.fleetProjectProjection.findUnique({
    where: { projectNodeId_issueNodeId: { projectNodeId, issueNodeId: issue.nodeId } },
  });
  const update = bindingError
    ? {
      repoFullName,
      issueNumber,
      bindingRevision,
      desired,
      desiredHash,
      status,
      lastError: bindingError,
    }
    : existing?.desiredHash === desiredHash
      ? {
        repoFullName,
        issueNumber,
        bindingRevision,
        ...(["NEEDS_INPUT", "READBACK_REQUIRED", "SUPERSEDED"].includes(existing.status)
          ? { status: "PENDING", lastError: null }
          : {}),
      }
      : {
        bindingRevision,
        desired,
        desiredHash,
        status,
        observed: Prisma.DbNull,
        lastError: null,
        appliedAt: null,
      };
  const where = { projectNodeId_issueNodeId: { projectNodeId, issueNodeId: issue.nodeId } };
  let projection: FleetProjectProjection;
  try {
    projection = await prisma.fleetProjectProjection.upsert({
      where,
      create: {
        appId: issue.app.id,
        projectNodeId,
        bindingRevision,
        issueNodeId: issue.nodeId,
        repoFullName,
        issueNumber,
        desired,
        desiredHash,
        status,
        lastError: bindingError,
      },
      update,
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    // MySQL의 emulated upsert는 동시 최초 생성에서 unique race가 날 수 있다.
    // 이미 만들어진 동일 projection을 같은 desired state로 수렴시킨다.
    projection = await prisma.fleetProjectProjection.update({ where, data: update });
  }
  await prisma.fleetProjectProjection.updateMany({
    where: {
      issueNodeId: issue.nodeId,
      id: { not: projection.id },
      status: { not: "SUPERSEDED" },
    },
    data: {
      status: "SUPERSEDED",
      lastError: "조직 Fleet Project binding revision과 일치하는 projection으로 대체되었습니다.",
    },
  });
  return projection;
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
}, now: Date, assertClaim: () => Promise<void>, dependencies: AutomationIngressDependencies): Promise<void> {
  if ((event.payload as { kind?: unknown } | null)?.kind === "REPOSITORY_DISCOVERY") {
    const discovery = parseDurableRepositoryDiscovery({
      payload: event.payload,
      payloadHash: event.payloadHash,
      sourceKey: event.sourceKey,
      event: event.event,
      action: event.action,
      repoFullName: event.repoFullName,
    });
    await assertClaim();
    const registrationInput = await dependencies.repositoryDiscoveryReadback(discovery, event.sourceKey);
    await assertClaim();
    const { registerRepositoryWebhook } = await import("@/lib/control-plane/repository-registration");
    await registerRepositoryWebhook(registrationInput);
    return;
  }
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
    const { resolveStableTagSha } = await import("@/lib/github/release");
    const currentSha = await resolveStableTagSha(event.repoFullName, tag.version);
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
  const readIssue = dependencies.issueReadback ?? defaultIssueReadback;
  const observation = durableIssueObservation(
    await readIssue(event.repoFullName, event.issueNumber),
  );
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
  const writeIssueMirror = dependencies.issueMirrorWrite ?? defaultIssueMirrorWrite;
  await writeIssueMirror(
    event.repoFullName,
    durableIssueToMirrorInput(observation),
  );
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
} = {}, dependencies: AutomationIngressDependencies = defaultAutomationIngressDependencies) {
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
      await processIngressEvent(event, now, assertClaim, dependencies);
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
  let blocked = 0;
  const registrations = await prisma.repositoryRegistration.findMany({
    where: { repoFullName: { in: definitions.flatMap((definition) => definition.app ? [definition.app.repoFullName] : []) } },
    select: { repoFullName: true, ...repositoryAutomationSelect },
  });
  const registrationByRepo = new Map(
    registrations.map((registration) => [registration.repoFullName.toLowerCase(), registration]),
  );
  for (const definition of definitions) {
    if (
      !definition.app
      || !repositoryAutomationEligible(registrationByRepo.get(definition.app.repoFullName.toLowerCase()) ?? null)
    ) {
      blocked += 1;
      continue;
    }
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
  return { definitions: definitions.length, created, duplicate, unsupported, blocked };
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
