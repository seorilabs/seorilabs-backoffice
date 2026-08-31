import assert from "node:assert/strict";
import test from "node:test";

import {
  createFleetCleanupStateProvider,
  issueFleetCleanupCapability,
  type FleetCleanupStateClient,
} from "@/lib/control-plane/fleet-cleanup-authority";
import type { FleetCleanupExactScope } from "@/lib/control-plane/fleet-cleanup-capability-contract";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const SOURCE_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const NOW = new Date("2026-08-31T00:00:00.000Z");

interface AuthorityRow extends Record<string, unknown> {
  id: string;
  organizationId: string;
  installationId: string;
  repositoryId: bigint;
  repositoryFullName: string;
  sourceSha: string;
  treeSha: string;
  issuanceDigest: string;
  inventoryDigest: string;
  planDigest: string;
  chainHeadDigest: string | null;
  fileActionSetDigest: string;
  authorityRevision: string;
  generation: number;
  state: string;
  activeExecutionKey: string | null;
}

interface StepRow extends Record<string, unknown> {
  id: string;
  executionId: string;
  kind: string;
  ordinal: number;
  operationId: string;
  state: string;
  receiptDigest: string | null;
}

interface ExecutionRow extends Record<string, unknown> {
  id: string;
  authorityId: string;
  capabilityId: string;
  executionKey: string;
  reservationId: string;
  organizationId: string;
  installationId: string;
  issuanceDigest: string;
  inventoryDigest: string;
  planDigest: string;
  runId: string;
  workerId: string;
  repositoryId: bigint;
  repositoryFullName: string;
  sourceSha: string;
  issueNumber: number;
  chainHeadDigest: string | null;
  expectedStateGeneration: number;
  reservedStateGeneration: number;
  executionGeneration: number;
  state: string;
  leaseTokenDigest: string;
  expiresAt: Date;
  mutationSet: JsonValue | null;
  mutationsDigest: string | null;
  commitDate: Date | null;
  expectedTreeSha: string | null;
  expectedCommitSha: string | null;
  receiptDigest: string | null;
  completedAt: Date | null;
  steps: StepRow[];
}

interface CapabilityRow extends Record<string, unknown> {
  id: string;
  authorityId: string;
  issueNumber: number;
  approvalScopeDigest: string;
  issuance: JsonValue;
  plan: JsonValue;
  fileActionSet: JsonValue;
  fileActionSetDigest: string;
  replacementFiles: JsonValue;
  replacementFilesDigest: string;
  action: string;
  state: string;
  requestId: string;
  requestDigest: string;
  approvedBy: string;
  approvedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

function fakeClient() {
  const authorities = new Map<string, AuthorityRow>();
  const capabilities = new Map<string, CapabilityRow>();
  const executions = new Map<string, ExecutionRow>();
  const authorityKey = (value: {
    repositoryId: bigint;
    issuanceDigest: string;
    inventoryDigest: string;
    planDigest: string;
    sourceSha: string;
  }) => JSON.stringify({
    repositoryId: value.repositoryId.toString(),
    issuanceDigest: value.issuanceDigest,
    inventoryDigest: value.inventoryDigest,
    planDigest: value.planDigest,
    sourceSha: value.sourceSha,
  });
  let id = 0;
  let transactionTail = Promise.resolve();
  const nextId = (prefix: string) => `${prefix}-${String(++id).padStart(8, "0")}`;

  const decorateCapability = (row: CapabilityRow | null) => {
    if (!row) return null;
    const authority = authorities.get(row.authorityId)!;
    const execution = [...executions.values()].find((candidate) => candidate.capabilityId === row.id) ?? null;
    return { ...row, authority, execution };
  };
  const models = {
    fleetCleanupAuthority: {
      async findUnique(input: { where: { repositoryId_issuanceDigest_inventoryDigest_planDigest_sourceSha: Parameters<typeof authorityKey>[0] } }) {
        const key = authorityKey(input.where.repositoryId_issuanceDigest_inventoryDigest_planDigest_sourceSha);
        return [...authorities.values()].find((row) => authorityKey(row) === key) ?? null;
      },
      async create(input: { data: Omit<AuthorityRow, "id" | "generation" | "state" | "activeExecutionKey"> }) {
        const row = {
          id: nextId("authority"),
          generation: 1,
          state: "ACTIVE",
          activeExecutionKey: null,
          ...input.data,
        } as AuthorityRow;
        authorities.set(row.id, row);
        return row;
      },
      async updateMany(input: { where: Partial<AuthorityRow>; data: Partial<AuthorityRow> }) {
        let count = 0;
        for (const row of authorities.values()) {
          if (Object.entries(input.where).every(([key, value]) => row[key] === value)) {
            Object.assign(row, input.data);
            count += 1;
          }
        }
        return { count };
      },
    },
    fleetCleanupCapability: {
      async findUnique(input: { where: { id?: string; requestId?: string } }) {
        const row = input.where.id
          ? capabilities.get(input.where.id) ?? null
          : [...capabilities.values()].find((candidate) => candidate.requestId === input.where.requestId) ?? null;
        return decorateCapability(row);
      },
      async create(input: { data: Omit<CapabilityRow, "id" | "action" | "state" | "consumedAt"> }) {
        const row = {
          id: nextId("capability"),
          action: "READY_PR_ONLY",
          state: "ACTIVE",
          consumedAt: null,
          ...input.data,
        } as CapabilityRow;
        capabilities.set(row.id, row);
        return row;
      },
      async updateMany(input: { where: Partial<CapabilityRow>; data: Partial<CapabilityRow> }) {
        let count = 0;
        for (const row of capabilities.values()) {
          if (Object.entries(input.where).every(([key, value]) => row[key] === value)) {
            Object.assign(row, input.data);
            count += 1;
          }
        }
        return { count };
      },
    },
    fleetCleanupExecution: {
      async create(input: { data: Record<string, unknown> & { steps: { create: Array<Omit<StepRow, "id" | "executionId" | "state" | "receiptDigest">> } } }) {
        const executionId = nextId("execution");
        const { steps, ...data } = input.data;
        const row: ExecutionRow = {
          id: executionId,
          executionGeneration: 1,
          state: "RUNNING",
          mutationSet: null,
          mutationsDigest: null,
          commitDate: null,
          expectedTreeSha: null,
          expectedCommitSha: null,
          receiptDigest: null,
          completedAt: null,
          ...data,
          steps: steps.create.map((step) => ({
            id: nextId("step"),
            executionId,
            state: "PENDING",
            receiptDigest: null,
            ...step,
          })),
        } as ExecutionRow;
        executions.set(row.id, row);
        return row;
      },
      async update(input: { where: { id: string }; data: Partial<ExecutionRow> }) {
        const row = executions.get(input.where.id)!;
        Object.assign(row, input.data);
        return row;
      },
      async updateMany(input: { where: Partial<ExecutionRow>; data: Partial<ExecutionRow> }) {
        let count = 0;
        for (const row of executions.values()) {
          if (Object.entries(input.where).every(([key, value]) => row[key] === value)) {
            Object.assign(row, input.data);
            count += 1;
          }
        }
        return { count };
      },
    },
    fleetCleanupExecutionStep: {
      async updateMany(input: { where: Partial<StepRow>; data: Partial<StepRow> }) {
        let count = 0;
        for (const execution of executions.values()) {
          for (const row of execution.steps) {
            if (Object.entries(input.where).every(([key, value]) => row[key] === value)) {
              Object.assign(row, input.data);
              count += 1;
            }
          }
        }
        return { count };
      },
    },
  };
  const client = {
    ...models,
    async $transaction<Result>(callback: (transaction: typeof models) => Promise<Result>) {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback(models);
      } finally {
        release();
      }
    },
  };
  return {
    client: client as unknown as FleetCleanupStateClient,
    authorities,
    capabilities,
    executions,
  };
}

function scope(overrides: Partial<FleetCleanupExactScope> = {}): FleetCleanupExactScope {
  const fileActionSet = [{
    operation: "DELETE" as const,
    path: ".seorilabs/tag-authority.json",
    expectedMode: "100644" as const,
    expectedBlobSha: "c".repeat(40),
    expectedContentDigest: digest("d"),
    replacementDigest: digest("e"),
    replacementBindingDigest: digest("f"),
    idempotencyKey: digest("1"),
  }];
  return {
    organizationId: "283115031",
    installationId: "142120077",
    issuanceDigest: digest("2"),
    inventoryDigest: digest("3"),
    planDigest: digest("4"),
    repositoryId: "1250442131",
    repositoryFullName: "seorilabs/happy-farm",
    sourceSha: SOURCE_SHA,
    treeSha: TREE_SHA,
    chainHeadDigest: null,
    issueNumber: 7001,
    approvalScopeDigest: digest("5"),
    fileActionSet,
    fileActionSetDigest: digest("6"),
    replacementFiles: [],
    replacementFilesDigest: digest("7"),
    ...overrides,
  };
}

function publicDigest(value: JsonValue): string {
  return `sha256:${jsonDigest(value)}`;
}

function executionRequest(value: FleetCleanupExactScope, overrides: Record<string, unknown> = {}) {
  const executionKey = publicDigest({
    contract: "seorilabs-fleet-cleanup-execution-key-v1",
    issuanceDigest: value.issuanceDigest,
    inventoryDigest: value.inventoryDigest,
    planDigest: value.planDigest,
    repositoryId: value.repositoryId,
    sourceSha: value.sourceSha,
  });
  const steps = ["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"].map((kind) => ({
    kind,
    operationId: publicDigest({
      contract: "seorilabs-fleet-cleanup-operation-v1",
      executionKey,
      kind,
    }),
  }));
  return {
    organizationId: value.organizationId,
    installationId: value.installationId,
    issuanceDigest: value.issuanceDigest,
    inventoryDigest: value.inventoryDigest,
    planDigest: value.planDigest,
    executionKey,
    runId: "fleet-cleanup-test-run-0001",
    workerId: "fleet-cleanup-test-worker-0001",
    repositoryId: value.repositoryId,
    fullName: value.repositoryFullName,
    sourceSha: value.sourceSha,
    issueNumber: value.issueNumber,
    chainHeadDigest: value.chainHeadDigest,
    contract: "seorilabs-fleet-cleanup-state-reservation-v1",
    authorityRevision: `fleet-cleanup-authority-${value.planDigest.slice(7, 27)}`,
    authorityReadbackId: "fleet-cleanup-authority-readback-0001",
    expectedStateGeneration: 1,
    requestedExpiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    steps,
    ...overrides,
  };
}

async function issued(fake: ReturnType<typeof fakeClient>, requestId: string, value = scope()) {
  return issueFleetCleanupCapability({
    requestId,
    approvedBy: "fleet-cleanup-admin-0001",
    ttlSeconds: 900,
    scope: value,
    issuance: { issuanceDigest: value.issuanceDigest },
    plan: { planDigest: value.planDigest },
    client: fake.client,
    now: NOW,
  });
}

test("동일 idempotency는 같은 exact capability를 replay하고 action set drift는 거부한다", async () => {
  const fake = fakeClient();
  const first = await issued(fake, "fleet-cleanup-request-0001");
  const replay = await issued(fake, "fleet-cleanup-request-0001");
  assert.equal(replay.capabilityId, first.capabilityId);
  assert.equal(replay.duplicate, true);
  await assert.rejects(
    issued(fake, "fleet-cleanup-request-0001", scope({ sourceSha: "9".repeat(40) })),
    /FLEET_CLEANUP_CAPABILITY_IDEMPOTENCY_CONFLICT/u,
  );
});

test("동일 authority의 동시 CAS claim은 하나만 성공한다", async () => {
  const fake = fakeClient();
  const value = scope();
  const first = await issued(fake, "fleet-cleanup-request-0002", value);
  const second = await issued(fake, "fleet-cleanup-request-0003", value);
  const firstProvider = createFleetCleanupStateProvider({ capabilityId: first.capabilityId, client: fake.client, now: () => NOW }).provider;
  const secondProvider = createFleetCleanupStateProvider({ capabilityId: second.capabilityId, client: fake.client, now: () => NOW }).provider;
  const result = await Promise.allSettled([
    firstProvider.reserveExecution(executionRequest(value)),
    secondProvider.reserveExecution(executionRequest(value, { runId: "fleet-cleanup-test-run-0002" })),
  ]);
  assert.equal(result.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(result.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(fake.executions.size, 1);
});

test("capability action과 repo/source binding drift를 거부한다", async () => {
  const fake = fakeClient();
  const value = scope();
  const capability = await issued(fake, "fleet-cleanup-request-action", value);
  fake.capabilities.get(capability.capabilityId)!.action = "ARBITRARY_MUTATION";
  const provider = createFleetCleanupStateProvider({ capabilityId: capability.capabilityId, client: fake.client, now: () => NOW }).provider;
  await assert.rejects(provider.readAuthority({
    organizationId: value.organizationId,
    installationId: value.installationId,
    repositoryId: value.repositoryId,
    fullName: value.repositoryFullName,
    sourceSha: value.sourceSha,
    inventoryDigest: value.inventoryDigest,
    planDigest: value.planDigest,
    chainHeadDigest: null,
  }), /FLEET_CLEANUP_CAPABILITY_NOT_ACTIVE/u);
});

test("repo/source binding drift와 stale generation completion을 거부한다", async () => {
  const fake = fakeClient();
  const value = scope();
  const capability = await issued(fake, "fleet-cleanup-request-0004", value);
  const provider = createFleetCleanupStateProvider({ capabilityId: capability.capabilityId, client: fake.client, now: () => NOW }).provider;
  await assert.rejects(provider.readAuthority({
    organizationId: value.organizationId,
    installationId: value.installationId,
    repositoryId: value.repositoryId,
    fullName: value.repositoryFullName,
    sourceSha: "9".repeat(40),
    inventoryDigest: value.inventoryDigest,
    planDigest: value.planDigest,
    chainHeadDigest: null,
  }), /FLEET_CLEANUP_STATE_AUTHORITY_BINDING_MISMATCH/u);
  await assert.rejects(
    provider.reserveExecution(executionRequest(value, { repositoryId: "999999999" })),
    /FLEET_CLEANUP_EXECUTION_BINDING_CONFLICT/u,
  );
  const reservation = await provider.reserveExecution(executionRequest(value));
  assert.ok("leaseToken" in reservation);
  let ledger = await provider.readExecution({ ...executionRequest(value), reservationId: reservation.reservationId });
  for (const step of ledger.steps) {
    ledger = await provider.transitionStep({
      ...executionRequest(value),
      reservationId: reservation.reservationId,
      leaseToken: reservation.leaseToken,
      expectedExecutionGeneration: ledger.executionGeneration,
      expectedStateGeneration: 1,
      reservedStateGeneration: 2,
      kind: step.kind,
      operationId: step.operationId,
      expectedStepState: "PENDING",
      nextStepState: "CONFIRMED",
      receiptDigest: digest("8"),
    });
  }
  assert.equal(ledger.state, "READY_TO_COMPLETE");
  await assert.rejects(provider.completeAndConsume({
    ...executionRequest(value),
    reservationId: reservation.reservationId,
    leaseToken: reservation.leaseToken,
    expectedExecutionGeneration: ledger.executionGeneration,
    expectedStateGeneration: 2,
    reservedStateGeneration: 2,
    receiptDigest: digest("8"),
  }), /FLEET_CLEANUP_COMPLETION_CAS_CONFLICT/u);
});

test("RESULT_UNKNOWN은 readback-first ledger로 남고 resume lease가 이전 lease를 폐기한다", async () => {
  const fake = fakeClient();
  const value = scope();
  const capability = await issued(fake, "fleet-cleanup-request-0005", value);
  const provider = createFleetCleanupStateProvider({ capabilityId: capability.capabilityId, client: fake.client, now: () => NOW }).provider;
  const request = executionRequest(value);
  const reservation = await provider.reserveExecution(request);
  assert.ok("leaseToken" in reservation);
  let ledger = await provider.readExecution({ ...request, reservationId: reservation.reservationId });
  const commit = ledger.steps[0];
  ledger = await provider.transitionStep({
    ...request,
    reservationId: reservation.reservationId,
    leaseToken: reservation.leaseToken,
    expectedExecutionGeneration: ledger.executionGeneration,
    expectedStateGeneration: 1,
    reservedStateGeneration: 2,
    kind: commit.kind,
    operationId: commit.operationId,
    expectedStepState: "PENDING",
    nextStepState: "DISPATCHED",
    receiptDigest: null,
  });
  ledger = await provider.transitionStep({
    ...request,
    reservationId: reservation.reservationId,
    leaseToken: reservation.leaseToken,
    expectedExecutionGeneration: ledger.executionGeneration,
    expectedStateGeneration: 1,
    reservedStateGeneration: 2,
    kind: commit.kind,
    operationId: commit.operationId,
    expectedStepState: "DISPATCHED",
    nextStepState: "RESULT_UNKNOWN",
    receiptDigest: null,
  });
  assert.equal(ledger.state, "RESULT_UNKNOWN");
  const resumed = await provider.reserveExecution(request);
  assert.equal(resumed.state, "RESUME");
  assert.ok("leaseToken" in resumed);
  await assert.rejects(provider.reserveExecution({
    ...request,
    runId: "fleet-cleanup-different-run-0002",
  }), /FLEET_CLEANUP_EXECUTION_BINDING_CONFLICT/u);
  await assert.rejects(provider.transitionStep({
    ...request,
    reservationId: reservation.reservationId,
    leaseToken: reservation.leaseToken,
    expectedExecutionGeneration: ledger.executionGeneration,
    expectedStateGeneration: 1,
    reservedStateGeneration: 2,
    kind: commit.kind,
    operationId: commit.operationId,
    expectedStepState: "RESULT_UNKNOWN",
    nextStepState: "CONFIRMED",
    receiptDigest: digest("8"),
  }), /FLEET_CLEANUP_LEDGER_CAS_CONFLICT/u);
});
