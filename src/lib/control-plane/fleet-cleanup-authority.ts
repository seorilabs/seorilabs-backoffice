import { createHash, randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import { computeFleetEvidenceDigest } from "seorilabs-org-contracts/repo-contract/fleet-migration";
import { createTrustedFleetCleanupStateStore } from "seorilabs-org-contracts/repo-contract/trusted-cleanup-executor";

import {
  FLEET_CLEANUP_CAPABILITY_TTL_SECONDS,
  FLEET_CLEANUP_RESERVATION_TTL_SECONDS,
  fleetCleanupCapabilityRequestDigest,
  fleetCleanupPublicCapability,
  type FleetCleanupExactScope,
} from "@/lib/control-plane/fleet-cleanup-capability-contract";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const STEP_KINDS = ["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"] as const;

export type FleetCleanupStateClient = Pick<
  typeof prisma,
  "$transaction" | "fleetCleanupAuthority" | "fleetCleanupCapability" | "fleetCleanupExecution"
>;

type Transaction = Prisma.TransactionClient;

function fail(code: string): never {
  throw new Error(code);
}

function evidence<T extends Record<string, unknown>>(value: T): T & { evidenceDigest: string } {
  const result = { ...value, evidenceDigest: `sha256:${"0".repeat(64)}` };
  result.evidenceDigest = computeFleetEvidenceDigest(result);
  return result;
}

function leaseDigest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicDigest(value: JsonValue): string {
  return `sha256:${jsonDigest(value)}`;
}

function publicJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function capabilityInclude() {
  return {
    authority: true,
    execution: { include: { steps: { orderBy: { ordinal: "asc" as const } } } },
  };
}

type CapabilityRow = Prisma.FleetCleanupCapabilityGetPayload<{
  include: ReturnType<typeof capabilityInclude>;
}>;

function exactCapabilityRow(row: CapabilityRow, scope: FleetCleanupExactScope): boolean {
  const authority = row.authority;
  return authority.organizationId === scope.organizationId
    && authority.installationId === scope.installationId
    && authority.repositoryId === BigInt(scope.repositoryId)
    && authority.repositoryFullName === scope.repositoryFullName
    && authority.sourceSha === scope.sourceSha
    && authority.treeSha === scope.treeSha
    && authority.issuanceDigest === scope.issuanceDigest
    && authority.inventoryDigest === scope.inventoryDigest
    && authority.planDigest === scope.planDigest
    && authority.chainHeadDigest === scope.chainHeadDigest
    && authority.fileActionSetDigest === scope.fileActionSetDigest
    && row.issueNumber === scope.issueNumber
    && row.approvalScopeDigest === scope.approvalScopeDigest
    && row.fileActionSetDigest === scope.fileActionSetDigest
    && row.replacementFilesDigest === scope.replacementFilesDigest
    && jsonDigest(row.fileActionSet as JsonValue) === jsonDigest(scope.fileActionSet as unknown as JsonValue)
    && jsonDigest(row.replacementFiles as JsonValue) === jsonDigest(scope.replacementFiles as unknown as JsonValue);
}

function retryable(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && ["P2002", "P2034"].includes(error.code);
}

export async function issueFleetCleanupCapability(input: {
  requestId: string;
  approvedBy: string;
  ttlSeconds: number;
  scope: FleetCleanupExactScope;
  issuance: Record<string, unknown>;
  plan: Record<string, unknown>;
  client?: FleetCleanupStateClient;
  now?: Date;
  retryAttempt?: number;
}) {
  const client = input.client ?? prisma;
  const now = input.now ?? new Date();
  if (
    !ID.test(input.requestId)
    || !ID.test(input.approvedBy)
    || !Number.isInteger(input.ttlSeconds)
    || input.ttlSeconds < 1
    || input.ttlSeconds > FLEET_CLEANUP_CAPABILITY_TTL_SECONDS
    || !Number.isFinite(now.getTime())
  ) fail("FLEET_CLEANUP_CAPABILITY_REQUEST_INVALID");
  const requestDigest = fleetCleanupCapabilityRequestDigest(input);
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1_000);
  try {
    return await client.$transaction(async (transaction) => {
      const tx = transaction as Transaction;
      const replay = await tx.fleetCleanupCapability.findUnique({
        where: { requestId: input.requestId },
        include: capabilityInclude(),
      });
      if (replay) {
        if (replay.requestDigest !== requestDigest || !exactCapabilityRow(replay, input.scope)) {
          fail("FLEET_CLEANUP_CAPABILITY_IDEMPOTENCY_CONFLICT");
        }
        return fleetCleanupPublicCapability({
          id: replay.id,
          state: replay.state,
          approvedAt: replay.approvedAt,
          expiresAt: replay.expiresAt,
          scope: input.scope,
          duplicate: true,
        });
      }
      const existingAuthority = await tx.fleetCleanupAuthority.findUnique({
        where: {
          repositoryId_issuanceDigest_inventoryDigest_planDigest_sourceSha: {
            repositoryId: BigInt(input.scope.repositoryId),
            issuanceDigest: input.scope.issuanceDigest,
            inventoryDigest: input.scope.inventoryDigest,
            planDigest: input.scope.planDigest,
            sourceSha: input.scope.sourceSha,
          },
        },
      });
      if (
        existingAuthority
        && (
          existingAuthority.organizationId !== input.scope.organizationId
          || existingAuthority.installationId !== input.scope.installationId
          || existingAuthority.repositoryFullName !== input.scope.repositoryFullName
          || existingAuthority.chainHeadDigest !== input.scope.chainHeadDigest
          || existingAuthority.fileActionSetDigest !== input.scope.fileActionSetDigest
          || existingAuthority.state !== "ACTIVE"
        )
      ) fail("FLEET_CLEANUP_AUTHORITY_BINDING_CONFLICT");
      const authority = existingAuthority ?? await tx.fleetCleanupAuthority.create({
        data: {
          organizationId: input.scope.organizationId,
          installationId: input.scope.installationId,
          repositoryId: BigInt(input.scope.repositoryId),
          repositoryFullName: input.scope.repositoryFullName,
          sourceSha: input.scope.sourceSha,
          treeSha: input.scope.treeSha,
          issuanceDigest: input.scope.issuanceDigest,
          inventoryDigest: input.scope.inventoryDigest,
          planDigest: input.scope.planDigest,
          chainHeadDigest: input.scope.chainHeadDigest,
          fileActionSetDigest: input.scope.fileActionSetDigest,
          authorityRevision: `fleet-cleanup-authority-${input.scope.planDigest.slice(7, 27)}`,
        },
      });
      const created = await tx.fleetCleanupCapability.create({
        data: {
          authorityId: authority.id,
          issueNumber: input.scope.issueNumber,
          approvalScopeDigest: input.scope.approvalScopeDigest,
          issuance: publicJson(input.issuance),
          plan: publicJson(input.plan),
          fileActionSet: publicJson(input.scope.fileActionSet),
          fileActionSetDigest: input.scope.fileActionSetDigest,
          replacementFiles: publicJson(input.scope.replacementFiles),
          replacementFilesDigest: input.scope.replacementFilesDigest,
          requestId: input.requestId,
          requestDigest,
          approvedBy: input.approvedBy,
          approvedAt: now,
          expiresAt,
        },
      });
      return fleetCleanupPublicCapability({
        id: created.id,
        state: created.state,
        approvedAt: created.approvedAt,
        expiresAt: created.expiresAt,
        scope: input.scope,
        duplicate: false,
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    });
  } catch (error) {
    if (retryable(error) && (input.retryAttempt ?? 0) < 2) {
      return issueFleetCleanupCapability({ ...input, retryAttempt: (input.retryAttempt ?? 0) + 1 });
    }
    throw error;
  }
}

function executionBinding(request: Record<string, unknown>) {
  return {
    organizationId: request.organizationId as string,
    installationId: request.installationId as string,
    issuanceDigest: request.issuanceDigest as string,
    inventoryDigest: request.inventoryDigest as string,
    planDigest: request.planDigest as string,
    executionKey: request.executionKey as string,
    runId: request.runId as string,
    workerId: request.workerId as string,
    repositoryId: request.repositoryId as string,
    fullName: request.fullName as string,
    sourceSha: request.sourceSha as string,
    issueNumber: request.issueNumber as number,
    chainHeadDigest: (request.chainHeadDigest as string | null) ?? null,
  };
}

function rowBinding(row: Prisma.FleetCleanupExecutionGetPayload<Record<string, never>>) {
  return {
    organizationId: row.organizationId,
    installationId: row.installationId,
    issuanceDigest: row.issuanceDigest,
    inventoryDigest: row.inventoryDigest,
    planDigest: row.planDigest,
    executionKey: row.executionKey,
    runId: row.runId,
    workerId: row.workerId,
    repositoryId: row.repositoryId.toString(),
    fullName: row.repositoryFullName,
    sourceSha: row.sourceSha,
    issueNumber: row.issueNumber,
    chainHeadDigest: row.chainHeadDigest,
  };
}

function sameBinding(row: Prisma.FleetCleanupExecutionGetPayload<Record<string, never>>, request: Record<string, unknown>): boolean {
  return JSON.stringify(rowBinding(row)) === JSON.stringify(executionBinding(request));
}

function assertCapabilityLive(row: CapabilityRow, now: Date, allowCompleted = false): void {
  if (
    row.authority.state !== "ACTIVE"
    || !["ACTIVE", ...(allowCompleted ? ["COMPLETED"] : [])].includes(row.state)
    || (row.state === "ACTIVE" && row.expiresAt <= now)
    || row.action !== "READY_PR_ONLY"
  ) fail("FLEET_CLEANUP_CAPABILITY_NOT_ACTIVE");
}

function assertExecutionClaimBinding(
  capability: CapabilityRow,
  request: Record<string, unknown>,
  steps: Array<{ kind?: unknown; operationId?: unknown }>,
): void {
  const authority = capability.authority;
  const executionKey = publicDigest({
    contract: "seorilabs-fleet-cleanup-execution-key-v1",
    issuanceDigest: authority.issuanceDigest,
    inventoryDigest: authority.inventoryDigest,
    planDigest: authority.planDigest,
    repositoryId: authority.repositoryId.toString(),
    sourceSha: authority.sourceSha,
  });
  if (
    request.organizationId !== authority.organizationId
    || request.installationId !== authority.installationId
    || request.issuanceDigest !== authority.issuanceDigest
    || request.inventoryDigest !== authority.inventoryDigest
    || request.planDigest !== authority.planDigest
    || request.executionKey !== executionKey
    || request.repositoryId !== authority.repositoryId.toString()
    || request.fullName !== authority.repositoryFullName
    || request.sourceSha !== authority.sourceSha
    || request.issueNumber !== capability.issueNumber
    || (request.chainHeadDigest ?? null) !== authority.chainHeadDigest
    || !ID.test(String(request.runId ?? ""))
    || !ID.test(String(request.workerId ?? ""))
    || steps.some((step) => step.operationId !== publicDigest({
      contract: "seorilabs-fleet-cleanup-operation-v1",
      executionKey,
      kind: step.kind as JsonValue,
    }))
  ) fail("FLEET_CLEANUP_EXECUTION_BINDING_CONFLICT");
}

function ledgerReadback(row: CapabilityRow["execution"], now: Date) {
  if (!row) fail("FLEET_CLEANUP_LEDGER_NOT_FOUND");
  return evidence({
    contract: "seorilabs-fleet-cleanup-execution-ledger-v1",
    ...rowBinding(row),
    readbackId: `fleet-cleanup-ledger-${row.executionGeneration}-${now.getTime()}`,
    observedAt: now.toISOString(),
    reservationId: row.reservationId,
    expectedStateGeneration: row.expectedStateGeneration,
    reservedStateGeneration: row.reservedStateGeneration,
    executionGeneration: row.executionGeneration,
    state: row.state,
    steps: row.steps.map((step) => ({
      kind: step.kind,
      operationId: step.operationId,
      state: step.state,
      receiptDigest: step.receiptDigest,
    })),
    receiptDigest: row.receiptDigest,
  });
}

async function loadCapability(client: FleetCleanupStateClient | Transaction, capabilityId: string): Promise<CapabilityRow> {
  const row = await client.fleetCleanupCapability.findUnique({
    where: { id: capabilityId },
    include: capabilityInclude(),
  });
  if (!row) fail("FLEET_CLEANUP_CAPABILITY_NOT_FOUND");
  return row;
}

export function createFleetCleanupStateProvider(input: {
  capabilityId: string;
  client?: FleetCleanupStateClient;
  now?: () => Date;
}) {
  const client = input.client ?? prisma;
  const now = () => input.now?.() ?? new Date();
  if (!ID.test(input.capabilityId)) fail("FLEET_CLEANUP_STATE_CONFIGURATION_INVALID");

  const provider = {
    async readAuthority(request: Record<string, unknown>) {
      const observedAt = now();
      const capability = await loadCapability(client, input.capabilityId);
      assertCapabilityLive(capability, observedAt, true);
      const authority = capability.authority;
      if (
        request.organizationId !== authority.organizationId
        || request.installationId !== authority.installationId
        || request.repositoryId !== authority.repositoryId.toString()
        || request.fullName !== authority.repositoryFullName
        || request.sourceSha !== authority.sourceSha
        || request.inventoryDigest !== authority.inventoryDigest
        || request.planDigest !== authority.planDigest
        || (request.chainHeadDigest ?? null) !== authority.chainHeadDigest
      ) fail("FLEET_CLEANUP_STATE_AUTHORITY_BINDING_MISMATCH");
      return evidence({
        contract: "seorilabs-fleet-cleanup-state-authority-v1",
        authorityRevision: authority.authorityRevision,
        readbackId: `fleet-cleanup-authority-${authority.generation}-${observedAt.getTime()}`,
        observedAt: observedAt.toISOString(),
        organizationId: authority.organizationId,
        installationId: authority.installationId,
        repositoryId: authority.repositoryId.toString(),
        fullName: authority.repositoryFullName,
        sourceSha: authority.sourceSha,
        inventoryDigest: authority.inventoryDigest,
        planDigest: authority.planDigest,
        state: authority.state,
        generation: authority.generation,
        chainHeadDigest: authority.chainHeadDigest,
      });
    },

    async reserveExecution(request: Record<string, unknown>) {
      const requestedExpiry = new Date(String(request.requestedExpiresAt ?? ""));
      const requestedSteps = request.steps as Array<{ kind?: unknown; operationId?: unknown }>;
      if (
        !Number.isFinite(requestedExpiry.getTime())
        || !Array.isArray(requestedSteps)
        || requestedSteps.length !== STEP_KINDS.length
        || requestedSteps.some((step, index) => (
          step.kind !== STEP_KINDS[index] || !DIGEST.test(String(step.operationId ?? ""))
        ))
      ) fail("FLEET_CLEANUP_EXECUTION_CLAIM_INVALID");
      return client.$transaction(async (transaction) => {
        const tx = transaction as Transaction;
        const claimedAt = now();
        const capability = await loadCapability(tx, input.capabilityId);
        assertCapabilityLive(capability, claimedAt, true);
        assertExecutionClaimBinding(capability, request, requestedSteps);
        const authority = capability.authority;
        const existing = capability.execution;
        if (existing) {
          if (!sameBinding(existing, request) || existing.authorityId !== authority.id) {
            fail("FLEET_CLEANUP_EXECUTION_BINDING_CONFLICT");
          }
          if (existing.state === "COMPLETED") {
            return {
              contract: "seorilabs-fleet-cleanup-state-reservation-v1",
              state: "COMPLETED",
              ...rowBinding(existing),
              reservationId: existing.reservationId,
              expectedStateGeneration: existing.expectedStateGeneration,
              reservedStateGeneration: existing.reservedStateGeneration,
              executionGeneration: existing.executionGeneration,
              stateGeneration: existing.reservedStateGeneration,
              receiptDigest: existing.receiptDigest,
            };
          }
          assertCapabilityLive(capability, claimedAt);
          const expiresAt = new Date(Math.min(
            requestedExpiry.getTime(),
            capability.expiresAt.getTime(),
            claimedAt.getTime() + FLEET_CLEANUP_RESERVATION_TTL_SECONDS * 1_000,
          ));
          if (expiresAt <= claimedAt) fail("FLEET_CLEANUP_EXECUTION_CLAIM_EXPIRED");
          const leaseToken = randomBytes(32);
          await tx.fleetCleanupExecution.update({
            where: { id: existing.id },
            data: { leaseTokenDigest: leaseDigest(leaseToken), expiresAt },
          });
          return {
            contract: "seorilabs-fleet-cleanup-state-reservation-v1",
            state: "RESUME",
            ...rowBinding(existing),
            reservationId: existing.reservationId,
            expectedStateGeneration: existing.expectedStateGeneration,
            reservedStateGeneration: existing.reservedStateGeneration,
            executionGeneration: existing.executionGeneration,
            expiresAt: expiresAt.toISOString(),
            leaseToken,
          };
        }
        assertCapabilityLive(capability, claimedAt);
        if (
          request.expectedStateGeneration !== authority.generation
          || request.authorityRevision !== authority.authorityRevision
          || request.authorityReadbackId === undefined
          || capability.approvalScopeDigest !== request.approvalScopeDigest && request.approvalScopeDigest !== undefined
        ) fail("FLEET_CLEANUP_EXECUTION_CAS_CONFLICT");
        const expiresAt = new Date(Math.min(
          requestedExpiry.getTime(),
          capability.expiresAt.getTime(),
          claimedAt.getTime() + FLEET_CLEANUP_RESERVATION_TTL_SECONDS * 1_000,
        ));
        if (expiresAt <= claimedAt) fail("FLEET_CLEANUP_EXECUTION_CLAIM_EXPIRED");
        const locked = await tx.fleetCleanupAuthority.updateMany({
          where: {
            id: authority.id,
            generation: authority.generation,
            state: "ACTIVE",
            activeExecutionKey: null,
          },
          data: { activeExecutionKey: String(request.executionKey) },
        });
        if (locked.count !== 1) fail("FLEET_CLEANUP_EXECUTION_CAS_CONFLICT");
        const leaseToken = randomBytes(32);
        const reservationId = `fleet-cleanup-reservation-${String(request.executionKey).slice(7, 27)}`;
        const created = await tx.fleetCleanupExecution.create({
          data: {
            authorityId: authority.id,
            capabilityId: capability.id,
            executionKey: String(request.executionKey),
            reservationId,
            organizationId: String(request.organizationId),
            installationId: String(request.installationId),
            issuanceDigest: String(request.issuanceDigest),
            inventoryDigest: String(request.inventoryDigest),
            planDigest: String(request.planDigest),
            runId: String(request.runId),
            workerId: String(request.workerId),
            repositoryId: BigInt(String(request.repositoryId)),
            repositoryFullName: String(request.fullName),
            sourceSha: String(request.sourceSha),
            issueNumber: Number(request.issueNumber),
            chainHeadDigest: (request.chainHeadDigest as string | null) ?? null,
            expectedStateGeneration: authority.generation,
            reservedStateGeneration: authority.generation + 1,
            leaseTokenDigest: leaseDigest(leaseToken),
            expiresAt,
            steps: {
              create: requestedSteps.map((step, index) => ({
                kind: String(step.kind),
                ordinal: index + 1,
                operationId: String(step.operationId),
              })),
            },
          },
        });
        return {
          contract: "seorilabs-fleet-cleanup-state-reservation-v1",
          state: "CLAIMED",
          ...rowBinding(created),
          reservationId,
          expectedStateGeneration: authority.generation,
          reservedStateGeneration: authority.generation + 1,
          executionGeneration: created.executionGeneration,
          expiresAt: expiresAt.toISOString(),
          leaseToken,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },

    async readExecution(request: Record<string, unknown>) {
      const capability = await loadCapability(client, input.capabilityId);
      if (
        !capability.execution
        || capability.execution.reservationId !== request.reservationId
        || !sameBinding(capability.execution, request)
      ) fail("FLEET_CLEANUP_LEDGER_NOT_FOUND");
      return ledgerReadback(capability.execution, now());
    },

    async transitionStep(request: Record<string, unknown>) {
      const token = request.leaseToken;
      if (!Buffer.isBuffer(token)) fail("FLEET_CLEANUP_LEDGER_LEASE_INVALID");
      return client.$transaction(async (transaction) => {
        const tx = transaction as Transaction;
        const transitionedAt = now();
        const capability = await loadCapability(tx, input.capabilityId);
        const execution = capability.execution;
        if (
          !execution
          || !sameBinding(execution, request)
          || execution.reservationId !== request.reservationId
          || execution.leaseTokenDigest !== leaseDigest(token)
          || execution.expiresAt <= transitionedAt
          || execution.executionGeneration !== request.expectedExecutionGeneration
          || execution.expectedStateGeneration !== request.expectedStateGeneration
          || execution.reservedStateGeneration !== request.reservedStateGeneration
        ) fail("FLEET_CLEANUP_LEDGER_CAS_CONFLICT");
        const step = execution.steps.find((candidate) => candidate.kind === request.kind);
        if (
          !step
          || step.operationId !== request.operationId
          || step.state !== request.expectedStepState
          || !["DISPATCHED", "RESULT_UNKNOWN", "CONFIRMED"].includes(String(request.nextStepState))
          || (request.nextStepState === "CONFIRMED") !== DIGEST.test(String(request.receiptDigest ?? ""))
        ) fail("FLEET_CLEANUP_LEDGER_STEP_CONFLICT");
        const changed = await tx.fleetCleanupExecutionStep.updateMany({
          where: { id: step.id, state: step.state, operationId: step.operationId },
          data: {
            state: String(request.nextStepState),
            receiptDigest: request.nextStepState === "CONFIRMED" ? String(request.receiptDigest) : null,
          },
        });
        if (changed.count !== 1) fail("FLEET_CLEANUP_LEDGER_STEP_CONFLICT");
        const nextGeneration = execution.executionGeneration + 1;
        const refreshedSteps = execution.steps.map((candidate) => (
          candidate.id === step.id
            ? { ...candidate, state: String(request.nextStepState), receiptDigest: request.nextStepState === "CONFIRMED" ? String(request.receiptDigest) : null }
            : candidate
        ));
        const state = refreshedSteps.some((candidate) => candidate.state === "RESULT_UNKNOWN")
          ? "RESULT_UNKNOWN"
          : refreshedSteps.every((candidate) => candidate.state === "CONFIRMED")
            ? "READY_TO_COMPLETE"
            : "RUNNING";
        const executionChanged = await tx.fleetCleanupExecution.updateMany({
          where: { id: execution.id, executionGeneration: execution.executionGeneration },
          data: { executionGeneration: nextGeneration, state },
        });
        if (executionChanged.count !== 1) fail("FLEET_CLEANUP_LEDGER_CAS_CONFLICT");
        const reloaded = await loadCapability(tx, input.capabilityId);
        return ledgerReadback(reloaded.execution, transitionedAt);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },

    async completeAndConsume(request: Record<string, unknown>) {
      const token = request.leaseToken;
      if (!Buffer.isBuffer(token) || !DIGEST.test(String(request.receiptDigest ?? ""))) {
        fail("FLEET_CLEANUP_COMPLETION_INVALID");
      }
      return client.$transaction(async (transaction) => {
        const tx = transaction as Transaction;
        const completedAt = now();
        const capability = await loadCapability(tx, input.capabilityId);
        const execution = capability.execution;
        const authority = capability.authority;
        if (
          !execution
          || !sameBinding(execution, request)
          || execution.reservationId !== request.reservationId
          || execution.leaseTokenDigest !== leaseDigest(token)
          || execution.expiresAt <= completedAt
          || execution.executionGeneration !== request.expectedExecutionGeneration
          || execution.state !== "READY_TO_COMPLETE"
          || execution.steps.some((step) => step.state !== "CONFIRMED")
          || authority.generation !== request.expectedStateGeneration
          || execution.reservedStateGeneration !== request.reservedStateGeneration
          || authority.activeExecutionKey !== execution.executionKey
        ) fail("FLEET_CLEANUP_COMPLETION_CAS_CONFLICT");
        const authorityChanged = await tx.fleetCleanupAuthority.updateMany({
          where: {
            id: authority.id,
            generation: execution.expectedStateGeneration,
            activeExecutionKey: execution.executionKey,
          },
          data: { generation: execution.reservedStateGeneration },
        });
        const executionChanged = await tx.fleetCleanupExecution.updateMany({
          where: { id: execution.id, executionGeneration: execution.executionGeneration, state: "READY_TO_COMPLETE" },
          data: {
            executionGeneration: execution.executionGeneration + 1,
            state: "COMPLETED",
            receiptDigest: String(request.receiptDigest),
            completedAt,
          },
        });
        const capabilityChanged = await tx.fleetCleanupCapability.updateMany({
          where: { id: capability.id, state: "ACTIVE" },
          data: { state: "COMPLETED", consumedAt: completedAt },
        });
        if (authorityChanged.count !== 1 || executionChanged.count !== 1 || capabilityChanged.count !== 1) {
          fail("FLEET_CLEANUP_COMPLETION_CAS_CONFLICT");
        }
        return evidence({
          contract: "seorilabs-fleet-cleanup-state-consumption-v1",
          state: "COMPLETED",
          ...rowBinding(execution),
          reservationId: execution.reservationId,
          stateGeneration: execution.reservedStateGeneration,
          executionGeneration: execution.executionGeneration + 1,
          receiptDigest: String(request.receiptDigest),
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },
  };
  return Object.freeze({
    provider,
    store: createTrustedFleetCleanupStateStore({ provider }),
  });
}

export async function readFleetCleanupCapability(input: {
  capabilityId: string;
  client?: FleetCleanupStateClient;
}): Promise<CapabilityRow> {
  return loadCapability(input.client ?? prisma, input.capabilityId);
}

export async function recordFleetCleanupCommitPlan(input: {
  capabilityId: string;
  operationId: string;
  mutationsDigest: string;
  mutationSet: JsonValue;
  commitDate: Date;
  expectedTreeSha: string;
  expectedCommitSha: string;
  client?: FleetCleanupStateClient;
}): Promise<void> {
  const client = input.client ?? prisma;
  const capability = await loadCapability(client, input.capabilityId);
  const execution = capability.execution;
  const step = execution?.steps.find((candidate) => candidate.kind === "CREATE_COMMIT");
  if (
    !execution
    || step?.operationId !== input.operationId
    || !DIGEST.test(input.mutationsDigest)
    || !Number.isFinite(input.commitDate.getTime())
  ) fail("FLEET_CLEANUP_COMMIT_PLAN_BINDING_INVALID");
  if (execution.expectedCommitSha) {
    if (
      execution.mutationsDigest !== input.mutationsDigest
      || execution.expectedTreeSha !== input.expectedTreeSha
      || execution.expectedCommitSha !== input.expectedCommitSha
      || execution.commitDate?.getTime() !== input.commitDate.getTime()
      || jsonDigest(execution.mutationSet as JsonValue) !== jsonDigest(input.mutationSet)
    ) fail("FLEET_CLEANUP_COMMIT_PLAN_CONFLICT");
    return;
  }
  const changed = await client.fleetCleanupExecution.updateMany({
    where: { id: execution.id, expectedCommitSha: null },
    data: {
      mutationsDigest: input.mutationsDigest,
      mutationSet: publicJson(input.mutationSet),
      commitDate: input.commitDate,
      expectedTreeSha: input.expectedTreeSha,
      expectedCommitSha: input.expectedCommitSha,
    },
  });
  if (changed.count !== 1) fail("FLEET_CLEANUP_COMMIT_PLAN_CONFLICT");
}
