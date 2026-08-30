import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

import type {
  FleetStandardLabelApplyReceipt,
  FleetStandardLabelGithubTransport,
} from "@/lib/control-plane/fleet-standard-label-github-adapter";
import {
  FLEET_STANDARD_LABEL_ACTION,
  normalizeFleetRepositoryLabels,
  parseFleetStandardLabelContract,
  type FleetRepositoryLabel,
  type FleetStandardLabelOperation,
} from "@/lib/control-plane/fleet-standard-labels";
import {
  applyFleetStandardLabels,
  FLEET_STANDARD_LABEL_AUTOMATION_POLICY,
  planFleetStandardLabels,
} from "@/lib/control-plane/fleet-standard-label-service";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

if (process.env.MIGRATION_FIXTURE_ACK !== "LOCAL_SCHEMA_ONLY") {
  throw new Error("MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY가 필요하다");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("Fleet standard label fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("Fleet standard label fixture DB 이름은 _contract_test로 끝나야 한다");
}

const prisma = new PrismaClient();
const nonce = crypto.randomUUID();
const actor = `fixture:fleet-standard-label:${nonce}`;
const baseRepositoryId = BigInt(`8${Date.now()}`);
const repositoryIds = [baseRepositoryId, baseRepositoryId + 1n, baseRepositoryId + 2n];
const repositoryNames = repositoryIds.map((_, index) => `seorilabs/label-fixture-${index}-${nonce}`);
const requestIds: string[] = [];

const catalog = {
  schemaVersion: 1 as const,
  catalogVersion: "fixture-standard-labels/v1",
  strategy: "UPSERT_FIXED_PRESERVE_CUSTOM" as const,
  labels: [
    { name: "P1", color: "B60205", description: "최우선" },
    { name: "autopilot", color: "EDEDED", description: "자동 처리" },
  ],
};
const catalogDigest = `sha256:${jsonDigest(catalog as unknown as JsonValue)}`;
const sourceConfig = {
  repositoryId: "101",
  repositoryFullName: "seorilabs/.github" as const,
  sourceSha: "a".repeat(40),
  catalogPath: "contracts/fleet-standard-labels.json" as const,
  catalogBlobSha: "b".repeat(40),
  expectedCatalogDigest: catalogDigest,
  packageExport: "@seorilabs/repo-contract/standard-labels" as const,
};
const contract = parseFleetStandardLabelContract({
  config: sourceConfig,
  blobSha: sourceConfig.catalogBlobSha,
  text: JSON.stringify(catalog),
});

class FixtureTransport implements FleetStandardLabelGithubTransport {
  labels = new Map<string, FleetRepositoryLabel[]>();
  reads = 0;
  ensureCalls = 0;
  failAfterFirstMutation = new Set<string>();

  async readContract() {
    return contract;
  }

  private observation(repositoryId: string, operation: FleetStandardLabelOperation) {
    return normalizeFleetRepositoryLabels({
      operation,
      labels: this.labels.get(repositoryId) ?? [],
    });
  }

  async readRepository(input: {
    repositoryId: string;
    repositoryFullName: string;
    operation: FleetStandardLabelOperation;
  }) {
    this.reads += 1;
    const normalized = this.observation(input.repositoryId, input.operation);
    return {
      identity: {
        repositoryId: input.repositoryId,
        repositoryFullName: input.repositoryFullName,
        archived: false as const,
        private: input.repositoryId !== repositoryIds[0].toString(),
      },
      labels: normalized.labels,
      observation: normalized.observation,
    };
  }

  async ensureRepository(input: {
    repositoryId: string;
    repositoryFullName: string;
    operation: FleetStandardLabelOperation;
    assertLease: () => Promise<void>;
  }): Promise<FleetStandardLabelApplyReceipt> {
    this.ensureCalls += 1;
    const before = this.observation(input.repositoryId, input.operation);
    const labels = [...before.labels];
    const expected = input.operation.payload.labels;
    let mutations = 0;
    for (const label of expected) {
      await input.assertLease();
      const index = labels.findIndex((candidate) => (
        candidate.name.toLocaleLowerCase("en-US") === label.name.toLocaleLowerCase("en-US")
      ));
      if (index < 0) labels.push({ ...label });
      else labels[index] = { ...label };
      mutations += 1;
      this.labels.set(input.repositoryId, structuredClone(labels));
      if (this.failAfterFirstMutation.delete(input.repositoryId)) {
        throw new Error("FLEET_STANDARD_LABEL_APPLY_RESULT_UNKNOWN");
      }
    }
    await input.assertLease();
    const after = this.observation(input.repositoryId, input.operation);
    assert.equal(after.observation.state, "MATCH");
    return {
      action: FLEET_STANDARD_LABEL_ACTION,
      repositoryId: input.repositoryId,
      repositoryFullName: input.repositoryFullName,
      catalogVersion: input.operation.payload.catalogVersion,
      catalogDigest: input.operation.payload.catalogDigest,
      method: "UPSERT_FIXED_LABELS_PRESERVE_CUSTOM",
      state: mutations === 0 ? "UNCHANGED" : "UPDATED",
      mutations,
      beforeReadbackDigest: before.observation.readbackDigest,
      afterReadbackDigest: after.observation.readbackDigest,
      customLabelsDigest: after.observation.customLabelsDigest,
    };
  }
}

const transport = new FixtureTransport();

function dependencies() {
  return {
    client: prisma as never,
    transport,
    now: () => new Date(),
  };
}

function requestId(label: string): string {
  const value = `fleet-label-fixture:${label}:${nonce}`;
  requestIds.push(value);
  return value;
}

async function createRegistration(index: number, status: "MANAGED" | "NEEDS_INPUT") {
  await prisma.repositoryRegistration.create({
    data: {
      repoId: repositoryIds[index],
      repoFullName: repositoryNames[index],
      defaultBranch: index === 1 ? null : "main",
      archived: false,
      status,
      managementKind: status === "MANAGED" ? "APP" : "UNCLASSIFIED",
      reconcileGeneration: index + 1,
    },
  });
}

async function main(): Promise<void> {
  process.env.FLEET_STANDARD_LABELS_CONTRACT_REPOSITORY_ID = sourceConfig.repositoryId;
  process.env.FLEET_STANDARD_LABELS_CONTRACT_SOURCE_SHA = sourceConfig.sourceSha;
  process.env.FLEET_STANDARD_LABELS_CATALOG_BLOB_SHA = sourceConfig.catalogBlobSha;
  process.env.FLEET_STANDARD_LABELS_CATALOG_DIGEST = sourceConfig.expectedCatalogDigest;

  await createRegistration(0, "MANAGED");
  await createRegistration(1, "NEEDS_INPUT");
  transport.labels.set(repositoryIds[0].toString(), [
    { name: "P1", color: "FFFFFF", description: "wrong" },
    { name: "custom", color: "ABCDEF", description: "보존" },
  ]);
  transport.labels.set(repositoryIds[1].toString(), [
    ...catalog.labels,
    { name: "custom", color: "123456", description: "보존" },
  ]);

  const planKey = requestId("plan-initial");
  const plan = await planFleetStandardLabels({ actor, idempotencyKey: planKey }, dependencies());
  assert.equal(plan.cohortCount, 2);
  assert.equal(plan.drift, 1);
  assert.equal(plan.match, 1);
  assert.equal(plan.mutationAttempted, false);
  assert.equal(transport.ensureCalls, 0);

  const readsAfterPlan = transport.reads;
  const replayedPlan = await planFleetStandardLabels({ actor, idempotencyKey: planKey }, dependencies());
  assert.equal(replayedPlan.planId, plan.planId);
  assert.equal(replayedPlan.duplicate, true);
  assert.equal(transport.reads, readsAfterPlan, "동일 plan idempotency replay는 provider를 다시 읽지 않아야 한다");

  const definition = await prisma.automationDefinition.findUniqueOrThrow({
    where: { key: "fleet-standard-label-reconcile-v1:deterministic" },
  });
  assert.equal(definition.agentKind, null);
  assert.equal(definition.template, "fleet-standard-label-reconcile-v1");
  assert.deepEqual(definition.configuration, FLEET_STANDARD_LABEL_AUTOMATION_POLICY);
  const initialRuns = await prisma.agentRun.findMany({ where: { occurrenceId: plan.planId } });
  assert.equal(initialRuns.length, 2);
  assert.equal(initialRuns.every((run) => !run.createsPr && run.issueNumber === null), true);
  assert.equal(JSON.stringify(initialRuns).includes("github.standard-labels.ensure"), true);
  assert.doesNotMatch(JSON.stringify(initialRuns), /pull_request\.create|permission|role|release|provider\.write/iu);

  const applyKey = requestId("apply-initial");
  const applied = await applyFleetStandardLabels({
    actor,
    idempotencyKey: applyKey,
    planId: plan.planId,
    planDigest: plan.planDigest,
  }, dependencies());
  assert.equal(applied.state, "completed");
  assert.equal(applied.verified, 1);
  assert.equal(applied.replayed, 1);
  assert.equal(applied.mutationAttempted, true);
  assert.equal(transport.ensureCalls, 1);
  assert.deepEqual(transport.labels.get(repositoryIds[0].toString()), [
    { name: "P1", color: "B60205", description: "최우선" },
    { name: "custom", color: "ABCDEF", description: "보존" },
    { name: "autopilot", color: "EDEDED", description: "자동 처리" },
  ]);
  const ensureAfterApply = transport.ensureCalls;
  const replayedApply = await applyFleetStandardLabels({
    actor,
    idempotencyKey: applyKey,
    planId: plan.planId,
    planDigest: plan.planDigest,
  }, dependencies());
  assert.equal(replayedApply.planId, plan.planId);
  assert.equal(replayedApply.duplicate, true);
  assert.equal(transport.ensureCalls, ensureAfterApply, "동일 apply idempotency replay는 mutation을 반복하지 않아야 한다");

  transport.labels.set(repositoryIds[0].toString(), [
    { name: "P1", color: "000000", description: "drift again" },
  ]);
  const stalePlan = await planFleetStandardLabels({
    actor,
    idempotencyKey: requestId("plan-stale"),
  }, dependencies());
  await prisma.repositoryRegistration.updateMany({
    where: { repoId: { in: [repositoryIds[0], repositoryIds[1]] } },
    data: { reconcileGeneration: { increment: 1 } },
  });
  const ensureBeforeStale = transport.ensureCalls;
  const staleApply = await applyFleetStandardLabels({
    actor,
    idempotencyKey: requestId("apply-stale"),
    planId: stalePlan.planId,
    planDigest: stalePlan.planDigest,
  }, dependencies());
  assert.equal(staleApply.stale, 2, "이미 성공한 run도 registration generation이 바뀌면 재사용하면 안 된다");
  assert.equal(transport.ensureCalls, ensureBeforeStale, "registration generation drift에서는 mutation하면 안 된다");
  const staleOccurrence = await prisma.automationOccurrence.findUniqueOrThrow({
    where: { id: stalePlan.planId },
  });
  assert.equal(staleOccurrence.status, "DEAD_LETTER");
  assert.equal((staleOccurrence.result as Record<string, unknown>).cohortDigest, stalePlan.cohortDigest);
  assert.deepEqual(
    (staleOccurrence.result as Record<string, unknown>).contract,
    stalePlan.contract,
    "occurrence 정산은 immutable plan provenance를 보존해야 한다",
  );

  await createRegistration(2, "NEEDS_INPUT");
  transport.labels.set(repositoryIds[0].toString(), [...catalog.labels]);
  transport.labels.set(repositoryIds[2].toString(), []);
  const unknownPlan = await planFleetStandardLabels({
    actor,
    idempotencyKey: requestId("plan-unknown"),
  }, dependencies());
  transport.failAfterFirstMutation.add(repositoryIds[2].toString());
  const unknownApply = await applyFleetStandardLabels({
    actor,
    idempotencyKey: requestId("apply-unknown"),
    planId: unknownPlan.planId,
    planDigest: unknownPlan.planDigest,
  }, dependencies());
  assert.equal(unknownApply.readbackFirst, 1);
  const unknownRun = await prisma.agentRun.findFirstOrThrow({
    where: { occurrenceId: unknownPlan.planId, repoFullName: repositoryNames[2] },
  });
  assert.equal(unknownRun.status, "FAILED");
  assert.ok(unknownRun.readbackRequestedAt);
  const resumed = await applyFleetStandardLabels({
    actor,
    idempotencyKey: requestId("apply-resume"),
    planId: unknownPlan.planId,
    planDigest: unknownPlan.planDigest,
  }, dependencies());
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.verified, 1);
  const events = await prisma.agentRunEvent.findMany({ where: { runId: unknownRun.id } });
  assert.equal(events.some((event) => event.type === "readback_required"), true);
  assert.equal(events.some((event) => event.type === "readback_claimed"), true);
  assert.equal(events.some((event) => event.type === "completed"), true);

  const audit = await prisma.auditLog.findMany({ where: { actorLogin: actor } });
  assert.equal(audit.some((row) => row.action === "fleet.standard-labels.plan"), true);
  assert.equal(audit.some((row) => row.action === "fleet.standard-labels.apply"), true);
  assert.doesNotMatch(JSON.stringify(audit), /token|authorization|private.?key|leaseToken/iu);
}

main()
  .then(() => console.log("fleet standard label trusted transport 계약 통과"))
  .finally(async () => {
    const definition = await prisma.automationDefinition.findUnique({
      where: { key: "fleet-standard-label-reconcile-v1:deterministic" },
    });
    if (definition) await prisma.automationDefinition.delete({ where: { id: definition.id } });
    await prisma.repositoryRegistration.deleteMany({ where: { repoId: { in: repositoryIds } } });
    await prisma.automationMutationRequest.deleteMany({ where: { requestId: { in: requestIds } } });
    await prisma.auditLog.deleteMany({ where: { actorLogin: actor } });
    await prisma.$disconnect();
  });
