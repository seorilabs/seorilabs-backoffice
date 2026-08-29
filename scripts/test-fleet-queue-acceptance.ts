import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

import {
  claimAgentRun,
  settleAgentRun,
} from "@/lib/control-plane/agent-queue";
import { automationPolicy } from "@/lib/control-plane/automation-catalog";
import { scheduleDueAutomations } from "@/lib/control-plane/automation-service";
import { ControlPlaneError } from "@/lib/control-plane/service";

if (process.env.MIGRATION_FIXTURE_ACK !== "LOCAL_SCHEMA_ONLY") {
  throw new Error("MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY가 필요하다");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("P6 queue acceptance DB는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("P6 queue acceptance DB 이름은 _contract_test로 끝나야 한다");
}

const prisma = new PrismaClient();
const nonce = crypto.randomUUID();
const repoFullName = `seorilabs/p6-queue-acceptance-${nonce}`;
const runtimeBindingDigest = "e".repeat(64);
const firstWorker = "codex:p6-acceptance-a";
const secondWorker = "codex:p6-acceptance-b";
const reclaimedWorker = "codex:p6-acceptance-reclaim";
let fixtureRepoId: bigint | null = null;

async function createIssue(appId: string, number: number) {
  return prisma.issueMirror.create({
    data: {
      appId,
      repoFullName,
      number,
      nodeId: `p6-acceptance-issue-${number}:${nonce}`,
      title: `P6 queue acceptance ${number}`,
      state: "OPEN",
      assignees: [],
      labels: ["autopilot", "P1"],
      priority: "P1",
      isAutopilot: true,
      ghCreatedAt: new Date("2026-08-25T00:00:00.000Z"),
      ghUpdatedAt: new Date("2026-08-25T00:00:00.000Z"),
    },
  });
}

async function createDefinition(input: {
  appId: string;
  suffix: string;
  schedule?: string;
  createdAt?: Date;
}) {
  return prisma.automationDefinition.create({
    data: {
      key: `p6-queue-acceptance-${input.suffix}:${nonce}`,
      appId: input.appId,
      template: "repo-task-autopilot-v1",
      schedule: input.schedule,
      agentKind: "CODEX",
      configuration: automationPolicy({ approvalPolicy: "READ_ONLY", budgetCeilingMicros: 1_000 }),
      maxAttempts: 3,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
}

async function createManualRun(input: {
  appId: string;
  definitionId: string;
  issueNumber: number;
}) {
  const occurrence = await prisma.automationOccurrence.create({
    data: {
      definitionId: input.definitionId,
      scheduledFor: new Date("2026-08-29T00:00:00.000Z"),
      idempotencyKey: `p6-queue-acceptance-manual:${nonce}`,
      triggerKind: "MANUAL",
      triggerKey: `p6-queue-acceptance-manual:${nonce}`,
      runs: {
        create: {
          appId: input.appId,
          repoFullName,
          issueNumber: input.issueNumber,
          workKey: `issue:${repoFullName.toLowerCase()}#${input.issueNumber}`,
          issueState: "OPEN",
          labels: ["autopilot", "P1"],
          createsPr: false,
          priority: 1,
          maxAttempts: 3,
        },
      },
    },
    include: { runs: true },
  });
  return occurrence.runs[0];
}

async function main() {
  const app = await prisma.app.create({
    data: {
      slug: `p6-queue-acceptance-${nonce}`,
      displayName: "P6 Queue Acceptance",
      repoFullName,
      repoId: BigInt(`8${Date.now()}`),
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

  await createIssue(app.id, 1);
  const claimDefinition = await createDefinition({ appId: app.id, suffix: "claim" });
  const run = await createManualRun({
    appId: app.id,
    definitionId: claimDefinition.id,
    issueNumber: 1,
  });
  // DB와 Node의 현재 시각이 수 ms 어긋나도 freshly inserted eligibleAt 이후여야 한다.
  const firstNow = new Date(Date.now() + 1_000);
  const concurrentClaims = await Promise.all([
    claimAgentRun({
      workerId: firstWorker,
      runtimeBindingDigest,
      agentKind: "CODEX",
      leaseSeconds: 1,
      idempotencyKey: `p6-claim-a:${nonce}`,
      now: firstNow,
    }),
    claimAgentRun({
      workerId: secondWorker,
      runtimeBindingDigest,
      agentKind: "CODEX",
      leaseSeconds: 1,
      idempotencyKey: `p6-claim-b:${nonce}`,
      now: firstNow,
    }),
  ]);
  const successfulClaims = concurrentClaims.filter((claim) => claim !== null);
  assert.equal(successfulClaims.length, 1, "실제 MySQL 동시 claim 중 하나만 성공해야 한다");
  const firstClaim = successfulClaims[0]!;
  assert.equal(firstClaim.runId, run.id);
  assert.equal(firstClaim.generation, 1);

  const reclaimNow = new Date(firstNow.getTime() + 2_000);
  const reclaimed = await claimAgentRun({
    workerId: reclaimedWorker,
    runtimeBindingDigest,
    agentKind: "CODEX",
    leaseSeconds: 300,
    idempotencyKey: `p6-reclaim:${nonce}`,
    now: reclaimNow,
  });
  assert.equal(reclaimed?.runId, run.id);
  assert.equal(reclaimed.generation, 2, "TTL 재claim은 generation을 증가시켜야 한다");

  let staleCompletionCode: string | null = null;
  await assert.rejects(
    settleAgentRun({
      sessionId: firstClaim.sessionId,
      workerId: firstClaim === concurrentClaims[0] ? firstWorker : secondWorker,
      runtimeBindingDigest,
      outcome: "complete",
      result: { outcomeCode: "NO_CHANGES", summary: "stale generation", costMicros: 0 },
      idempotencyKey: `p6-stale-completion:${nonce}`,
      now: reclaimNow,
    }),
    (error) => {
      staleCompletionCode = error instanceof ControlPlaneError ? error.code : null;
      return staleCompletionCode === "STALE_LEASE";
    },
  );
  await settleAgentRun({
    sessionId: reclaimed.sessionId,
    workerId: reclaimedWorker,
    runtimeBindingDigest,
    outcome: "complete",
    result: { outcomeCode: "NO_CHANGES", summary: "current generation", costMicros: 0 },
    idempotencyKey: `p6-current-completion:${nonce}`,
    now: reclaimNow,
  });

  await createIssue(app.id, 2);
  const oneSlotDefinition = await createDefinition({
    appId: app.id,
    suffix: "one-slot",
    schedule: "0 0 * * *",
    createdAt: new Date("2026-08-28T12:00:00.000Z"),
  });
  const oneSlotNow = new Date("2026-08-29T00:30:00.000Z");
  await Promise.all([
    scheduleDueAutomations({ now: oneSlotNow, perDefinitionLimit: 1 }),
    scheduleDueAutomations({ now: oneSlotNow, perDefinitionLimit: 1 }),
  ]);
  const oneSlotCounts = {
    occurrences: await prisma.automationOccurrence.count({
      where: { definitionId: oneSlotDefinition.id, triggerKind: "SCHEDULE" },
    }),
    runs: await prisma.agentRun.count({
      where: { occurrence: { definitionId: oneSlotDefinition.id, triggerKind: "SCHEDULE" } },
    }),
  };
  assert.deepEqual(oneSlotCounts, { occurrences: 1, runs: 1 }, "동일 schedule/idempotency는 occurrence와 run을 하나만 생성해야 한다");

  await createIssue(app.id, 3);
  const catchUpDefinition = await createDefinition({
    appId: app.id,
    suffix: "catch-up",
    schedule: "0 0 * * *",
    createdAt: new Date("2026-08-25T01:00:00.000Z"),
  });
  const catchUpNow = new Date("2026-08-28T12:30:00.000Z");
  await Promise.all([
    scheduleDueAutomations({ now: catchUpNow }),
    scheduleDueAutomations({ now: catchUpNow }),
  ]);
  const catchUpCounts = {
    occurrences: await prisma.automationOccurrence.count({
      where: { definitionId: catchUpDefinition.id, triggerKind: "SCHEDULE" },
    }),
    runs: await prisma.agentRun.count({
      where: { occurrence: { definitionId: catchUpDefinition.id, triggerKind: "SCHEDULE" } },
    }),
  };
  assert.deepEqual(catchUpCounts, { occurrences: 3, runs: 1 }, "누락 slot은 각각 한 번만 복구되어야 한다");
  await Promise.all([
    scheduleDueAutomations({ now: catchUpNow }),
    scheduleDueAutomations({ now: catchUpNow }),
  ]);
  assert.deepEqual({
    occurrences: await prisma.automationOccurrence.count({
      where: { definitionId: catchUpDefinition.id, triggerKind: "SCHEDULE" },
    }),
    runs: await prisma.agentRun.count({
      where: { occurrence: { definitionId: catchUpDefinition.id, triggerKind: "SCHEDULE" } },
    }),
  }, catchUpCounts, "catch-up 재실행은 occurrence와 run을 중복 생성하지 않아야 한다");

  console.log(JSON.stringify({
    contract: "P6_DURABLE_QUEUE_ACCEPTANCE",
    concurrentClaim: { runId: run.id, successCount: successfulClaims.length },
    leaseReclaim: {
      runId: run.id,
      previousGeneration: firstClaim.generation,
      currentGeneration: reclaimed.generation,
      staleCompletionCode,
    },
    scheduleIdempotency: { definitionId: oneSlotDefinition.id, ...oneSlotCounts },
    missedScheduleCatchUp: { definitionId: catchUpDefinition.id, ...catchUpCounts },
  }));
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
    console.error("P6 durable queue acceptance 실패:", error instanceof Error ? error.message : "unknown");
    process.exit(1);
  });
