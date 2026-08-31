import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

import {
  createAutomationDefinition,
  executeAutomationCommand,
} from "@/lib/control-plane/automation-service";
import { claimAgentRun } from "@/lib/control-plane/agent-queue";
import { AUTOMATION_TEMPLATE_KEY, SOURCE_REMEDIATION_TEMPLATE_KEY } from "@/lib/control-plane/automation-catalog";
import { createSourceRemediationDefinition } from "@/lib/control-plane/source-remediation";
import { ControlPlaneError } from "@/lib/control-plane/service";

if (process.env.MIGRATION_FIXTURE_ACK !== "LOCAL_SCHEMA_ONLY") {
  throw new Error("MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY가 필요하다");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("source-remediation fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("source-remediation fixture DB 이름은 _contract_test로 끝나야 한다");
}

const prisma = new PrismaClient();
const nonce = crypto.randomUUID();
const actor = `fixture:${nonce}`;
const fixtureRepoIds: bigint[] = [];
const fixtureRepoFullNames: string[] = [];
let baseRepoId = BigInt(`9${Date.now()}0`);
function nextRepoId(): bigint {
  baseRepoId += 1n;
  fixtureRepoIds.push(baseRepoId);
  return baseRepoId;
}

/**
 * P7 catch-22 fixture: classification=PRODUCT_APP로 이미 확정됐지만 discovery가
 * NO_CANDIDATE/BUILD_TARGET_MISSING NEEDS_INPUT인 repository. immunity-war/animal-chess/keeum은
 * ACTIVE App, merge-lizard는 DEPRECATED App으로 자동 claim 배제를 검증한다. 넷 모두 fixture
 * 전용 repoId를 새로 발급하며 실제 GitHub mutation은 수행하지 않는다.
 */
async function planningProductFixture(input: {
  slug: string;
  reasonCode: "NO_CANDIDATE" | "BUILD_TARGET_MISSING";
  sourceSha: string;
  appStatus?: "ACTIVE" | "PAUSED" | "DEPRECATED";
  issueNumber: number;
  issueSource?: "BACKOFFICE" | "CLAUDE_CODE" | "ROUTINE" | "UNKNOWN";
}) {
  const repoId = nextRepoId();
  const repoFullName = `seorilabs/${input.slug}-${nonce}`;
  fixtureRepoFullNames.push(repoFullName);
  const app = await prisma.app.create({
    data: {
      slug: `${input.slug}-${nonce}`,
      displayName: input.slug,
      repoFullName,
      repoId,
      type: "GAME",
      engine: "RN",
      status: input.appStatus ?? "ACTIVE",
      marketTargets: [],
    },
  });
  await prisma.repositoryRegistration.create({
    data: {
      repoId,
      repoFullName,
      defaultBranch: "main",
      status: "NEEDS_INPUT",
      managementKind: "APP",
      classification: "PRODUCT_APP",
      classificationDecisionVersion: 1,
      reconcileGeneration: 3,
      lastDefaultPushSha: input.sourceSha,
      lastReconciledSha: input.sourceSha,
      lastDiscoveryReason: input.reasonCode,
    },
  });
  await prisma.issueMirror.create({
    data: {
      appId: app.id,
      repoFullName,
      number: input.issueNumber,
      nodeId: `fixture-${input.slug}-${nonce}`,
      title: `discovery: ${input.reasonCode} 해소`,
      state: "OPEN",
      assignees: [],
      labels: ["autopilot", "P1"],
      priority: "P1",
      isAutopilot: true,
      source: input.issueSource ?? "BACKOFFICE",
      ghCreatedAt: new Date(),
      ghUpdatedAt: new Date(),
    },
  });
  return { app, repoId, repoFullName };
}

async function main() {
  // immunity-war #30: NO_CANDIDATE, Backoffice가 생성한 issue → verifiedBy 없이 통과해야 한다.
  const immunityWar = await planningProductFixture({
    slug: "immunity-war",
    reasonCode: "NO_CANDIDATE",
    sourceSha: "a".repeat(40),
    issueNumber: 30,
  });
  const created = await createSourceRemediationDefinition({
    repoId: immunityWar.repoId,
    issueNumber: 30,
    agentKind: "CLAUDE",
    budgetCeilingMicros: 500_000,
    maxAttempts: 3,
    actor,
    idempotencyKey: `source-remediation:${nonce}:immunity-war`,
  });
  assert.equal(created.duplicate, false);
  assert.ok(created.runId);
  const definitionRow = await prisma.automationDefinition.findUniqueOrThrow({ where: { id: created.definition.id } });
  assert.equal(definitionRow.template, SOURCE_REMEDIATION_TEMPLATE_KEY);
  assert.equal(definitionRow.schedule, null, "source-remediation은 MANUAL 단발 정의여야 한다");
  const runRow = await prisma.agentRun.findUniqueOrThrow({ where: { id: created.runId! } });
  assert.equal(runRow.repoFullName, immunityWar.repoFullName);
  assert.equal(runRow.issueNumber, 30);
  assert.equal(runRow.workKey, `issue:${immunityWar.repoFullName.toLowerCase()}#30`);
  assert.equal(runRow.createsPr, true);

  // 같은 idempotencyKey 재요청은 새 정의를 만들지 않고 그대로 replay한다.
  const replay = await createSourceRemediationDefinition({
    repoId: immunityWar.repoId,
    issueNumber: 30,
    agentKind: "CLAUDE",
    budgetCeilingMicros: 500_000,
    maxAttempts: 3,
    actor,
    idempotencyKey: `source-remediation:${nonce}:immunity-war`,
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.definition.id, created.definition.id);
  assert.equal(
    await prisma.automationDefinition.count({ where: { appId: immunityWar.app.id } }),
    1,
    "replay가 두 번째 정의를 만들면 안 된다",
  );

  // READY_PR runtime canary는 이 template과 무관하게 전역 fail-closed다 — claim이 성공하면
  // 안 된다(실제 external mutation 배선을 하지 않았다는 회귀 증거).
  const claimAttempt = await claimAgentRun({
    workerId: "claude:seorilabs-generic-worker",
    runtimeBindingDigest: "e".repeat(64),
    agentKind: "CLAUDE",
    leaseSeconds: 300,
    idempotencyKey: `claim:${nonce}:immunity-war`,
  });
  assert.equal(claimAttempt, null, "GitHub READY_PR runtime canary 승인 전에는 claim이 fail-closed여야 한다");
  assert.equal(
    await prisma.agentRepoGuard.findUnique({ where: { runId: created.runId! } }),
    null,
    "차단된 claim은 repo guard도 획득하면 안 된다",
  );

  // animal-chess #12: BUILD_TARGET_MISSING, Backoffice가 아닌 source → verifiedBy 없이는 거부.
  const animalChess = await planningProductFixture({
    slug: "animal-chess",
    reasonCode: "BUILD_TARGET_MISSING",
    sourceSha: "b".repeat(40),
    issueNumber: 12,
    issueSource: "CLAUDE_CODE",
  });
  await assert.rejects(
    createSourceRemediationDefinition({
      repoId: animalChess.repoId,
      issueNumber: 12,
      agentKind: "CODEX",
      budgetCeilingMicros: 500_000,
      maxAttempts: 3,
      actor,
      idempotencyKey: `source-remediation:${nonce}:animal-chess:unverified`,
    }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "SOURCE_REMEDIATION_ISSUE_UNVERIFIED",
  );
  const animalChessCreated = await createSourceRemediationDefinition({
    repoId: animalChess.repoId,
    issueNumber: 12,
    agentKind: "CODEX",
    budgetCeilingMicros: 500_000,
    maxAttempts: 3,
    actor,
    verifiedBy: "magicsih",
    idempotencyKey: `source-remediation:${nonce}:animal-chess:verified`,
  });
  assert.equal(animalChessCreated.duplicate, false);

  // keeum #1: NO_CANDIDATE로 정상 통과 확인 후, discovery가 다시 돌아(재push) generation이
  // 바뀌면 이미 만든 정의로는 claim이 재검증에서 거부된다는 것을 registration CAS로 증명한다.
  const keeum = await planningProductFixture({
    slug: "keeum",
    reasonCode: "NO_CANDIDATE",
    sourceSha: "c".repeat(40),
    issueNumber: 1,
  });
  const keeumCreated = await createSourceRemediationDefinition({
    repoId: keeum.repoId,
    issueNumber: 1,
    agentKind: "CLAUDE",
    budgetCeilingMicros: 500_000,
    maxAttempts: 3,
    actor,
    idempotencyKey: `source-remediation:${nonce}:keeum`,
  });
  assert.equal(keeumCreated.duplicate, false);
  // 새 push로 discovery generation이 전진했다고 가정한다 — 잠긴 policy.discoveryGeneration=3과
  // 더 이상 일치하지 않으므로, 이후 claim(readback 없이)의 첫 조건에서 fail-closed해야 한다.
  await prisma.repositoryRegistration.update({
    where: { repoId: keeum.repoId },
    data: { reconcileGeneration: 4, lastDefaultPushSha: "9".repeat(40), lastReconciledSha: "9".repeat(40) },
  });
  const staleClaim = await claimAgentRun({
    workerId: "claude:seorilabs-generic-worker",
    runtimeBindingDigest: "e".repeat(64),
    agentKind: "CLAUDE",
    leaseSeconds: 300,
    idempotencyKey: `claim:${nonce}:keeum-stale`,
  });
  assert.equal(staleClaim, null, "discovery generation이 바뀌면 이미 만든 source-remediation run도 claim되면 안 된다");

  // merge-lizard #20: App이 DEPRECATED면 애초에 정의를 만들 수 없다(자동 claim 금지).
  const mergeLizard = await planningProductFixture({
    slug: "merge-lizard",
    reasonCode: "NO_CANDIDATE",
    sourceSha: "d".repeat(40),
    appStatus: "DEPRECATED",
    issueNumber: 20,
  });
  await assert.rejects(
    createSourceRemediationDefinition({
      repoId: mergeLizard.repoId,
      issueNumber: 20,
      agentKind: "CODEX",
      budgetCeilingMicros: 500_000,
      maxAttempts: 3,
      actor,
      idempotencyKey: `source-remediation:${nonce}:merge-lizard`,
    }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "APP_NOT_ELIGIBLE",
  );
  assert.equal(
    await prisma.automationDefinition.count({ where: { appId: mergeLizard.app.id } }),
    0,
    "DEPRECATED App은 source-remediation 정의를 하나도 만들면 안 된다",
  );

  // dead-letter 복구: 단발 정의는 두 번 만들 수 없고(DEFINITION_CONFLICT) dead-letter run이
  // workKey를 계속 잡고 있어(SOURCE_REMEDIATION_WORK_ALREADY_CLAIMED) 수동 retry가 유일한
  // 복구 경로다. 이 경로가 막히면 P7 catch-22가 영구화된다.
  await prisma.agentRun.update({
    where: { id: created.runId! },
    data: { status: "DEAD_LETTER", completedAt: new Date(), error: "MAX_ATTEMPTS" },
  });
  await assert.rejects(
    createSourceRemediationDefinition({
      repoId: immunityWar.repoId,
      issueNumber: 30,
      agentKind: "CLAUDE",
      budgetCeilingMicros: 500_000,
      maxAttempts: 3,
      actor,
      idempotencyKey: `source-remediation:${nonce}:immunity-war:recreate`,
    }),
    (error: unknown) => error instanceof ControlPlaneError
      && ["DEFINITION_CONFLICT", "SOURCE_REMEDIATION_WORK_ALREADY_CLAIMED"].includes(error.code ?? ""),
    "dead-letter 뒤 두 번째 정의 생성은 계속 막혀 있어야 한다",
  );
  await executeAutomationCommand({
    definitionId: created.definition.id,
    command: { command: "RETRY_RUN", runId: created.runId! },
    actor,
    requestId: `retry:${nonce}:immunity-war`,
  });
  const retried = await prisma.agentRun.findUniqueOrThrow({ where: { id: created.runId! } });
  assert.equal(retried.status, "PENDING", "dead-letter source-remediation run은 수동 retry로 되살아나야 한다");
  assert.equal(retried.completedAt, null);
  assert.equal(
    retried.maxAttempts,
    3 + 3,
    "retry는 기존 정의의 maxAttempts만큼만 예산을 늘려야 한다",
  );

  // 되살린 뒤에도 claim은 READY_PR runtime canary와 정의가 잠근 source에 계속 묶여 있어야 한다.
  assert.equal(
    await claimAgentRun({
      workerId: "claude:seorilabs-generic-worker",
      runtimeBindingDigest: "e".repeat(64),
      agentKind: "CLAUDE",
      leaseSeconds: 300,
      idempotencyKey: `claim:${nonce}:immunity-war:after-retry`,
    }),
    null,
    "retry가 READY_PR runtime canary gate를 열면 안 된다",
  );

  // 정의 범위 명령은 단발 template에 여전히 닫혀 있다.
  for (const command of ["PAUSE", "RESUME", "RUN_NOW"] as const) {
    await assert.rejects(
      executeAutomationCommand({
        definitionId: created.definition.id,
        command: { command },
        actor,
        requestId: `${command.toLowerCase()}:${nonce}:immunity-war`,
      }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "DEFINITION_CONTRACT_UNMANAGED",
      `${command}은 단발 source-remediation 정의에서 계속 거부돼야 한다`,
    );
  }

  // discovery가 다시 돌아 generation이 전진하면 수동 retry도 같은 이유로 막힌다.
  await prisma.repositoryRegistration.update({
    where: { repoId: immunityWar.repoId },
    data: { reconcileGeneration: 4 },
  });
  await prisma.agentRun.update({
    where: { id: created.runId! },
    data: { status: "DEAD_LETTER", completedAt: new Date(), error: "MAX_ATTEMPTS" },
  });
  await assert.rejects(
    executeAutomationCommand({
      definitionId: created.definition.id,
      command: { command: "RETRY_RUN", runId: created.runId! },
      actor,
      requestId: `retry:${nonce}:immunity-war:stale`,
    }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "REPOSITORY_NOT_MANAGED",
    "정의가 잠근 discovery generation이 바뀌면 retry도 fail-closed여야 한다",
  );
  await prisma.repositoryRegistration.update({
    where: { repoId: immunityWar.repoId },
    data: { reconcileGeneration: 3 },
  });

  // 일반 MANAGED guard는 이 template과 무관하게 그대로다: NEEDS_INPUT repo에서
  // repo-task-autopilot-v1 정의는 여전히 REPOSITORY_NOT_MANAGED로 거부돼야 한다.
  await assert.rejects(
    createAutomationDefinition({
      repoId: immunityWar.repoId,
      template: AUTOMATION_TEMPLATE_KEY,
      agentKind: "CLAUDE",
      cadence: "MANUAL",
      approvalPolicy: "READ_ONLY",
      budgetCeilingMicros: 500_000,
      maxAttempts: 3,
      actor,
      idempotencyKey: `general-guard:${nonce}:immunity-war`,
    }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "REPOSITORY_NOT_MANAGED",
    "source-remediation 도입이 일반 automation-definitions MANAGED guard를 완화하면 안 된다",
  );

  console.log("source-remediation integration 계약 통과");
}

main()
  .finally(async () => {
    try {
      if (fixtureRepoIds.length > 0) {
        await prisma.issueMirror.deleteMany({ where: { repoFullName: { in: fixtureRepoFullNames } } });
        await prisma.repositoryRegistration.deleteMany({ where: { repoId: { in: fixtureRepoIds } } });
        await prisma.app.deleteMany({ where: { repoId: { in: fixtureRepoIds } } });
      }
    } finally {
      await prisma.$disconnect();
    }
  })
  .catch((error: unknown) => {
    console.error("source-remediation integration 실패:", error instanceof Error ? error.message : "unknown");
    process.exit(1);
  });
