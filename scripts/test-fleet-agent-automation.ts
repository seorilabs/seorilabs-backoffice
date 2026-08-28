import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

import {
  cancelAgentRun,
  createAutomationDefinition,
  drainAutomationIngress,
  executeAutomationCommand,
  recordWebhookDelivery,
  retryAgentRun,
} from "@/lib/control-plane/automation-service";
import {
  claimAgentRun,
  resolveAgentRunReadback,
  settleAgentRun,
} from "@/lib/control-plane/agent-queue";
import { automationPolicy } from "@/lib/control-plane/automation-catalog";
import { ControlPlaneError } from "@/lib/control-plane/service";
import {
  durableIngressEnvelopeHash,
  durableRepositoryDiscovery,
  durableStableTagPush,
} from "@/lib/control-plane/automation-inbox";

if (process.env.MIGRATION_FIXTURE_ACK !== "LOCAL_SCHEMA_ONLY") {
  throw new Error("MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY가 필요하다");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("Fleet agent fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("Fleet agent fixture DB 이름은 _contract_test로 끝나야 한다");
}

const prisma = new PrismaClient();
const nonce = crypto.randomUUID();
const actor = `fixture:${nonce}`;
const repoFullName = `seorilabs/p6-fixture-${nonce}`;
const signingKey = "fleet-agent-contract-signing-key";
let fixtureRepoId: bigint | null = null;
process.env.AGENT_MUTATION_CAPABILITY_BROKER_ENFORCED = "true";

async function createRun(input: {
  definitionId: string;
  appId: string;
  issueNumber: number;
  workKey: string;
  createsPr: boolean;
  maxAttempts?: number;
}) {
  return prisma.automationOccurrence.create({
    data: {
      definitionId: input.definitionId,
      scheduledFor: new Date(),
      idempotencyKey: `fixture-occurrence:${crypto.randomUUID()}`,
      triggerKind: "MANUAL",
      triggerKey: `fixture-trigger:${crypto.randomUUID()}`,
      runs: {
        create: {
          appId: input.appId,
          repoFullName,
          issueNumber: input.issueNumber,
          workKey: input.workKey,
          issueState: "OPEN",
          labels: ["autopilot", "P1"],
          createsPr: input.createsPr,
          priority: 1,
          maxAttempts: input.maxAttempts ?? 3,
        },
      },
    },
    include: { runs: true },
  });
}

async function main() {
  const app = await prisma.app.create({
    data: {
      slug: `p6-fixture-${nonce}`,
      displayName: "P6 Fixture",
      repoFullName,
      repoId: BigInt(`9${Date.now()}`),
      type: "APP",
      engine: "RN",
      marketTargets: [],
    },
  });
  fixtureRepoId = app.repoId;
  await prisma.repositoryRegistration.create({
    data: {
      repoId: app.repoId!,
      repoFullName,
      defaultBranch: "main",
      status: "MANAGED",
      managementKind: "APP",
      lastDefaultPushSha: "f".repeat(40),
      lastReconciledSha: "f".repeat(40),
    },
  });
  await prisma.issueMirror.create({
    data: {
      appId: app.id,
      repoFullName,
      number: 1,
      nodeId: `fixture-issue-${nonce}`,
      title: "Fleet agent contract",
      state: "OPEN",
      assignees: [],
      labels: ["autopilot", "P1"],
      priority: "P1",
      isAutopilot: true,
      ghCreatedAt: new Date(),
      ghUpdatedAt: new Date(),
    },
  });

  const readyDefinition = await prisma.automationDefinition.create({
    data: {
      key: `fixture-ready-${nonce}`,
      appId: app.id,
      template: "repo-task-autopilot-v1",
      agentKind: "CODEX",
      configuration: automationPolicy({ approvalPolicy: "READY_PR", budgetCeilingMicros: 100 }),
      maxAttempts: 3,
    },
  });
  const readyOccurrence = await createRun({
    definitionId: readyDefinition.id,
    appId: app.id,
    issueNumber: 1,
    workKey: `${repoFullName}#readback`,
    createsPr: true,
  });
  const firstClaim = await claimAgentRun({
    workerId: "codex:seorilabs-generic-worker",
    agentKind: "CODEX",
    leaseSeconds: 300,
    idempotencyKey: `claim:${crypto.randomUUID()}`,
    signingKey,
  });
  assert.equal(firstClaim?.runId, readyOccurrence.runs[0].id);
  assert.equal(firstClaim.resumeMode, "START");
  await settleAgentRun({
    runId: firstClaim.runId,
    generation: firstClaim.generation,
    leaseToken: firstClaim.leaseToken,
    workerId: "codex:seorilabs-generic-worker",
    outcome: "unknown",
    result: { outcomeCode: "RESULT_UNKNOWN", summary: "PR API response timed out", costMicros: 10 },
    idempotencyKey: `unknown:${crypto.randomUUID()}`,
  });
  const unknown = await prisma.agentRun.findUniqueOrThrow({
    where: { id: firstClaim.runId },
    include: { leases: { orderBy: { generation: "asc" } }, repoGuard: true },
  });
  assert.equal(unknown.status, "FAILED");
  assert.ok(unknown.readbackRequestedAt);
  assert.ok(unknown.leases[0].revokedAt);
  assert.ok(unknown.repoGuard?.activeScopeKey);

  await assert.rejects(
    resolveAgentRunReadback({
      runId: firstClaim.runId,
      generation: firstClaim.generation,
      leaseToken: firstClaim.leaseToken,
      workerId: "codex:seorilabs-generic-worker",
      resolution: "RESUME",
      result: { outcomeCode: "READBACK_CONFIRMED", summary: "No PR exists", costMicros: 0 },
      idempotencyKey: `stale-readback:${crypto.randomUUID()}`,
    }),
    (error) => error instanceof ControlPlaneError && error.code === "READBACK_STATE_CONFLICT",
  );

  const readbackClaim = await claimAgentRun({
    workerId: "codex:seorilabs-generic-worker",
    agentKind: "CODEX",
    leaseSeconds: 300,
    idempotencyKey: `readback-claim:${crypto.randomUUID()}`,
    signingKey,
  });
  assert.equal(readbackClaim?.runId, firstClaim.runId);
  assert.equal(readbackClaim.resumeMode, "READBACK_FIRST");
  assert.equal(readbackClaim.generation, firstClaim.generation + 1);
  assert.equal(readbackClaim.actionCapabilities.includes("github.pull_request.create"), false);
  await resolveAgentRunReadback({
    runId: readbackClaim.runId,
    generation: readbackClaim.generation,
    leaseToken: readbackClaim.leaseToken,
    workerId: "codex:seorilabs-generic-worker",
    resolution: "RESUME",
    result: { outcomeCode: "READBACK_CONFIRMED", summary: "No PR exists", costMicros: 5 },
    idempotencyKey: `readback-resolve:${crypto.randomUUID()}`,
  });
  const resumed = await prisma.agentRun.findUniqueOrThrow({ where: { id: firstClaim.runId } });
  assert.equal(resumed.status, "PENDING");
  assert.equal(resumed.readbackRequestedAt, null);
  assert.equal(resumed.spentMicros, 15n);

  const resumedClaim = await claimAgentRun({
    workerId: "codex:seorilabs-generic-worker",
    agentKind: "CODEX",
    leaseSeconds: 300,
    idempotencyKey: `resumed-claim:${crypto.randomUUID()}`,
    signingKey,
  });
  assert.equal(resumedClaim?.runId, firstClaim.runId);
  assert.equal(resumedClaim.resumeMode, "START");
  assert.equal(resumedClaim.actionCapabilities.includes("github.pull_request.create"), true);
  await settleAgentRun({
    runId: resumedClaim.runId,
    generation: resumedClaim.generation,
    leaseToken: resumedClaim.leaseToken,
    workerId: "codex:seorilabs-generic-worker",
    outcome: "complete",
    result: { outcomeCode: "NO_CHANGES", summary: "No change required", costMicros: 0 },
    idempotencyKey: `complete:${crypto.randomUUID()}`,
  });

  const legacyDefinition = await prisma.automationDefinition.create({
    data: { key: `fixture-legacy-${nonce}`, appId: app.id, template: "legacy", enabled: true },
  });
  await createRun({
    definitionId: legacyDefinition.id,
    appId: app.id,
    issueNumber: 1,
    workKey: `${repoFullName}#legacy`,
    createsPr: true,
  });
  assert.equal(await claimAgentRun({
    workerId: "codex:seorilabs-generic-worker",
    agentKind: "CODEX",
    leaseSeconds: 300,
    idempotencyKey: `legacy-claim:${crypto.randomUUID()}`,
    signingKey,
  }), null);

  const readOnlyDefinition = await prisma.automationDefinition.create({
    data: {
      key: `fixture-read-only-${nonce}`,
      appId: app.id,
      template: "repo-task-autopilot-v1",
      agentKind: "CLAUDE",
      configuration: automationPolicy({ approvalPolicy: "READ_ONLY", budgetCeilingMicros: 100 }),
    },
  });
  const cancelledOccurrence = await createRun({
    definitionId: readOnlyDefinition.id,
    appId: app.id,
    issueNumber: 1,
    workKey: `${repoFullName}#cancelled`,
    createsPr: false,
  });
  await cancelAgentRun({
    runId: cancelledOccurrence.runs[0].id,
    actor,
    requestId: `cancel:${crypto.randomUUID()}`,
  });
  assert.equal((await prisma.agentRun.findUniqueOrThrow({
    where: { id: cancelledOccurrence.runs[0].id },
  })).workKey, null);
  const replacement = await createRun({
    definitionId: readOnlyDefinition.id,
    appId: app.id,
    issueNumber: 1,
    workKey: `${repoFullName}#cancelled`,
    createsPr: false,
  });
  assert.ok(replacement.runs[0].id);

  const retryOccurrence = await createRun({
    definitionId: readOnlyDefinition.id,
    appId: app.id,
    issueNumber: 1,
    workKey: `${repoFullName}#retry`,
    createsPr: false,
  });
  await prisma.$transaction([
    prisma.agentRun.update({
      where: { id: retryOccurrence.runs[0].id },
      data: { status: "DEAD_LETTER", completedAt: new Date(), error: "FIXTURE_FAILURE" },
    }),
    prisma.automationOccurrence.update({
      where: { id: retryOccurrence.id },
      data: { status: "DEAD_LETTER", completedAt: new Date() },
    }),
  ]);
  await retryAgentRun({
    runId: retryOccurrence.runs[0].id,
    actor,
    requestId: `retry:${crypto.randomUUID()}`,
  });
  const retried = await prisma.agentRun.findUniqueOrThrow({ where: { id: retryOccurrence.runs[0].id } });
  assert.equal(retried.status, "PENDING");
  assert.equal(retried.workKey, `${repoFullName}#retry`);
  await cancelAgentRun({ runId: retried.id, actor, requestId: `cancel-retried:${crypto.randomUUID()}` });

  const policyOccurrence = await createRun({
    definitionId: readOnlyDefinition.id,
    appId: app.id,
    issueNumber: 1,
    workKey: `${repoFullName}#policy`,
    createsPr: false,
  });
  const policyClaim = await claimAgentRun({
    workerId: "claude:seorilabs-generic-worker",
    agentKind: "CLAUDE",
    leaseSeconds: 300,
    idempotencyKey: `policy-claim:${crypto.randomUUID()}`,
    signingKey,
  });
  assert.equal(policyClaim?.runId, replacement.runs[0].id);
  await cancelAgentRun({ runId: policyClaim.runId, actor, requestId: `cancel-replacement:${crypto.randomUUID()}` });
  const policyClaim2 = await claimAgentRun({
    workerId: "claude:seorilabs-generic-worker",
    agentKind: "CLAUDE",
    leaseSeconds: 300,
    idempotencyKey: `policy-claim-2:${crypto.randomUUID()}`,
    signingKey,
  });
  assert.equal(policyClaim2?.runId, policyOccurrence.runs[0].id);
  await settleAgentRun({
    runId: policyClaim2.runId,
    generation: policyClaim2.generation,
    leaseToken: policyClaim2.leaseToken,
    workerId: "claude:seorilabs-generic-worker",
    outcome: "complete",
    result: { outcomeCode: "ISSUE_RESOLVED", summary: "Mutation claimed", costMicros: 1 },
    idempotencyKey: `policy-settle:${crypto.randomUUID()}`,
  });
  const policyBlocked = await prisma.agentRun.findUniqueOrThrow({ where: { id: policyClaim2.runId } });
  assert.equal(policyBlocked.status, "DEAD_LETTER");
  assert.equal(policyBlocked.error, "APPROVAL_POLICY_VIOLATION");

  const createRequestId = `definition-create:${crypto.randomUUID()}`;
  const created = await createAutomationDefinition({
    repoId: app.repoId!,
    template: "repo-task-autopilot-v1",
    agentKind: "CODEX",
    cadence: "DAILY",
    approvalPolicy: "READ_ONLY",
    budgetCeilingMicros: 100,
    maxAttempts: 2,
    actor,
    idempotencyKey: createRequestId,
  });
  const replayed = await createAutomationDefinition({
    repoId: app.repoId!,
    template: "repo-task-autopilot-v1",
    agentKind: "CODEX",
    cadence: "DAILY",
    approvalPolicy: "READ_ONLY",
    budgetCeilingMicros: 100,
    maxAttempts: 2,
    actor,
    idempotencyKey: createRequestId,
  });
  assert.equal(replayed.definition.id, created.definition.id);
  assert.equal(replayed.duplicate, true);
  const pauseRequestId = `definition-pause:${crypto.randomUUID()}`;
  await executeAutomationCommand({
    definitionId: created.definition.id,
    command: { command: "PAUSE" },
    actor,
    requestId: pauseRequestId,
  });
  await executeAutomationCommand({
    definitionId: created.definition.id,
    command: { command: "PAUSE" },
    actor,
    requestId: pauseRequestId,
  });
  assert.equal(await prisma.automationMutationRequest.count({
    where: { requestId: { in: [createRequestId, pauseRequestId] }, status: "COMPLETED" },
  }), 2);
  assert.equal(await prisma.auditLog.count({
    where: { actorLogin: actor, action: { in: ["automation.create", "automation.pause"] } },
  }), 2);

  const platformDeliveryId = `platform-release:${crypto.randomUUID()}`;
  const platformTag = durableStableTagPush({
    ref: "refs/tags/v1.2.3",
    created: true,
    deleted: false,
    after: "a".repeat(40),
  });
  assert.ok(platformTag);
  await recordWebhookDelivery({
    deliveryId: platformDeliveryId,
    event: "push",
    repoFullName: "seorilabs/platform",
    stableTagPush: platformTag,
  });
  const platformIngress = await drainAutomationIngress({
    sourceKey: `github:${platformDeliveryId}`,
    limit: 1,
  });
  assert.deepEqual(platformIngress, { scanned: 1, processed: 1, failed: 0, deadLetter: 0 });
  assert.equal((await prisma.automationIngressEvent.findUniqueOrThrow({
    where: { sourceKey: `github:${platformDeliveryId}` },
  })).status, "PROCESSED");
  await assert.rejects(
    recordWebhookDelivery({
      deliveryId: platformDeliveryId,
      event: "push",
      repoFullName: "seorilabs/another-app",
      stableTagPush: platformTag,
    }),
    (error) => error instanceof ControlPlaneError && error.code === "WEBHOOK_DELIVERY_CONFLICT",
  );

  const blockedOccurrence = await createRun({
    definitionId: readyDefinition.id,
    appId: app.id,
    issueNumber: 1,
    workKey: `${repoFullName}#repository-needs-input`,
    createsPr: false,
  });
  await prisma.repositoryRegistration.update({
    where: { repoId: app.repoId! },
    data: { status: "NEEDS_INPUT" },
  });
  assert.equal(await claimAgentRun({
    workerId: "codex:seorilabs-generic-worker",
    agentKind: "CODEX",
    leaseSeconds: 300,
    idempotencyKey: `repository-needs-input:${crypto.randomUUID()}`,
    signingKey,
  }), null, "NEEDS_INPUT repository의 새 작업은 claim할 수 없어야 한다");
  assert.equal((await prisma.agentRun.findUniqueOrThrow({
    where: { id: blockedOccurrence.runs[0].id },
  })).status, "PENDING");

  const discoveryDeliveryId = `repository-discovery:${crypto.randomUUID()}`;
  const staleWebhookRepoFullName = `${repoFullName}-before-rename`;
  const durableDiscovery = durableRepositoryDiscovery({
    event: "push",
    repository: {
      id: Number(app.repoId),
      full_name: staleWebhookRepoFullName,
      name: staleWebhookRepoFullName.split("/")[1],
      default_branch: "main",
      archived: false,
      private: true,
    },
    ref: "refs/heads/main",
    after: "e".repeat(40),
    organization: "seorilabs",
  });
  assert.ok(durableDiscovery);
  const discoverySourceKey = `github:${discoveryDeliveryId}`;
  await prisma.automationIngressEvent.create({
    data: {
      sourceKey: discoverySourceKey,
      event: "push",
      repoFullName: staleWebhookRepoFullName,
      payload: durableDiscovery,
      payloadHash: durableIngressEnvelopeHash({
        sourceKey: discoverySourceKey,
        event: "push",
        action: null,
        repoFullName: staleWebhookRepoFullName,
        payload: durableDiscovery,
      }),
      occurredAt: new Date(),
    },
  });
  const repairedOrphan = await recordWebhookDelivery({
    deliveryId: discoveryDeliveryId,
    event: "push",
    repoFullName: staleWebhookRepoFullName,
    repositoryDiscovery: durableDiscovery,
  });
  assert.equal(repairedOrphan.duplicate, false, "ingress-only orphan은 delivery와 같은 원장으로 복구해야 한다");
  const invalidatedRegistration = await prisma.repositoryRegistration.findUniqueOrThrow({
    where: { repoId: app.repoId! },
  });
  assert.equal(invalidatedRegistration.status, "REGISTERED");
  assert.equal(
    invalidatedRegistration.lastDefaultPushSha,
    "f".repeat(40),
    "서명된 webhook payload는 provider readback 전에는 current source 정본이 아니다",
  );
  assert.equal(await prisma.repositoryDiscoveryRun.count({
    where: { triggerDeliveryId: discoveryDeliveryId },
  }), 0);
  assert.deepEqual(await drainAutomationIngress({ sourceKey: discoverySourceKey, limit: 1 }, {
    repositoryDiscoveryReadback: async (_discovery, sourceKey) => ({
      event: "reconcile",
      action: "provider-readback",
      repository: {
        id: Number(app.repoId),
        full_name: repoFullName,
        name: repoFullName.split("/")[1],
        default_branch: "main",
        archived: false,
        private: true,
      },
      after: "e".repeat(40),
      deliveryId: `fixture-readback:${crypto.createHash("sha256").update(sourceKey).digest("hex")}`,
      organization: "seorilabs",
    }),
  }), {
    scanned: 1,
    processed: 1,
    failed: 0,
    deadLetter: 0,
  });
  const providerReadRegistration = await prisma.repositoryRegistration.findUniqueOrThrow({
    where: { repoId: app.repoId! },
  });
  assert.equal(providerReadRegistration.status, "REGISTERED");
  assert.equal(
    providerReadRegistration.repoFullName,
    repoFullName,
    "순서가 뒤집힌 rename/push payload가 provider readback보다 우선해서는 안 된다",
  );
  assert.equal(providerReadRegistration.lastDefaultPushSha, "e".repeat(40));
  assert.equal(await prisma.repositoryDiscoveryRun.count({
    where: { sourceSha: "e".repeat(40), repoId: app.repoId! },
  }), 1);

  console.log("Fleet agent automation integration 계약 통과");
}

main()
  .finally(async () => {
    try {
      if (fixtureRepoId !== null) {
        await prisma.repositoryRegistration.deleteMany({ where: { repoId: fixtureRepoId } });
      }
    } finally {
      await prisma.$disconnect();
    }
  })
  .catch((error: unknown) => {
    console.error("Fleet agent automation integration 실패:", error instanceof Error ? error.message : "unknown");
    process.exit(1);
  });
