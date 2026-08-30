import { Prisma } from "@prisma/client";

import {
  beginAutomationMutation,
  completeAutomationMutation,
} from "@/lib/control-plane/automation-mutation";
import {
  createFleetStandardLabelGithubAdapter,
  type FleetStandardLabelApplyReceipt,
  type FleetStandardLabelGithubTransport,
} from "@/lib/control-plane/fleet-standard-label-github-adapter";
import {
  FLEET_STANDARD_LABEL_ACTION,
  FLEET_STANDARD_LABEL_AUTOMATION_TEMPLATE,
  fleetStandardLabelContractSourceConfig,
  fleetStandardLabelDesiredDigest,
  fleetStandardLabelOperation,
  fleetStandardLabelTaskSchema,
  type FleetStandardLabelContract,
  type FleetStandardLabelTask,
} from "@/lib/control-plane/fleet-standard-labels";
import { canonicalJson, jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

const DEFINITION_KEY = "fleet-standard-label-reconcile-v1:deterministic";
const RUN_LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;

export const FLEET_STANDARD_LABEL_AUTOMATION_POLICY = Object.freeze({
  schemaVersion: 1,
  execution: "DETERMINISTIC_TRUSTED_GITHUB_APP",
  actionCapabilities: [FLEET_STANDARD_LABEL_ACTION],
  createsPr: false,
  provider: "github",
} as const);

interface FleetStandardLabelServiceDependencies {
  client: typeof prisma;
  transport: FleetStandardLabelGithubTransport;
  now: () => Date;
}

const defaultDependencies: FleetStandardLabelServiceDependencies = {
  client: prisma,
  transport: createFleetStandardLabelGithubAdapter(),
  now: () => new Date(),
};

type Registration = {
  repoId: bigint;
  repoFullName: string;
  status: "MANAGED" | "NEEDS_INPUT";
  archived: boolean;
  reconcileGeneration: number | null;
};

interface PlanItem {
  runId: string;
  repositoryId: string;
  repositoryFullName: string;
  registrationStatus: "MANAGED" | "NEEDS_INPUT";
  registrationGeneration: number;
  state: "MATCH" | "DRIFT";
  operationIdempotencyKey: string;
  desiredDigest: string;
  readbackDigest: string;
  customLabelsDigest: string;
}

export interface FleetStandardLabelPlanResult {
  mode: "PLAN";
  planId: string;
  planDigest: string;
  duplicate: boolean;
  contract: {
    repositoryId: string;
    repositoryFullName: string;
    sourceSha: string;
    catalogPath: string;
    catalogBlobSha: string;
    catalogVersion: string;
    catalogDigest: string;
    packageExport: string;
  };
  cohortDigest: string;
  cohortCount: number;
  match: number;
  drift: number;
  mutationAttempted: false;
  items: PlanItem[];
}

interface ApplyItem {
  runId: string;
  repositoryId: string;
  repositoryFullName: string;
  generation: number;
  outcome: "VERIFIED" | "REPLAYED" | "BUSY" | "READBACK_FIRST" | "RETRYABLE" | "DEAD_LETTER" | "STALE";
  mutations: number;
  error: string | null;
  receipt: FleetStandardLabelApplyReceipt | null;
}

export interface FleetStandardLabelApplyResult {
  mode: "APPLY";
  planId: string;
  planDigest: string;
  duplicate: boolean;
  state: "completed" | "partial" | "busy";
  verified: number;
  replayed: number;
  busy: number;
  readbackFirst: number;
  retryable: number;
  deadLetter: number;
  stale: number;
  mutationAttempted: boolean;
  items: ApplyItem[];
}

function publicErrorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{7,190}$/u.test(message) ? message : fallback;
}

function contractPublicIdentity(contract: FleetStandardLabelContract) {
  return {
    repositoryId: contract.repositoryId,
    repositoryFullName: contract.repositoryFullName,
    sourceSha: contract.sourceSha,
    catalogPath: contract.catalogPath,
    catalogBlobSha: contract.catalogBlobSha,
    catalogVersion: contract.catalog.catalogVersion,
    catalogDigest: contract.catalogDigest,
    packageExport: contract.packageExport,
  };
}

function definitionPolicyMatches(value: unknown): boolean {
  return canonicalJson(value as JsonValue) === canonicalJson(FLEET_STANDARD_LABEL_AUTOMATION_POLICY as unknown as JsonValue);
}

async function requireAutomationDefinition(
  dependencies: FleetStandardLabelServiceDependencies,
) {
  let definition = await dependencies.client.automationDefinition.findUnique({
    where: { key: DEFINITION_KEY },
  });
  if (!definition) {
    try {
      definition = await dependencies.client.automationDefinition.create({
        data: {
          key: DEFINITION_KEY,
          template: FLEET_STANDARD_LABEL_AUTOMATION_TEMPLATE,
          schedule: null,
          agentKind: null,
          model: null,
          configuration: FLEET_STANDARD_LABEL_AUTOMATION_POLICY,
          enabled: true,
          maxAttempts: MAX_ATTEMPTS,
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      definition = await dependencies.client.automationDefinition.findUnique({ where: { key: DEFINITION_KEY } });
    }
  }
  if (
    !definition
    || definition.template !== FLEET_STANDARD_LABEL_AUTOMATION_TEMPLATE
    || definition.agentKind !== null
    || definition.model !== null
    || definition.schedule !== null
    || !definition.enabled
    || definition.pausedAt !== null
    || definition.cancelledAt !== null
    || definition.maxAttempts !== MAX_ATTEMPTS
    || !definitionPolicyMatches(definition.configuration)
  ) {
    throw new ControlPlaneError(
      "Fleet 표준 label automation definition이 exact 정책과 다릅니다.",
      409,
      "FLEET_STANDARD_LABEL_DEFINITION_MISMATCH",
    );
  }
  return definition;
}

async function listCohort(dependencies: FleetStandardLabelServiceDependencies): Promise<Registration[]> {
  const registrations = await dependencies.client.repositoryRegistration.findMany({
    where: {
      archived: false,
      status: { in: ["MANAGED", "NEEDS_INPUT"] },
    },
    orderBy: [{ repoId: "asc" }],
    select: {
      repoId: true,
      repoFullName: true,
      status: true,
      archived: true,
      reconcileGeneration: true,
    },
  });
  return registrations.map((registration) => {
    if (
      registration.archived
      || (registration.status !== "MANAGED" && registration.status !== "NEEDS_INPUT")
      || !Number.isSafeInteger(registration.reconcileGeneration ?? 0)
      || Number(registration.reconcileGeneration ?? 0) < 0
    ) {
      throw new ControlPlaneError(
        "Fleet 표준 label cohort가 유효하지 않습니다.",
        409,
        "FLEET_STANDARD_LABEL_COHORT_INVALID",
      );
    }
    return registration as Registration;
  });
}

function taskFor(input: {
  contract: FleetStandardLabelContract;
  registration: Registration;
  observation: PlanItemObservation;
}): FleetStandardLabelTask {
  const repositoryId = input.registration.repoId.toString();
  const operation = fleetStandardLabelOperation({
    contract: input.contract,
    repositoryId,
    repositoryFullName: input.registration.repoFullName,
  });
  const taskWithoutDigest = {
    schemaVersion: 1 as const,
    action: FLEET_STANDARD_LABEL_ACTION,
    repositoryId,
    repositoryFullName: input.registration.repoFullName,
    registrationStatus: input.registration.status,
    registrationGeneration: input.registration.reconcileGeneration ?? 0,
    contract: contractPublicIdentity(input.contract),
    operation,
    plannedObservation: input.observation,
  };
  return fleetStandardLabelTaskSchema.parse({
    ...taskWithoutDigest,
    desiredDigest: fleetStandardLabelDesiredDigest(taskWithoutDigest),
  });
}

type PlanItemObservation = FleetStandardLabelTask["plannedObservation"];

function planDigest(input: {
  contract: ReturnType<typeof contractPublicIdentity>;
  cohortDigest: string;
  tasks: readonly FleetStandardLabelTask[];
}): string {
  return `sha256:${jsonDigest({
    schemaVersion: 1,
    action: FLEET_STANDARD_LABEL_ACTION,
    contract: input.contract,
    cohortDigest: input.cohortDigest,
    items: input.tasks.map((task) => ({
      repositoryId: task.repositoryId,
      repositoryFullName: task.repositoryFullName,
      registrationStatus: task.registrationStatus,
      registrationGeneration: task.registrationGeneration,
      operationIdempotencyKey: task.operation.idempotencyKey,
      desiredDigest: task.desiredDigest,
      plannedObservation: task.plannedObservation,
    })),
  } as JsonValue)}`;
}

async function createOrReadPlanOccurrence(input: {
  dependencies: FleetStandardLabelServiceDependencies;
  definitionId: string;
  contract: FleetStandardLabelContract;
  cohortDigest: string;
  tasks: FleetStandardLabelTask[];
  digest: string;
  now: Date;
}) {
  const triggerKey = `fleet-standard-label-plan:${input.digest.slice("sha256:".length)}`;
  const existing = await input.dependencies.client.automationOccurrence.findUnique({
    where: { triggerKey },
    include: { runs: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
  });
  if (existing) return existing;

  const match = input.tasks.filter((task) => task.plannedObservation.state === "MATCH").length;
  const result = {
    schemaVersion: 1,
    action: FLEET_STANDARD_LABEL_ACTION,
    planDigest: input.digest,
    contract: contractPublicIdentity(input.contract),
    cohortDigest: input.cohortDigest,
    cohortCount: input.tasks.length,
    match,
    drift: input.tasks.length - match,
    mutationAttempted: false,
  };
  for (let offset = 0; offset < 10; offset += 1) {
    try {
      return await input.dependencies.client.automationOccurrence.create({
        data: {
          definitionId: input.definitionId,
          scheduledFor: new Date(input.now.getTime() + offset),
          idempotencyKey: jsonDigest({ definitionId: input.definitionId, triggerKey } as JsonValue),
          triggerKind: "CONTROL_PLANE",
          triggerKey,
          status: match === input.tasks.length ? "COMPLETED" : "PENDING",
          result,
          completedAt: match === input.tasks.length ? input.now : null,
          runs: {
            create: input.tasks.map((task, index) => ({
              repoFullName: task.repositoryFullName,
              issueNumber: null,
              workKey: `fleet-standard-label:${input.digest.slice("sha256:".length)}:${task.repositoryId}`,
              issueState: null,
              labels: [],
              taskInput: task,
              createsPr: false,
              priority: index + 1,
              status: task.plannedObservation.state === "MATCH" ? "SUCCEEDED" : "PENDING",
              maxAttempts: MAX_ATTEMPTS,
              completedAt: task.plannedObservation.state === "MATCH" ? input.now : null,
              outcome: task.plannedObservation.state === "MATCH"
                ? {
                    code: "STANDARD_LABELS_ALREADY_MATCH",
                    action: FLEET_STANDARD_LABEL_ACTION,
                    repositoryId: task.repositoryId,
                    catalogDigest: task.contract.catalogDigest,
                    readbackDigest: task.plannedObservation.readbackDigest,
                    mutationAttempted: false,
                  }
                : undefined,
            })),
          },
        },
        include: { runs: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      const replay = await input.dependencies.client.automationOccurrence.findUnique({
        where: { triggerKey },
        include: { runs: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
      });
      if (replay) return replay;
    }
  }
  throw new ControlPlaneError(
    "Fleet 표준 label plan occurrence CAS에 실패했습니다.",
    409,
    "FLEET_STANDARD_LABEL_PLAN_CAS_CONFLICT",
  );
}

function planItemsFromRuns(runs: Array<{
  id: string;
  taskInput: Prisma.JsonValue | null;
}>): PlanItem[] {
  return runs.map((run) => {
    const task = fleetStandardLabelTaskSchema.parse(run.taskInput);
    return {
      runId: run.id,
      repositoryId: task.repositoryId,
      repositoryFullName: task.repositoryFullName,
      registrationStatus: task.registrationStatus,
      registrationGeneration: task.registrationGeneration,
      state: task.plannedObservation.state,
      operationIdempotencyKey: task.operation.idempotencyKey,
      desiredDigest: task.desiredDigest,
      readbackDigest: task.plannedObservation.readbackDigest,
      customLabelsDigest: task.plannedObservation.customLabelsDigest,
    };
  });
}

export async function planFleetStandardLabels(input: {
  actor: string;
  idempotencyKey: string;
}, dependencies: FleetStandardLabelServiceDependencies = defaultDependencies): Promise<FleetStandardLabelPlanResult> {
  const mutation = {
    requestId: input.idempotencyKey,
    actor: input.actor,
    operation: "fleet.standard-labels.plan",
    targetKey: "github-organization:seorilabs",
    request: { mode: "PLAN" } as JsonValue,
  };
  const begun = await beginAutomationMutation(mutation);
  if (begun.replay) return begun.replay as unknown as FleetStandardLabelPlanResult;

  const definition = await requireAutomationDefinition(dependencies);
  const contract = await dependencies.transport.readContract(fleetStandardLabelContractSourceConfig());
  const cohort = await listCohort(dependencies);
  const cohortDigest = `sha256:${jsonDigest(cohort.map((registration) => ({
    repositoryId: registration.repoId.toString(),
    repositoryFullName: registration.repoFullName,
    registrationStatus: registration.status,
    registrationGeneration: registration.reconcileGeneration ?? 0,
  })) as unknown as JsonValue)}`;
  const tasks: FleetStandardLabelTask[] = [];
  for (const registration of cohort) {
    const operation = fleetStandardLabelOperation({
      contract,
      repositoryId: registration.repoId.toString(),
      repositoryFullName: registration.repoFullName,
    });
    const readback = await dependencies.transport.readRepository({
      repositoryId: registration.repoId.toString(),
      repositoryFullName: registration.repoFullName,
      operation,
    });
    tasks.push(taskFor({
      contract,
      registration,
      observation: readback.observation,
    }));
  }
  const digest = planDigest({ contract: contractPublicIdentity(contract), cohortDigest, tasks });
  const occurrence = await createOrReadPlanOccurrence({
    dependencies,
    definitionId: definition.id,
    contract,
    cohortDigest,
    tasks,
    digest,
    now: dependencies.now(),
  });
  if (
    occurrence.definitionId !== definition.id
    || occurrence.runs.length !== tasks.length
    || (occurrence.result as Record<string, unknown> | null)?.planDigest !== digest
  ) {
    throw new ControlPlaneError(
      "Fleet 표준 label plan replay가 exact binding과 다릅니다.",
      409,
      "FLEET_STANDARD_LABEL_PLAN_REPLAY_MISMATCH",
    );
  }
  const items = planItemsFromRuns(occurrence.runs);
  if (
    items.some((item, index) => item.desiredDigest !== tasks[index]?.desiredDigest)
  ) {
    throw new ControlPlaneError(
      "Fleet 표준 label plan item binding이 다릅니다.",
      409,
      "FLEET_STANDARD_LABEL_PLAN_REPLAY_MISMATCH",
    );
  }
  const result: FleetStandardLabelPlanResult = {
    mode: "PLAN",
    planId: occurrence.id,
    planDigest: digest,
    duplicate: false,
    contract: contractPublicIdentity(contract),
    cohortDigest,
    cohortCount: items.length,
    match: items.filter((item) => item.state === "MATCH").length,
    drift: items.filter((item) => item.state === "DRIFT").length,
    mutationAttempted: false,
    items,
  };
  const completed = await completeAutomationMutation({
    ...mutation,
    requestHash: begun.requestHash,
    response: result,
    audit: {
      action: "fleet.standard-labels.plan",
      entityType: "AutomationOccurrence",
      entityId: occurrence.id,
      payload: {
        planDigest: digest,
        contractSourceSha: contract.sourceSha,
        catalogDigest: contract.catalogDigest,
        cohortDigest,
        cohortCount: items.length,
        match: result.match,
        drift: result.drift,
        mutationAttempted: false,
      },
    },
  });
  return completed as unknown as FleetStandardLabelPlanResult;
}

function taskMatchesContract(task: FleetStandardLabelTask, contract: FleetStandardLabelContract): boolean {
  const expected = contractPublicIdentity(contract);
  return canonicalJson(task.contract as unknown as JsonValue) === canonicalJson(expected as unknown as JsonValue)
    && task.operation.payload.catalogDigest === contract.catalogDigest
    && task.operation.payload.catalogVersion === contract.catalog.catalogVersion;
}

async function registrationStillMatches(
  dependencies: FleetStandardLabelServiceDependencies,
  task: FleetStandardLabelTask,
): Promise<boolean> {
  const registration = await dependencies.client.repositoryRegistration.findUnique({
    where: { repoId: BigInt(task.repositoryId) },
    select: {
      repoFullName: true,
      status: true,
      archived: true,
      reconcileGeneration: true,
    },
  });
  return registration !== null
    && !registration.archived
    && registration.repoFullName === task.repositoryFullName
    && registration.status === task.registrationStatus
    && (registration.reconcileGeneration ?? 0) === task.registrationGeneration;
}

async function claimRun(input: {
  dependencies: FleetStandardLabelServiceDependencies;
  runId: string;
  task: FleetStandardLabelTask;
  now: Date;
}): Promise<{ state: "CLAIMED" | "REPLAYED" | "BUSY" | "DEAD_LETTER"; generation: number; readbackFirst: boolean }> {
  return input.dependencies.client.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({
      where: { id: input.runId },
      include: { occurrence: { include: { definition: true } }, repoGuard: true },
    });
    if (!run) throw new ControlPlaneError("label run이 없습니다.", 404, "FLEET_STANDARD_LABEL_RUN_NOT_FOUND");
    if (
      run.occurrence.definition.key !== DEFINITION_KEY
      || !definitionPolicyMatches(run.occurrence.definition.configuration)
      || run.createsPr
      || run.issueNumber !== null
      || run.repoFullName !== input.task.repositoryFullName
      || fleetStandardLabelTaskSchema.parse(run.taskInput).desiredDigest !== input.task.desiredDigest
    ) {
      throw new ControlPlaneError(
        "label run의 automation binding이 다릅니다.",
        409,
        "FLEET_STANDARD_LABEL_RUN_BINDING_MISMATCH",
      );
    }
    if (run.status === "SUCCEEDED") {
      return { state: "REPLAYED", generation: run.leaseGeneration, readbackFirst: false };
    }
    if (run.status === "DEAD_LETTER" || run.status === "CANCELLED") {
      return { state: "DEAD_LETTER", generation: run.leaseGeneration, readbackFirst: false };
    }
    if (run.status === "RUNNING" && run.eligibleAt > input.now) {
      return { state: "BUSY", generation: run.leaseGeneration, readbackFirst: run.readbackRequestedAt !== null };
    }
    const readbackFirst = run.readbackRequestedAt !== null || run.status === "RUNNING" || run.status === "FAILED";
    if (!readbackFirst && run.attempts >= run.maxAttempts) {
      await tx.agentRun.update({
        where: { id: run.id },
        data: { status: "DEAD_LETTER", completedAt: input.now, error: "FLEET_STANDARD_LABEL_ATTEMPTS_EXHAUSTED" },
      });
      return { state: "DEAD_LETTER", generation: run.leaseGeneration, readbackFirst: false };
    }
    const activeScopeKey = `repo-label:${input.task.repositoryFullName.toLowerCase()}`;
    try {
      if (!run.repoGuard) {
        await tx.agentRepoGuard.create({
          data: {
            runId: run.id,
            repoFullName: input.task.repositoryFullName,
            activeScopeKey,
            acquiredAt: input.now,
          },
        });
      } else if (run.repoGuard.activeScopeKey !== activeScopeKey) {
        const guard = await tx.agentRepoGuard.updateMany({
          where: { runId: run.id, activeScopeKey: null },
          data: { activeScopeKey, acquiredAt: input.now, releasedAt: null },
        });
        if (guard.count !== 1) return { state: "BUSY", generation: run.leaseGeneration, readbackFirst };
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return { state: "BUSY", generation: run.leaseGeneration, readbackFirst };
      }
      throw error;
    }
    const generation = run.leaseGeneration + 1;
    const claimed = await tx.agentRun.updateMany({
      where: {
        id: run.id,
        status: run.status,
        leaseGeneration: run.leaseGeneration,
        updatedAt: run.updatedAt,
      },
      data: {
        status: "RUNNING",
        leaseGeneration: generation,
        attempts: { increment: 1 },
        eligibleAt: new Date(input.now.getTime() + RUN_LEASE_MS),
        startedAt: input.now,
        completedAt: null,
        error: null,
      },
    });
    if (claimed.count !== 1) return { state: "BUSY", generation: run.leaseGeneration, readbackFirst };
    await tx.automationOccurrence.update({
      where: { id: run.occurrenceId },
      data: { status: "RUNNING", completedAt: null },
    });
    await tx.agentRunEvent.create({
      data: {
        requestId: `fleet-label-claim:${run.id}:g${generation}`,
        runId: run.id,
        type: readbackFirst ? "readback_claimed" : "claimed",
        generation,
        actor: "backoffice:fleet-standard-label-adapter",
        payload: {
          action: FLEET_STANDARD_LABEL_ACTION,
          repositoryId: input.task.repositoryId,
          desiredDigest: input.task.desiredDigest,
          resumeMode: readbackFirst ? "READBACK_FIRST" : "START",
        },
      },
    });
    return { state: "CLAIMED", generation, readbackFirst };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function assertRunLease(input: {
  dependencies: FleetStandardLabelServiceDependencies;
  runId: string;
  generation: number;
  task: FleetStandardLabelTask;
}): Promise<void> {
  const now = input.dependencies.now();
  const run = await input.dependencies.client.agentRun.findUnique({
    where: { id: input.runId },
    select: {
      status: true,
      leaseGeneration: true,
      eligibleAt: true,
      readbackRequestedAt: true,
      taskInput: true,
      repoGuard: { select: { activeScopeKey: true } },
    },
  });
  if (
    !run
    || run.status !== "RUNNING"
    || run.leaseGeneration !== input.generation
    || run.eligibleAt <= now
    || run.repoGuard?.activeScopeKey !== `repo-label:${input.task.repositoryFullName.toLowerCase()}`
    || fleetStandardLabelTaskSchema.parse(run.taskInput).desiredDigest !== input.task.desiredDigest
    || !(await registrationStillMatches(input.dependencies, input.task))
  ) {
    throw new Error("FLEET_STANDARD_LABEL_LEASE_STALE");
  }
}

async function completeRun(input: {
  dependencies: FleetStandardLabelServiceDependencies;
  runId: string;
  generation: number;
  task: FleetStandardLabelTask;
  receipt: FleetStandardLabelApplyReceipt;
  now: Date;
}): Promise<void> {
  await input.dependencies.client.$transaction(async (tx) => {
    const registration = await tx.repositoryRegistration.findUnique({
      where: { repoId: BigInt(input.task.repositoryId) },
      select: {
        repoFullName: true,
        status: true,
        archived: true,
        reconcileGeneration: true,
      },
    });
    if (
      !registration
      || registration.archived
      || registration.repoFullName !== input.task.repositoryFullName
      || registration.status !== input.task.registrationStatus
      || (registration.reconcileGeneration ?? 0) !== input.task.registrationGeneration
    ) {
      throw new ControlPlaneError(
        "label run 완료 직전 repository registration이 바뀌었습니다.",
        409,
        "FLEET_STANDARD_LABEL_REGISTRATION_STALE",
      );
    }
    const updated = await tx.agentRun.updateMany({
      where: { id: input.runId, status: "RUNNING", leaseGeneration: input.generation },
      data: {
        status: "SUCCEEDED",
        completedAt: input.now,
        eligibleAt: input.now,
        readbackRequestedAt: null,
        error: null,
        outcome: {
          code: "STANDARD_LABELS_VERIFIED",
          action: FLEET_STANDARD_LABEL_ACTION,
          repositoryId: input.task.repositoryId,
          catalogDigest: input.task.contract.catalogDigest,
          desiredDigest: input.task.desiredDigest,
          receipt: input.receipt,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    if (updated.count !== 1) {
      throw new ControlPlaneError(
        "label run 완료 CAS에 실패했습니다.",
        409,
        "FLEET_STANDARD_LABEL_COMPLETION_STALE",
      );
    }
    await tx.agentRepoGuard.updateMany({
      where: { runId: input.runId, activeScopeKey: { not: null } },
      data: { activeScopeKey: null, releasedAt: input.now },
    });
    await tx.agentRunEvent.create({
      data: {
        requestId: `fleet-label-complete:${input.runId}:g${input.generation}`,
        runId: input.runId,
        type: "completed",
        generation: input.generation,
        actor: "backoffice:fleet-standard-label-adapter",
        payload: {
          action: FLEET_STANDARD_LABEL_ACTION,
          repositoryId: input.task.repositoryId,
          catalogDigest: input.task.contract.catalogDigest,
          mutations: input.receipt.mutations,
          afterReadbackDigest: input.receipt.afterReadbackDigest,
          customLabelsDigest: input.receipt.customLabelsDigest,
        },
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function failRun(input: {
  dependencies: FleetStandardLabelServiceDependencies;
  runId: string;
  generation: number;
  task: FleetStandardLabelTask;
  mutationStarted: boolean;
  error: string;
  now: Date;
}): Promise<"READBACK_FIRST" | "RETRYABLE" | "DEAD_LETTER"> {
  return input.dependencies.client.$transaction(async (tx) => {
    const current = await tx.agentRun.findUnique({ where: { id: input.runId } });
    if (!current || current.status !== "RUNNING" || current.leaseGeneration !== input.generation) {
      return "READBACK_FIRST" as const;
    }
    const deadLetter = !input.mutationStarted && current.attempts >= current.maxAttempts;
    const status = input.mutationStarted ? "FAILED" : deadLetter ? "DEAD_LETTER" : "PENDING";
    await tx.agentRun.update({
      where: { id: input.runId },
      data: {
        status,
        eligibleAt: input.now,
        completedAt: deadLetter ? input.now : null,
        readbackRequestedAt: input.mutationStarted ? input.now : null,
        error: input.error,
      },
    });
    if (!input.mutationStarted) {
      await tx.agentRepoGuard.updateMany({
        where: { runId: input.runId, activeScopeKey: { not: null } },
        data: { activeScopeKey: null, releasedAt: input.now },
      });
    }
    await tx.agentRunEvent.create({
      data: {
        requestId: `fleet-label-failed:${input.runId}:g${input.generation}`,
        runId: input.runId,
        type: input.mutationStarted ? "readback_required" : deadLetter ? "dead_letter" : "retry_scheduled",
        generation: input.generation,
        actor: "backoffice:fleet-standard-label-adapter",
        payload: {
          action: FLEET_STANDARD_LABEL_ACTION,
          repositoryId: input.task.repositoryId,
          error: input.error,
          mutationStarted: input.mutationStarted,
        },
      },
    });
    return input.mutationStarted ? "READBACK_FIRST" : deadLetter ? "DEAD_LETTER" : "RETRYABLE";
  });
}

async function staleRun(input: {
  dependencies: FleetStandardLabelServiceDependencies;
  runId: string;
  task: FleetStandardLabelTask;
  now: Date;
}): Promise<void> {
  await input.dependencies.client.$transaction(async (tx) => {
    await tx.agentRun.updateMany({
      where: { id: input.runId, status: { in: ["PENDING", "RUNNING", "FAILED", "SUCCEEDED"] } },
      data: {
        status: "CANCELLED",
        completedAt: input.now,
        error: "FLEET_STANDARD_LABEL_REGISTRATION_STALE",
      },
    });
    await tx.agentRepoGuard.updateMany({
      where: { runId: input.runId, activeScopeKey: { not: null } },
      data: { activeScopeKey: null, releasedAt: input.now },
    });
    await tx.agentRunEvent.createMany({
      data: [{
        requestId: `fleet-label-stale:${input.runId}:${input.task.registrationGeneration}`,
        runId: input.runId,
        type: "stale",
        actor: "backoffice:fleet-standard-label-adapter",
        payload: {
          action: FLEET_STANDARD_LABEL_ACTION,
          repositoryId: input.task.repositoryId,
          expectedRegistrationGeneration: input.task.registrationGeneration,
        },
      }],
      skipDuplicates: true,
    });
  });
}

function replayReceipt(task: FleetStandardLabelTask, run: { outcome: Prisma.JsonValue | null }): FleetStandardLabelApplyReceipt | null {
  const outcome = run.outcome && typeof run.outcome === "object" && !Array.isArray(run.outcome)
    ? run.outcome as Record<string, unknown>
    : null;
  const receipt = outcome?.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const candidate = receipt as unknown as FleetStandardLabelApplyReceipt;
  return candidate.action === FLEET_STANDARD_LABEL_ACTION
    && candidate.repositoryId === task.repositoryId
    && candidate.catalogDigest === task.contract.catalogDigest
    ? candidate
    : null;
}

async function reconcileOccurrenceState(input: {
  dependencies: FleetStandardLabelServiceDependencies;
  occurrenceId: string;
  planDigest: string;
  now: Date;
}): Promise<void> {
  const occurrence = await input.dependencies.client.automationOccurrence.findUnique({
    where: { id: input.occurrenceId },
    select: {
      result: true,
      runs: { select: { status: true } },
    },
  });
  if (!occurrence) {
    throw new ControlPlaneError(
      "Fleet 표준 label plan occurrence가 없습니다.",
      404,
      "FLEET_STANDARD_LABEL_PLAN_NOT_FOUND",
    );
  }
  const runs = occurrence.runs;
  const completed = runs.every((run) => run.status === "SUCCEEDED");
  const dead = runs.some((run) => run.status === "DEAD_LETTER" || run.status === "CANCELLED");
  const running = runs.some((run) => run.status === "RUNNING" || run.status === "FAILED");
  await input.dependencies.client.automationOccurrence.update({
    where: { id: input.occurrenceId },
    data: {
      status: completed ? "COMPLETED" : dead ? "DEAD_LETTER" : running ? "RUNNING" : "PENDING",
      completedAt: completed || dead ? input.now : null,
      result: {
        ...(occurrence.result && typeof occurrence.result === "object" && !Array.isArray(occurrence.result)
          ? occurrence.result as Record<string, Prisma.JsonValue>
          : {}),
        planDigest: input.planDigest,
        action: FLEET_STANDARD_LABEL_ACTION,
        completed,
        deadLetter: dead,
      } as Prisma.InputJsonValue,
    },
  });
}

export async function applyFleetStandardLabels(input: {
  actor: string;
  idempotencyKey: string;
  planId: string;
  planDigest: string;
}, dependencies: FleetStandardLabelServiceDependencies = defaultDependencies): Promise<FleetStandardLabelApplyResult> {
  const mutation = {
    requestId: input.idempotencyKey,
    actor: input.actor,
    operation: "fleet.standard-labels.apply",
    targetKey: `automation-occurrence:${input.planId}`,
    request: {
      mode: "APPLY",
      planId: input.planId,
      planDigest: input.planDigest,
    } as JsonValue,
  };
  const begun = await beginAutomationMutation(mutation);
  if (begun.replay) return begun.replay as unknown as FleetStandardLabelApplyResult;

  const definition = await requireAutomationDefinition(dependencies);
  const occurrence = await dependencies.client.automationOccurrence.findUnique({
    where: { id: input.planId },
    include: { definition: true, runs: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
  });
  if (
    !occurrence
    || occurrence.definitionId !== definition.id
    || occurrence.definition.key !== DEFINITION_KEY
    || !definitionPolicyMatches(occurrence.definition.configuration)
    || (occurrence.result as Record<string, unknown> | null)?.planDigest !== input.planDigest
  ) {
    throw new ControlPlaneError(
      "Fleet 표준 label apply plan binding이 다릅니다.",
      409,
      "FLEET_STANDARD_LABEL_PLAN_BINDING_MISMATCH",
    );
  }
  const contract = await dependencies.transport.readContract(fleetStandardLabelContractSourceConfig());
  const items: ApplyItem[] = [];
  let mutationAttempted = false;
  for (const run of occurrence.runs) {
    const task = fleetStandardLabelTaskSchema.parse(run.taskInput);
    if (!taskMatchesContract(task, contract) || !(await registrationStillMatches(dependencies, task))) {
      await staleRun({ dependencies, runId: run.id, task, now: dependencies.now() });
      items.push({
        runId: run.id,
        repositoryId: task.repositoryId,
        repositoryFullName: task.repositoryFullName,
        generation: run.leaseGeneration,
        outcome: "STALE",
        mutations: 0,
        error: "FLEET_STANDARD_LABEL_PLAN_STALE",
        receipt: null,
      });
      continue;
    }
    const claim = await claimRun({ dependencies, runId: run.id, task, now: dependencies.now() });
    if (claim.state === "REPLAYED") {
      items.push({
        runId: run.id,
        repositoryId: task.repositoryId,
        repositoryFullName: task.repositoryFullName,
        generation: claim.generation,
        outcome: "REPLAYED",
        mutations: 0,
        error: null,
        receipt: replayReceipt(task, run),
      });
      continue;
    }
    if (claim.state === "BUSY" || claim.state === "DEAD_LETTER") {
      items.push({
        runId: run.id,
        repositoryId: task.repositoryId,
        repositoryFullName: task.repositoryFullName,
        generation: claim.generation,
        outcome: claim.state === "BUSY" ? "BUSY" : "DEAD_LETTER",
        mutations: 0,
        error: claim.state === "BUSY" ? "FLEET_STANDARD_LABEL_RUN_BUSY" : "FLEET_STANDARD_LABEL_DEAD_LETTER",
        receipt: null,
      });
      continue;
    }
    let mutationStarted = false;
    try {
      await assertRunLease({ dependencies, runId: run.id, generation: claim.generation, task });
      const readback = await dependencies.transport.readRepository({
        repositoryId: task.repositoryId,
        repositoryFullName: task.repositoryFullName,
        operation: task.operation,
      });
      let receipt: FleetStandardLabelApplyReceipt;
      if (readback.observation.state === "MATCH") {
        receipt = {
          action: FLEET_STANDARD_LABEL_ACTION,
          repositoryId: task.repositoryId,
          repositoryFullName: task.repositoryFullName,
          catalogVersion: task.operation.payload.catalogVersion,
          catalogDigest: task.operation.payload.catalogDigest,
          method: "UPSERT_FIXED_LABELS_PRESERVE_CUSTOM",
          state: "UNCHANGED",
          mutations: 0,
          beforeReadbackDigest: readback.observation.readbackDigest,
          afterReadbackDigest: readback.observation.readbackDigest,
          customLabelsDigest: readback.observation.customLabelsDigest,
        };
      } else {
        mutationStarted = true;
        mutationAttempted = true;
        receipt = await dependencies.transport.ensureRepository({
          repositoryId: task.repositoryId,
          repositoryFullName: task.repositoryFullName,
          operation: task.operation,
          assertLease: () => assertRunLease({
            dependencies,
            runId: run.id,
            generation: claim.generation,
            task,
          }),
        });
      }
      await assertRunLease({ dependencies, runId: run.id, generation: claim.generation, task });
      await completeRun({
        dependencies,
        runId: run.id,
        generation: claim.generation,
        task,
        receipt,
        now: dependencies.now(),
      });
      items.push({
        runId: run.id,
        repositoryId: task.repositoryId,
        repositoryFullName: task.repositoryFullName,
        generation: claim.generation,
        outcome: "VERIFIED",
        mutations: receipt.mutations,
        error: null,
        receipt,
      });
    } catch (error) {
      const code = publicErrorCode(error, mutationStarted
        ? "FLEET_STANDARD_LABEL_APPLY_RESULT_UNKNOWN"
        : "FLEET_STANDARD_LABEL_READBACK_FAILED");
      const outcome = await failRun({
        dependencies,
        runId: run.id,
        generation: claim.generation,
        task,
        mutationStarted,
        error: code,
        now: dependencies.now(),
      });
      items.push({
        runId: run.id,
        repositoryId: task.repositoryId,
        repositoryFullName: task.repositoryFullName,
        generation: claim.generation,
        outcome,
        mutations: 0,
        error: code,
        receipt: null,
      });
    }
  }
  await reconcileOccurrenceState({
    dependencies,
    occurrenceId: occurrence.id,
    planDigest: input.planDigest,
    now: dependencies.now(),
  });
  const summary = {
    verified: items.filter((item) => item.outcome === "VERIFIED").length,
    replayed: items.filter((item) => item.outcome === "REPLAYED").length,
    busy: items.filter((item) => item.outcome === "BUSY").length,
    readbackFirst: items.filter((item) => item.outcome === "READBACK_FIRST").length,
    retryable: items.filter((item) => item.outcome === "RETRYABLE").length,
    deadLetter: items.filter((item) => item.outcome === "DEAD_LETTER").length,
    stale: items.filter((item) => item.outcome === "STALE").length,
  };
  const result: FleetStandardLabelApplyResult = {
    mode: "APPLY",
    planId: occurrence.id,
    planDigest: input.planDigest,
    duplicate: false,
    state: summary.busy > 0 && summary.verified + summary.replayed + summary.readbackFirst
      + summary.retryable + summary.deadLetter + summary.stale === 0
      ? "busy"
      : summary.readbackFirst + summary.retryable + summary.deadLetter + summary.stale + summary.busy > 0
        ? "partial"
        : "completed",
    ...summary,
    mutationAttempted,
    items,
  };
  const completed = await completeAutomationMutation({
    ...mutation,
    requestHash: begun.requestHash,
    response: result,
    audit: {
      action: "fleet.standard-labels.apply",
      entityType: "AutomationOccurrence",
      entityId: occurrence.id,
      payload: {
        planDigest: input.planDigest,
        catalogDigest: contract.catalogDigest,
        verified: result.verified,
        replayed: result.replayed,
        busy: result.busy,
        readbackFirst: result.readbackFirst,
        retryable: result.retryable,
        deadLetter: result.deadLetter,
        stale: result.stale,
        mutationAttempted,
      },
    },
  });
  return completed as unknown as FleetStandardLabelApplyResult;
}

export async function getFleetStandardLabelStatus(
  dependencies: FleetStandardLabelServiceDependencies = defaultDependencies,
) {
  const definition = await dependencies.client.automationDefinition.findUnique({
    where: { key: DEFINITION_KEY },
    select: { id: true, enabled: true, pausedAt: true, cancelledAt: true, configuration: true },
  });
  const latest = definition
    ? await dependencies.client.automationOccurrence.findFirst({
        where: { definitionId: definition.id },
        orderBy: { createdAt: "desc" },
        include: { runs: { select: { status: true, readbackRequestedAt: true } } },
      })
    : null;
  return {
    action: FLEET_STANDARD_LABEL_ACTION,
    transport: definition && definitionPolicyMatches(definition.configuration)
      && definition.enabled && !definition.pausedAt && !definition.cancelledAt
      ? "CONFIGURED"
      : "NOT_CONFIGURED",
    latest: latest ? {
      planId: latest.id,
      status: latest.status,
      planDigest: (latest.result as Record<string, unknown> | null)?.planDigest ?? null,
      runs: latest.runs.length,
      verified: latest.runs.filter((run) => run.status === "SUCCEEDED").length,
      readbackFirst: latest.runs.filter((run) => run.readbackRequestedAt !== null).length,
      deadLetter: latest.runs.filter((run) => run.status === "DEAD_LETTER").length,
    } : null,
  };
}
