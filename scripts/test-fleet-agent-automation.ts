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
  scheduleDueAutomations,
} from "@/lib/control-plane/automation-service";
import {
  claimAgentRun,
  heartbeatAgentRun,
  reconcileTerminalRepoGuards,
  resolveAgentRunReadback,
  settleAgentRun,
} from "@/lib/control-plane/agent-queue";
import {
  authorizeGithubReadyPrMutation,
  claimGithubMutationRecovery,
  claimGithubMutationStep,
  completeGithubMutationStep,
  GITHUB_READY_PR_MUTATION_ACTION,
  planGithubCommitMutationStep,
  recordGithubMutationReadback,
} from "@/lib/control-plane/agent-mutation-service";
import { automationPolicy } from "@/lib/control-plane/automation-catalog";
import {
  agentGithubMutationStepObservationSchema,
  agentGithubObservationSchema,
} from "@/lib/control-plane/contracts";
import { githubInstallationProviderPayload } from "@/lib/control-plane/github-installation-observation";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
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
const CODEX_RUNTIME_BINDING = "c".repeat(64);
const CLAUDE_RUNTIME_BINDING = "d".repeat(64);
const actor = `fixture:${nonce}`;
const repoFullName = `seorilabs/p6-fixture-${nonce}`;
let fixtureRepoId: bigint | null = null;
process.env.AGENT_TRUSTED_ADAPTER_PRINCIPAL = "seori-auth:github-mutation-adapter";
process.env.AGENT_TRUSTED_ADAPTER_RUNTIME_IDENTITY = "fixture:rpi5:github-adapter";
process.env.AGENT_TRUSTED_ADAPTER_TOKEN = "fixture-distinct-adapter-token";
process.env.AGENT_TRUSTED_ADAPTER_PUBLIC_KEY = crypto.generateKeyPairSync("ed25519").publicKey.export({
  type: "spki",
  format: "pem",
}).toString();

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

async function openFixtureMutationSession(input: {
  runId: string;
  occurrenceId: string;
  issueNumber: number;
  expectedStatus: "PENDING" | "FAILED";
  expectedGeneration: number;
  generation: number;
  now: Date;
  createRepoGuard: boolean;
  incrementAttempts: boolean;
  requireReadback: boolean;
}) {
  if (fixtureRepoId === null) throw new Error("fixture repo가 준비되지 않았다");
  return prisma.$transaction(async (tx) => {
    const changed = await tx.agentRun.updateMany({
      where: {
        id: input.runId,
        status: input.expectedStatus,
        leaseGeneration: input.expectedGeneration,
        ...(input.requireReadback ? { readbackRequestedAt: { not: null } } : { readbackRequestedAt: null }),
      },
      data: {
        status: "RUNNING",
        leaseGeneration: input.generation,
        ...(input.incrementAttempts ? { attempts: { increment: 1 } } : {}),
        startedAt: input.now,
        error: null,
      },
    });
    assert.equal(changed.count, 1, "fixture mutation session 상태 전이가 유일해야 한다");
    const activeScopeKey = `repo-pr:${repoFullName.toLowerCase()}`;
    if (input.createRepoGuard) {
      await tx.agentRepoGuard.create({
        data: {
          runId: input.runId,
          repoFullName,
          activeScopeKey,
          acquiredAt: input.now,
        },
      });
    } else {
      const guard = await tx.agentRepoGuard.findUnique({ where: { runId: input.runId } });
      assert.equal(guard?.activeScopeKey, activeScopeKey, "복구 session은 기존 repo guard를 유지해야 한다");
    }
    const expiresAt = new Date(input.now.getTime() + 300_000);
    const lease = await tx.agentLease.create({
      data: {
        runId: input.runId,
        generation: input.generation,
        tokenHash: crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex"),
        workerId: "codex:seorilabs-generic-worker",
        scopeKey: activeScopeKey,
        expiresAt,
        heartbeatAt: input.now,
      },
    });
    const session = await tx.agentWorkerSession.create({
      data: {
        id: `agent-session:${crypto.randomUUID()}`,
        leaseId: lease.id,
        runId: input.runId,
        generation: input.generation,
        principalId: "codex:seorilabs-generic-worker",
        runtimeBindingDigest: CODEX_RUNTIME_BINDING,
        repoId: fixtureRepoId!,
        repoFullName,
        issueNumber: input.issueNumber,
        sourceSha: "f".repeat(40),
        expiresAt,
        heartbeatAt: input.now,
      },
    });
    await tx.automationOccurrence.update({
      where: { id: input.occurrenceId },
      data: { status: "RUNNING", completedAt: null },
    });
    await tx.agentRunEvent.create({
      data: {
        runId: input.runId,
        type: "claimed",
        generation: input.generation,
        actor: "codex:seorilabs-generic-worker",
        payload: {
          sessionId: session.id,
          resumeMode: input.requireReadback ? "READBACK_FIRST" : "START",
          repoId: fixtureRepoId!.toString(),
          sourceSha: "f".repeat(40),
          runtimeBindingDigest: CODEX_RUNTIME_BINDING,
        },
      },
    });
    return { sessionId: session.id, runId: input.runId, generation: input.generation, expiresAt };
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
  const githubInstallation = githubInstallationProviderPayload({
    installationId: "101",
    appId: "202",
    targetId: "303",
    accountLogin: "seorilabs",
    targetType: "Organization",
    repositorySelection: "all",
    suspended: false,
    permissions: {
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      workflows: "write",
      issues: "write",
      checks: "write",
      actions: "write",
      environments: "write",
      organization_actions_variables: "write",
      organization_secrets: "write",
      organization_custom_properties: "admin",
      organization_projects: "write",
      organization_administration: "write",
    },
    events: ["push", "repository", "pull_request", "issues", "issue_comment", "workflow_run"],
  }, "seorilabs");
  await prisma.providerObservation.create({
    data: {
      appId: app.id,
      provider: "github",
      resourceType: "github-app-installation",
      resourceId: githubInstallation.attributes.installationId,
      payload: githubInstallation,
      payloadHash: jsonDigest(githubInstallation as JsonValue),
      idempotencyKey: `fixture-github-installation:${nonce}`,
      observedBy: "fixture:github-installation-readback",
      observedAt: new Date(),
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
    workKey: `${repoFullName}#ready-pr-disabled`,
    createsPr: false,
  });
  assert.equal(await claimAgentRun({
    workerId: "codex:seorilabs-generic-worker",
    runtimeBindingDigest: CODEX_RUNTIME_BINDING,
    agentKind: "CODEX",
    leaseSeconds: 300,
    idempotencyKey: `ready-pr-disabled:${crypto.randomUUID()}`,
  }), null, "실제 GitHub canary 승인 전에는 READY_PR claim이 fail-closed여야 한다");
  assert.equal(await prisma.agentRepoGuard.findUnique({
    where: { runId: readyOccurrence.runs[0].id },
  }), null, "차단된 READY_PR claim은 repo guard도 획득하지 않아야 한다");

  const codexReadOnlyDefinition = await prisma.automationDefinition.create({
    data: {
      key: `fixture-codex-read-only-${nonce}`,
      appId: app.id,
      template: "repo-task-autopilot-v1",
      agentKind: "CODEX",
      configuration: automationPolicy({ approvalPolicy: "READ_ONLY", budgetCeilingMicros: 100 }),
    },
  });
  const readbackOccurrence = await createRun({
    definitionId: codexReadOnlyDefinition.id,
    appId: app.id,
    issueNumber: 1,
    workKey: `${repoFullName}#readback`,
    createsPr: true,
  });
  const firstClaim = await claimAgentRun({
    workerId: "codex:seorilabs-generic-worker",
    runtimeBindingDigest: CODEX_RUNTIME_BINDING,
    agentKind: "CODEX",
    leaseSeconds: 300,
    idempotencyKey: `claim:${crypto.randomUUID()}`,
  });
  assert.equal(firstClaim?.runId, readbackOccurrence.runs[0].id);
  assert.equal(firstClaim.resumeMode, "START");
  assert.equal((firstClaim as unknown as Record<string, unknown>).leaseToken, undefined);
  const claimedGuard = await prisma.agentRepoGuard.findUnique({
    where: { runId: firstClaim.runId },
  });
  assert.equal(claimedGuard, null, "READ_ONLY는 run.createsPr 값과 무관하게 singleton을 획득하지 않는다");
  await settleAgentRun({
    sessionId: firstClaim.sessionId,
    workerId: "codex:seorilabs-generic-worker",
    runtimeBindingDigest: CODEX_RUNTIME_BINDING,
    outcome: "unknown",
    result: { outcomeCode: "RESULT_UNKNOWN", summary: "Read-only provider response timed out", costMicros: 10 },
    idempotencyKey: `unknown:${crypto.randomUUID()}`,
  });
  const unknown = await prisma.agentRun.findUniqueOrThrow({
    where: { id: firstClaim.runId },
    include: { leases: { orderBy: { generation: "asc" } }, repoGuard: true },
  });
  assert.equal(unknown.status, "FAILED");
  assert.ok(unknown.readbackRequestedAt);
  assert.ok(unknown.leases[0].revokedAt);
  assert.equal(
    unknown.repoGuard?.activeScopeKey ?? null,
    null,
    "READ_ONLY 결과 불명은 repo singleton을 만들지 않는다",
  );

  await assert.rejects(
    resolveAgentRunReadback({
      sessionId: firstClaim.sessionId,
      workerId: "codex:seorilabs-generic-worker",
      runtimeBindingDigest: CODEX_RUNTIME_BINDING,
      resolution: "RESUME",
      result: { outcomeCode: "READBACK_CONFIRMED", summary: "No PR exists", costMicros: 0 },
      idempotencyKey: `stale-readback:${crypto.randomUUID()}`,
    }),
    (error) => error instanceof ControlPlaneError && error.code === "READBACK_STATE_CONFLICT",
  );

  const readbackClaim = await claimAgentRun({
    workerId: "codex:seorilabs-generic-worker",
    runtimeBindingDigest: CODEX_RUNTIME_BINDING,
    agentKind: "CODEX",
    leaseSeconds: 300,
    idempotencyKey: `readback-claim:${crypto.randomUUID()}`,
  });
  assert.equal(readbackClaim?.runId, firstClaim.runId);
  assert.equal(readbackClaim.resumeMode, "READBACK_FIRST");
  assert.equal(readbackClaim.generation, firstClaim.generation + 1);
  assert.equal(readbackClaim.actionCapabilities.includes("github.pull_request.create"), false);
  await resolveAgentRunReadback({
    sessionId: readbackClaim.sessionId,
    workerId: "codex:seorilabs-generic-worker",
    runtimeBindingDigest: CODEX_RUNTIME_BINDING,
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
    runtimeBindingDigest: CODEX_RUNTIME_BINDING,
    agentKind: "CODEX",
    leaseSeconds: 300,
    idempotencyKey: `resumed-claim:${crypto.randomUUID()}`,
  });
  assert.equal(resumedClaim?.runId, firstClaim.runId);
  assert.equal(resumedClaim.resumeMode, "START");
  assert.equal(resumedClaim.actionCapabilities.includes("github.pull_request.create"), false);
  const heartbeatKey = `heartbeat:${crypto.randomUUID()}`;
  await heartbeatAgentRun({
    sessionId: resumedClaim.sessionId,
    workerId: "codex:seorilabs-generic-worker",
    runtimeBindingDigest: CODEX_RUNTIME_BINDING,
    leaseSeconds: 300,
    idempotencyKey: heartbeatKey,
  });
  await settleAgentRun({
    sessionId: resumedClaim.sessionId,
    workerId: "codex:seorilabs-generic-worker",
    runtimeBindingDigest: CODEX_RUNTIME_BINDING,
    outcome: "complete",
    result: { outcomeCode: "NO_CHANGES", summary: "No change required", costMicros: 0 },
    idempotencyKey: `complete:${crypto.randomUUID()}`,
  });
  await assert.rejects(
    heartbeatAgentRun({
      sessionId: resumedClaim.sessionId,
      workerId: "codex:seorilabs-generic-worker",
      runtimeBindingDigest: CODEX_RUNTIME_BINDING,
      leaseSeconds: 300,
      idempotencyKey: heartbeatKey,
    }),
    (error) => error instanceof ControlPlaneError && error.code === "STALE_SESSION",
  );

  await prisma.issueMirror.create({
    data: {
      appId: app.id,
      repoFullName,
      number: 2,
      nodeId: `fixture-issue-jit-${nonce}`,
      title: "JIT mutation contract",
      state: "OPEN",
      assignees: [],
      labels: ["autopilot", "P1"],
      priority: "P1",
      isAutopilot: true,
      ghCreatedAt: new Date(),
      ghUpdatedAt: new Date(),
    },
  });
  const jitOccurrence = await createRun({
    definitionId: readyDefinition.id,
    appId: app.id,
    issueNumber: 2,
    workKey: `${repoFullName}#jit`,
    createsPr: false,
  });
  // 운영 claim 경계는 닫아 둔 채, migration/transaction 계약만 검증하는 shadow session을 직접 만든다.
  const jitClaim = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 300_000);
    await tx.agentRun.update({
      where: { id: jitOccurrence.runs[0].id },
      data: { status: "RUNNING", leaseGeneration: 1, attempts: { increment: 1 }, startedAt: now },
    });
    await tx.automationOccurrence.update({
      where: { id: jitOccurrence.id },
      data: { status: "RUNNING" },
    });
    await tx.agentRepoGuard.create({
      data: {
        runId: jitOccurrence.runs[0].id,
        repoFullName,
        activeScopeKey: `repo-pr:${repoFullName.toLowerCase()}`,
        acquiredAt: now,
      },
    });
    const lease = await tx.agentLease.create({
      data: {
        runId: jitOccurrence.runs[0].id,
        generation: 1,
        tokenHash: "e".repeat(64),
        workerId: "codex:seorilabs-generic-worker",
        scopeKey: `repo-pr:${repoFullName.toLowerCase()}`,
        expiresAt,
        heartbeatAt: now,
      },
    });
    const session = await tx.agentWorkerSession.create({
      data: {
        id: `agent-session:${crypto.randomUUID()}`,
        leaseId: lease.id,
        runId: jitOccurrence.runs[0].id,
        generation: 1,
        principalId: "codex:seorilabs-generic-worker",
        runtimeBindingDigest: CODEX_RUNTIME_BINDING,
        repoId: app.repoId!,
        repoFullName,
        issueNumber: 2,
        sourceSha: "f".repeat(40),
        expiresAt,
        heartbeatAt: now,
      },
    });
    return { sessionId: session.id, runId: jitOccurrence.runs[0].id, generation: 1 };
  });
  assert.equal(jitClaim.runId, jitOccurrence.runs[0].id);
  const observedAt = new Date();
  const preObservation = agentGithubObservationSchema.parse({
    schemaVersion: 1,
    githubInstallationId: "101",
    providerSnapshotId: `fixture-pre-${nonce}`,
    complete: true,
    pageCount: 1,
    terminalCursor: null,
    observedAt,
    repoId: app.repoId!.toString(),
    repoFullName,
    defaultBranchRef: "refs/heads/main",
    defaultBranchSha: "f".repeat(40),
    issue: {
      number: 2,
      nodeId: `fixture-issue-jit-${nonce}`,
      state: "OPEN",
      labels: ["autopilot", "P1"],
      updatedAt: observedAt,
    },
    openAutopilotPullRequests: [],
    mutationTarget: null,
  });
  const authorizationKey = `jit-authorize:${crypto.randomUUID()}`;
  await assert.rejects(() => authorizeGithubReadyPrMutation({
    sessionId: jitClaim.sessionId,
    workerPrincipalId: "claude:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CLAUDE_RUNTIME_BINDING,
    action: GITHUB_READY_PR_MUTATION_ACTION,
    mutationIntentDigest: "a".repeat(64),
    observation: preObservation,
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `jit-cross-principal:${crypto.randomUUID()}`,
  }), (error: unknown) => (
    typeof error === "object" && error !== null && "code" in error && error.code === "SESSION_PRINCIPAL_MISMATCH"
  ));
  const authorization = await authorizeGithubReadyPrMutation({
    sessionId: jitClaim.sessionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    action: GITHUB_READY_PR_MUTATION_ACTION,
    mutationIntentDigest: "a".repeat(64),
    observation: preObservation,
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: authorizationKey,
  });
  assert.equal(authorization.status, "CONSUMED");
  assert.equal(authorization.writeDisposition, "STEP_LEDGER");
  assert.equal(JSON.stringify(authorization).match(/(?:lease|grant|action)Token/gi), null);
  const replayedAuthorization = await authorizeGithubReadyPrMutation({
    sessionId: jitClaim.sessionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    action: GITHUB_READY_PR_MUTATION_ACTION,
    mutationIntentDigest: "a".repeat(64),
    observation: preObservation,
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: authorizationKey,
  });
  assert.equal(replayedAuthorization.duplicate, true);
  assert.equal(replayedAuthorization.writeDisposition, "STEP_LEDGER");
  const replayObservedAt = new Date(observedAt.getTime() + 1_000);
  const refreshedAuthorization = await authorizeGithubReadyPrMutation({
    sessionId: jitClaim.sessionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    action: GITHUB_READY_PR_MUTATION_ACTION,
    mutationIntentDigest: "a".repeat(64),
    observation: agentGithubObservationSchema.parse({
      ...preObservation,
      providerSnapshotId: `fixture-pre-restart-${nonce}`,
      observedAt: replayObservedAt,
      issue: { ...preObservation.issue!, updatedAt: replayObservedAt },
    }),
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: authorizationKey,
    now: replayObservedAt,
  });
  assert.equal(refreshedAuthorization.duplicate, true, "프로세스 재시작의 새 observation도 같은 grant로 재개한다");

  const expectedTreeSha = "b".repeat(40);
  const expectedCommitSha = "c".repeat(40);
  const stepClaimedAt = new Date();
  const commitClaimKey = `jit-step-commit:${crypto.randomUUID()}`;
  const commitClaim = await claimGithubMutationStep({
    sessionId: jitClaim.sessionId,
    executionId: authorization.executionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_COMMIT",
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: commitClaimKey,
    now: stepClaimedAt,
  });
  assert.equal(commitClaim.generation, 1);
  assert.equal(commitClaim.writeDisposition, "EXECUTE_ONCE");
  assert.ok(commitClaim.attemptId);
  const duplicateCommitClaim = await claimGithubMutationStep({
    sessionId: jitClaim.sessionId,
    executionId: authorization.executionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_COMMIT",
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: commitClaimKey,
    now: new Date(stepClaimedAt.getTime() + 1_000),
  });
  assert.equal(duplicateCommitClaim.duplicate, true);
  assert.equal(duplicateCommitClaim.attemptId, commitClaim.attemptId);
  const commitPlan = await planGithubCommitMutationStep({
    sessionId: jitClaim.sessionId,
    executionId: authorization.executionId,
    stepId: commitClaim.stepId,
    attemptId: commitClaim.attemptId!,
    generation: commitClaim.generation,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_COMMIT",
    expectedTreeSha,
    expectedCommitSha,
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `jit-step-plan:${crypto.randomUUID()}`,
    now: new Date(stepClaimedAt.getTime() + 2_000),
  });
  assert.equal(commitPlan.status, "PLANNED");

  const stepObservation = (input: {
    stepKind: "CREATE_COMMIT" | "CREATE_REF" | "CREATE_PR";
    observedAt: Date;
    headSha: string | null;
    pullRequests?: Array<{
      number: number;
      nodeId: string;
      url: string;
      state: "OPEN" | "CLOSED" | "MERGED";
      draft: boolean;
      headRef: string;
      headSha: string;
      baseRef: string;
      baseSha: string;
      marker: string;
      closesIssueNumber: number | null;
    }>;
  }) => agentGithubMutationStepObservationSchema.parse({
    schemaVersion: 1,
    stepKind: input.stepKind,
    githubInstallationId: "101",
    providerSnapshotId: `fixture-step-${input.stepKind}-${input.observedAt.getTime()}`,
    complete: true,
    observedAt: input.observedAt,
    repoId: app.repoId!.toString(),
    repoFullName,
    defaultBranchRef: "refs/heads/main",
    defaultBranchSha: "f".repeat(40),
    issue: {
      number: 2,
      nodeId: `fixture-issue-jit-${nonce}`,
      state: "OPEN",
      labels: ["autopilot", "P1"],
      updatedAt: input.observedAt,
    },
    expectedHeadRef: authorization.expectedHeadRef,
    expectedPullRequestMarker: authorization.expectedPullRequestMarker,
    expectedTreeSha,
    expectedCommitSha,
    commit: { sha: expectedCommitSha, treeSha: expectedTreeSha, parentSha: "f".repeat(40) },
    headSha: input.headSha,
    openAutopilotPullRequests: input.stepKind === "CREATE_PR" ? input.pullRequests ?? [] : [],
    pullRequests: input.pullRequests ?? [],
  });
  const staleCompletionAt = new Date(stepClaimedAt.getTime() + 61_000);
  await assert.rejects(() => completeGithubMutationStep({
    sessionId: jitClaim.sessionId,
    executionId: authorization.executionId,
    stepId: commitClaim.stepId,
    attemptId: commitClaim.attemptId!,
    generation: commitClaim.generation,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_COMMIT",
    observation: stepObservation({ stepKind: "CREATE_COMMIT", observedAt: staleCompletionAt, headSha: null }),
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `jit-step-stale-complete:${crypto.randomUUID()}`,
    now: staleCompletionAt,
  }), (error: unknown) => (
    typeof error === "object" && error !== null && "code" in error && error.code === "STALE_MUTATION_STEP_ATTEMPT"
  ));
  const resumedAt = new Date(staleCompletionAt.getTime() + 1_000);
  const resumedCommitClaim = await claimGithubMutationStep({
    sessionId: jitClaim.sessionId,
    executionId: authorization.executionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_COMMIT",
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `jit-step-commit-resume:${crypto.randomUUID()}`,
    now: resumedAt,
  });
  assert.equal(resumedCommitClaim.generation, 2);
  assert.equal(resumedCommitClaim.writeDisposition, "READBACK_THEN_EXECUTE");
  const commitCompletion = await completeGithubMutationStep({
    sessionId: jitClaim.sessionId,
    executionId: authorization.executionId,
    stepId: resumedCommitClaim.stepId,
    attemptId: resumedCommitClaim.attemptId!,
    generation: resumedCommitClaim.generation,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_COMMIT",
    observation: stepObservation({
      stepKind: "CREATE_COMMIT",
      observedAt: new Date(resumedAt.getTime() + 1_000),
      headSha: null,
    }),
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `jit-step-commit-complete:${crypto.randomUUID()}`,
    now: new Date(resumedAt.getTime() + 1_000),
  });
  assert.equal(commitCompletion.status, "VERIFIED");

  const refClaim = await claimGithubMutationStep({
    sessionId: jitClaim.sessionId,
    executionId: authorization.executionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_REF",
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `jit-step-ref:${crypto.randomUUID()}`,
    now: new Date(resumedAt.getTime() + 2_000),
  });
  assert.equal((await completeGithubMutationStep({
    sessionId: jitClaim.sessionId,
    executionId: authorization.executionId,
    stepId: refClaim.stepId,
    attemptId: refClaim.attemptId!,
    generation: refClaim.generation,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_REF",
    observation: stepObservation({
      stepKind: "CREATE_REF",
      observedAt: new Date(resumedAt.getTime() + 3_000),
      headSha: expectedCommitSha,
    }),
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `jit-step-ref-complete:${crypto.randomUUID()}`,
    now: new Date(resumedAt.getTime() + 3_000),
  })).status, "VERIFIED");

  const pullRequest = {
    number: 17,
    nodeId: `fixture-pr-${nonce}`,
    url: `https://github.com/${repoFullName}/pull/17`,
    state: "OPEN" as const,
    draft: false,
    headRef: authorization.expectedHeadRef,
    headSha: expectedCommitSha,
    baseRef: "refs/heads/main",
    baseSha: "f".repeat(40),
    marker: authorization.expectedPullRequestMarker,
    closesIssueNumber: 2,
  };
  const prClaim = await claimGithubMutationStep({
    sessionId: jitClaim.sessionId,
    executionId: authorization.executionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_PR",
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `jit-step-pr:${crypto.randomUUID()}`,
    now: new Date(resumedAt.getTime() + 4_000),
  });
  assert.equal((await completeGithubMutationStep({
    sessionId: jitClaim.sessionId,
    executionId: authorization.executionId,
    stepId: prClaim.stepId,
    attemptId: prClaim.attemptId!,
    generation: prClaim.generation,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_PR",
    observation: stepObservation({
      stepKind: "CREATE_PR",
      observedAt: new Date(resumedAt.getTime() + 5_000),
      headSha: expectedCommitSha,
      pullRequests: [pullRequest],
    }),
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `jit-step-pr-complete:${crypto.randomUUID()}`,
    now: new Date(resumedAt.getTime() + 5_000),
  })).status, "VERIFIED");
  const durableSteps = await prisma.agentMutationStep.findMany({
    where: { executionId: authorization.executionId },
    include: { attempts: { orderBy: { generation: "asc" } } },
    orderBy: { ordinal: "asc" },
  });
  assert.deepEqual(durableSteps.map((step) => [step.kind, step.status]), [
    ["CREATE_COMMIT", "VERIFIED"],
    ["CREATE_REF", "VERIFIED"],
    ["CREATE_PR", "VERIFIED"],
  ]);
  assert.deepEqual(durableSteps[0].attempts.map((attempt) => attempt.status), ["STALE", "VERIFIED"]);
  const verifiedCommitReplay = await claimGithubMutationStep({
    sessionId: jitClaim.sessionId,
    executionId: authorization.executionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_COMMIT",
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: commitClaimKey,
    now: new Date(resumedAt.getTime() + 6_000),
  });
  assert.equal(verifiedCommitReplay.writeDisposition, "ALREADY_VERIFIED");
  assert.equal(verifiedCommitReplay.attemptId, null);

  const postPrReplayAt = new Date(resumedAt.getTime() + 7_000);
  const postPrAuthorizationReplay = await authorizeGithubReadyPrMutation({
    sessionId: jitClaim.sessionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    action: GITHUB_READY_PR_MUTATION_ACTION,
    mutationIntentDigest: "a".repeat(64),
    observation: agentGithubObservationSchema.parse({
      ...preObservation,
      providerSnapshotId: `fixture-post-pr-restart-${nonce}`,
      observedAt: postPrReplayAt,
      issue: { ...preObservation.issue!, updatedAt: postPrReplayAt },
      openAutopilotPullRequests: [pullRequest],
    }),
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: authorizationKey,
    now: postPrReplayAt,
  });
  assert.equal(postPrAuthorizationReplay.duplicate, true, "PR write 직후 재시작도 exact target만 허용해 재개한다");

  const verifiedObservation = agentGithubObservationSchema.parse({
    ...preObservation,
    providerSnapshotId: `fixture-post-${nonce}`,
    observedAt: new Date(),
    openAutopilotPullRequests: [{ ...pullRequest, state: "OPEN" }],
    mutationTarget: {
      expectedHeadRef: authorization.expectedHeadRef,
      expectedMarker: authorization.expectedPullRequestMarker,
      headState: "PRESENT",
      headSha: expectedCommitSha,
      complete: true,
      pageCount: 1,
      terminalCursor: null,
      pullRequests: [pullRequest],
    },
  });
  await assert.rejects(() => recordGithubMutationReadback({
    sessionId: jitClaim.sessionId,
    executionId: authorization.executionId,
    workerPrincipalId: "claude:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CLAUDE_RUNTIME_BINDING,
    observation: verifiedObservation,
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `jit-cross-principal-readback:${crypto.randomUUID()}`,
  }), (error: unknown) => (
    typeof error === "object" && error !== null && "code" in error && error.code === "MUTATION_STEP_SESSION_MISMATCH"
  ));
  const readback = await recordGithubMutationReadback({
    sessionId: jitClaim.sessionId,
    executionId: authorization.executionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    observation: verifiedObservation,
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `jit-readback:${crypto.randomUUID()}`,
  });
  assert.equal(readback.readback.status, "VERIFIED");
  await settleAgentRun({
    sessionId: jitClaim.sessionId,
    workerId: "codex:seorilabs-generic-worker",
    runtimeBindingDigest: CODEX_RUNTIME_BINDING,
    outcome: "complete",
    result: {
      outcomeCode: "PR_READY",
      summary: "Step ledger와 signed readback이 PR을 확인했다",
      commitSha: expectedCommitSha,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      mutationExecutionId: authorization.executionId,
      costMicros: 0,
    },
    idempotencyKey: `jit-complete:${crypto.randomUUID()}`,
  });
  assert.equal((await prisma.agentRun.findUniqueOrThrow({ where: { id: jitClaim.runId } })).status, "SUCCEEDED");
  await prisma.issueMirror.update({
    where: { repoFullName_number: { repoFullName, number: 2 } },
    data: { state: "CLOSED", isAutopilot: false, ghUpdatedAt: new Date() },
  });
  await prisma.pullRequestMirror.create({
    data: {
      appId: app.id,
      repoFullName,
      number: pullRequest.number,
      nodeId: pullRequest.nodeId,
      title: "JIT mutation contract",
      state: "CLOSED",
      authorLogin: "seori-auth",
      headRef: authorization.expectedHeadRef.replace("refs/heads/", ""),
      baseRef: "main",
      labels: ["autopilot"],
      linkedIssue: 2,
      isAutopilotPr: true,
      ghCreatedAt: new Date(),
      ghUpdatedAt: new Date(),
    },
  });
  assert.deepEqual(await reconcileTerminalRepoGuards({
    repoFullName,
    pullRequestNumber: pullRequest.number,
  }), { scanned: 1, released: 1 });

  await prisma.issueMirror.create({
    data: {
      appId: app.id,
      repoFullName,
      number: 3,
      nodeId: `fixture-issue-recovery-${nonce}`,
      title: "TTL mutation recovery contract",
      state: "OPEN",
      assignees: [],
      labels: ["autopilot", "P1"],
      priority: "P1",
      isAutopilot: true,
      ghCreatedAt: new Date(),
      ghUpdatedAt: new Date(),
    },
  });
  const recoveryOccurrence = await createRun({
    definitionId: readyDefinition.id,
    appId: app.id,
    issueNumber: 3,
    workKey: `${repoFullName}#ttl-recovery`,
    createsPr: false,
  });
  const recoveryRunId = recoveryOccurrence.runs[0].id;
  const recoveryStartedAt = new Date();
  const recoveryStart = await openFixtureMutationSession({
    runId: recoveryRunId,
    occurrenceId: recoveryOccurrence.id,
    issueNumber: 3,
    expectedStatus: "PENDING",
    expectedGeneration: 0,
    generation: 1,
    now: recoveryStartedAt,
    createRepoGuard: true,
    incrementAttempts: true,
    requireReadback: false,
  });
  const recoveryPreObservation = (observedAt: Date, providerSnapshotId: string) => (
    agentGithubObservationSchema.parse({
      schemaVersion: 1,
      githubInstallationId: "101",
      providerSnapshotId,
      complete: true,
      pageCount: 1,
      terminalCursor: null,
      observedAt,
      repoId: app.repoId!.toString(),
      repoFullName,
      defaultBranchRef: "refs/heads/main",
      defaultBranchSha: "f".repeat(40),
      issue: {
        number: 3,
        nodeId: `fixture-issue-recovery-${nonce}`,
        state: "OPEN",
        labels: ["autopilot", "P1"],
        updatedAt: observedAt,
      },
      openAutopilotPullRequests: [],
      mutationTarget: null,
    })
  );
  const recoveryIntentDigest = "9".repeat(64);
  const recoveryAuthorization = await authorizeGithubReadyPrMutation({
    sessionId: recoveryStart.sessionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    action: GITHUB_READY_PR_MUTATION_ACTION,
    mutationIntentDigest: recoveryIntentDigest,
    observation: recoveryPreObservation(recoveryStartedAt, `fixture-recovery-pre-${nonce}`),
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `recovery-authorize:${crypto.randomUUID()}`,
    now: recoveryStartedAt,
  });
  const recoveryTreeSha = "1".repeat(40);
  const recoveryCommitSha = "2".repeat(40);
  const recoveryStepObservation = (input: {
    stepKind: "CREATE_COMMIT" | "CREATE_REF" | "CREATE_PR";
    observedAt: Date;
    headSha: string | null;
  }) => agentGithubMutationStepObservationSchema.parse({
    schemaVersion: 1,
    stepKind: input.stepKind,
    githubInstallationId: "101",
    providerSnapshotId: `fixture-recovery-step-${input.stepKind}-${input.observedAt.getTime()}`,
    complete: true,
    observedAt: input.observedAt,
    repoId: app.repoId!.toString(),
    repoFullName,
    defaultBranchRef: "refs/heads/main",
    defaultBranchSha: "f".repeat(40),
    issue: {
      number: 3,
      nodeId: `fixture-issue-recovery-${nonce}`,
      state: "OPEN",
      labels: ["autopilot", "P1"],
      updatedAt: input.observedAt,
    },
    expectedHeadRef: recoveryAuthorization.expectedHeadRef,
    expectedPullRequestMarker: recoveryAuthorization.expectedPullRequestMarker,
    expectedTreeSha: recoveryTreeSha,
    expectedCommitSha: recoveryCommitSha,
    commit: {
      sha: recoveryCommitSha,
      treeSha: recoveryTreeSha,
      parentSha: "f".repeat(40),
    },
    headSha: input.headSha,
    openAutopilotPullRequests: [],
    pullRequests: [],
  });
  const recoveryCommitClaimedAt = new Date(recoveryStartedAt.getTime() + 1_000);
  const recoveryCommitClaim = await claimGithubMutationStep({
    sessionId: recoveryStart.sessionId,
    executionId: recoveryAuthorization.executionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_COMMIT",
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `recovery-commit-claim:${crypto.randomUUID()}`,
    now: recoveryCommitClaimedAt,
  });
  await planGithubCommitMutationStep({
    sessionId: recoveryStart.sessionId,
    executionId: recoveryAuthorization.executionId,
    stepId: recoveryCommitClaim.stepId,
    attemptId: recoveryCommitClaim.attemptId!,
    generation: recoveryCommitClaim.generation,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_COMMIT",
    expectedTreeSha: recoveryTreeSha,
    expectedCommitSha: recoveryCommitSha,
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `recovery-commit-plan:${crypto.randomUUID()}`,
    now: new Date(recoveryStartedAt.getTime() + 2_000),
  });
  assert.equal((await completeGithubMutationStep({
    sessionId: recoveryStart.sessionId,
    executionId: recoveryAuthorization.executionId,
    stepId: recoveryCommitClaim.stepId,
    attemptId: recoveryCommitClaim.attemptId!,
    generation: recoveryCommitClaim.generation,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_COMMIT",
    observation: recoveryStepObservation({
      stepKind: "CREATE_COMMIT",
      observedAt: new Date(recoveryStartedAt.getTime() + 3_000),
      headSha: null,
    }),
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `recovery-commit-complete:${crypto.randomUUID()}`,
    now: new Date(recoveryStartedAt.getTime() + 3_000),
  })).status, "VERIFIED");
  await settleAgentRun({
    sessionId: recoveryStart.sessionId,
    workerId: "codex:seorilabs-generic-worker",
    runtimeBindingDigest: CODEX_RUNTIME_BINDING,
    outcome: "unknown",
    result: {
      outcomeCode: "RESULT_UNKNOWN",
      summary: "commit readback 뒤 worker가 종료됐다",
      mutationExecutionId: recoveryAuthorization.executionId,
      costMicros: 0,
    },
    idempotencyKey: `recovery-result-unknown:${crypto.randomUUID()}`,
    now: new Date(recoveryStartedAt.getTime() + 4_000),
  });
  const recoveryFailed = await prisma.agentRun.findUniqueOrThrow({
    where: { id: recoveryRunId },
    include: { repoGuard: true },
  });
  assert.equal(recoveryFailed.status, "FAILED");
  assert.ok(recoveryFailed.readbackRequestedAt);
  assert.equal(recoveryFailed.repoGuard?.activeScopeKey, `repo-pr:${repoFullName.toLowerCase()}`);

  const recoveryReadbackAt = new Date(recoveryStart.expiresAt.getTime() + 1_000);
  const recoveryReadbackSession = await openFixtureMutationSession({
    runId: recoveryRunId,
    occurrenceId: recoveryOccurrence.id,
    issueNumber: 3,
    expectedStatus: "FAILED",
    expectedGeneration: 1,
    generation: 2,
    now: recoveryReadbackAt,
    createRepoGuard: false,
    incrementAttempts: false,
    requireReadback: true,
  });
  const recovery = await claimGithubMutationRecovery({
    sessionId: recoveryReadbackSession.sessionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `recovery-readback-claim:${crypto.randomUUID()}`,
    now: recoveryReadbackAt,
  });
  assert.equal(recovery.executionId, recoveryAuthorization.executionId);
  assert.equal(recovery.sourceSha, "f".repeat(40));
  const recoveredCommit = await claimGithubMutationStep({
    sessionId: recoveryReadbackSession.sessionId,
    executionId: recovery.executionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_COMMIT",
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `recovery-readback-commit:${crypto.randomUUID()}`,
    now: new Date(recoveryReadbackAt.getTime() + 1_000),
  });
  assert.equal(recoveredCommit.writeDisposition, "ALREADY_VERIFIED");
  assert.equal(recoveredCommit.attemptId, null);
  const recoveredRef = await claimGithubMutationStep({
    sessionId: recoveryReadbackSession.sessionId,
    executionId: recovery.executionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_REF",
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `recovery-readback-ref:${crypto.randomUUID()}`,
    now: new Date(recoveryReadbackAt.getTime() + 2_000),
  });
  assert.equal(recoveredRef.writeDisposition, "READBACK_ONLY");
  assert.equal((await completeGithubMutationStep({
    sessionId: recoveryReadbackSession.sessionId,
    executionId: recovery.executionId,
    stepId: recoveredRef.stepId,
    attemptId: recoveredRef.attemptId!,
    generation: recoveredRef.generation,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_REF",
    observation: recoveryStepObservation({
      stepKind: "CREATE_REF",
      observedAt: new Date(recoveryReadbackAt.getTime() + 3_000),
      headSha: null,
    }),
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `recovery-readback-ref-complete:${crypto.randomUUID()}`,
    now: new Date(recoveryReadbackAt.getTime() + 3_000),
  })).status, "NOT_APPLIED");
  const recoveryFinalObservedAt = new Date(recoveryReadbackAt.getTime() + 4_000);
  const recoveryFinalReadback = await recordGithubMutationReadback({
    sessionId: recoveryReadbackSession.sessionId,
    executionId: recovery.executionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    observation: agentGithubObservationSchema.parse({
      ...recoveryPreObservation(recoveryFinalObservedAt, `fixture-recovery-final-${nonce}`),
      mutationTarget: {
        expectedHeadRef: recoveryAuthorization.expectedHeadRef,
        expectedMarker: recoveryAuthorization.expectedPullRequestMarker,
        headState: "ABSENT",
        headSha: null,
        complete: true,
        pageCount: 1,
        terminalCursor: null,
        pullRequests: [],
      },
    }),
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `recovery-final-readback:${crypto.randomUUID()}`,
    now: recoveryFinalObservedAt,
  });
  assert.equal(recoveryFinalReadback.readback.status, "RESULT_UNKNOWN");
  await resolveAgentRunReadback({
    sessionId: recoveryReadbackSession.sessionId,
    workerId: "codex:seorilabs-generic-worker",
    runtimeBindingDigest: CODEX_RUNTIME_BINDING,
    resolution: "RESUME",
    result: {
      outcomeCode: "READBACK_CONFIRMED",
      summary: "commit만 적용되고 branch는 없음을 확인했다",
      costMicros: 0,
    },
    idempotencyKey: `recovery-resolve:${crypto.randomUUID()}`,
    now: new Date(recoveryReadbackAt.getTime() + 5_000),
  });
  assert.equal((await prisma.agentRun.findUniqueOrThrow({ where: { id: recoveryRunId } })).status, "PENDING");

  const recoveryResumeAt = new Date(recoveryReadbackAt.getTime() + 6_000);
  const recoveryResumeSession = await openFixtureMutationSession({
    runId: recoveryRunId,
    occurrenceId: recoveryOccurrence.id,
    issueNumber: 3,
    expectedStatus: "PENDING",
    expectedGeneration: 2,
    generation: 3,
    now: recoveryResumeAt,
    createRepoGuard: false,
    incrementAttempts: true,
    requireReadback: false,
  });
  const resumedRecoveryAuthorization = await authorizeGithubReadyPrMutation({
    sessionId: recoveryResumeSession.sessionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    action: GITHUB_READY_PR_MUTATION_ACTION,
    mutationIntentDigest: recoveryIntentDigest,
    observation: recoveryPreObservation(recoveryResumeAt, `fixture-recovery-resume-${nonce}`),
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `recovery-resume-authorize:${crypto.randomUUID()}`,
    now: recoveryResumeAt,
  });
  assert.equal(resumedRecoveryAuthorization.executionId, recoveryAuthorization.executionId);
  assert.equal(resumedRecoveryAuthorization.duplicate, false);
  const resumedVerifiedCommit = await claimGithubMutationStep({
    sessionId: recoveryResumeSession.sessionId,
    executionId: recovery.executionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_COMMIT",
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `recovery-resume-commit:${crypto.randomUUID()}`,
    now: new Date(recoveryResumeAt.getTime() + 1_000),
  });
  assert.equal(resumedVerifiedCommit.writeDisposition, "ALREADY_VERIFIED");
  const resumedRef = await claimGithubMutationStep({
    sessionId: recoveryResumeSession.sessionId,
    executionId: recovery.executionId,
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: CODEX_RUNTIME_BINDING,
    stepKind: "CREATE_REF",
    adapterPrincipalId: "seori-auth:github-mutation-adapter",
    adapterRuntimeIdentity: "fixture:rpi5:github-adapter",
    idempotencyKey: `recovery-resume-ref:${crypto.randomUUID()}`,
    now: new Date(recoveryResumeAt.getTime() + 2_000),
  });
  assert.equal(resumedRef.writeDisposition, "EXECUTE_ONCE");
  assert.ok(resumedRef.expiresAt && resumedRef.expiresAt > recoveryStart.expiresAt);
  assert.equal((await prisma.agentMutationStepAttempt.findUniqueOrThrow({
    where: { id: resumedRef.attemptId! },
  })).sessionId, recoveryResumeSession.sessionId);
  await prisma.issueMirror.update({
    where: { repoFullName_number: { repoFullName, number: 3 } },
    data: { state: "CLOSED", isAutopilot: false, ghUpdatedAt: new Date() },
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
    runtimeBindingDigest: CODEX_RUNTIME_BINDING,
    agentKind: "CODEX",
    leaseSeconds: 300,
    idempotencyKey: `legacy-claim:${crypto.randomUUID()}`,
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
    runtimeBindingDigest: CLAUDE_RUNTIME_BINDING,
    agentKind: "CLAUDE",
    leaseSeconds: 300,
    idempotencyKey: `policy-claim:${crypto.randomUUID()}`,
  });
  assert.equal(policyClaim?.runId, replacement.runs[0].id);
  await cancelAgentRun({ runId: policyClaim.runId, actor, requestId: `cancel-replacement:${crypto.randomUUID()}` });
  const policyClaim2 = await claimAgentRun({
    workerId: "claude:seorilabs-generic-worker",
    runtimeBindingDigest: CLAUDE_RUNTIME_BINDING,
    agentKind: "CLAUDE",
    leaseSeconds: 300,
    idempotencyKey: `policy-claim-2:${crypto.randomUUID()}`,
  });
  assert.equal(policyClaim2?.runId, policyOccurrence.runs[0].id);
  await settleAgentRun({
    sessionId: policyClaim2.sessionId,
    workerId: "claude:seorilabs-generic-worker",
    runtimeBindingDigest: CLAUDE_RUNTIME_BINDING,
    outcome: "complete",
    result: { outcomeCode: "ISSUE_RESOLVED", summary: "Mutation claimed", costMicros: 1 },
    idempotencyKey: `policy-settle:${crypto.randomUUID()}`,
  });
  const policyBlocked = await prisma.agentRun.findUniqueOrThrow({ where: { id: policyClaim2.runId } });
  assert.equal(policyBlocked.status, "DEAD_LETTER");
  assert.equal(policyBlocked.error, "APPROVAL_POLICY_VIOLATION");

  const reauthOccurrence = await createRun({
    definitionId: readOnlyDefinition.id,
    appId: app.id,
    issueNumber: 1,
    workKey: `${repoFullName}#reauth`,
    createsPr: false,
  });
  const reauth = await prisma.reauthRequest.create({
    data: {
      appId: app.id,
      runId: reauthOccurrence.runs[0].id,
      provider: "github",
      origin: "https://github.com",
      publicAccountId: "seorilabs",
      capability: "github.pull_request.create",
      gate: "HUMAN_MFA",
      idempotencyKey: `fixture-reauth:${crypto.randomUUID()}`,
      requestedBy: "fixture:trusted-adapter",
    },
  });
  const reauthClaim = await claimAgentRun({
    workerId: "claude:seorilabs-generic-worker",
    runtimeBindingDigest: CLAUDE_RUNTIME_BINDING,
    agentKind: "CLAUDE",
    leaseSeconds: 300,
    idempotencyKey: `reauth-claim:${crypto.randomUUID()}`,
  });
  assert.equal(reauthClaim?.runId, reauthOccurrence.runs[0].id);
  await settleAgentRun({
    sessionId: reauthClaim.sessionId,
    workerId: "claude:seorilabs-generic-worker",
    runtimeBindingDigest: CLAUDE_RUNTIME_BINDING,
    outcome: "fail",
    result: {
      outcomeCode: "BLOCKED",
      summary: "사람 재인증이 필요함",
      costMicros: 0,
      reauthRequestId: reauth.id,
    },
    error: "HUMAN_REAUTH_REQUIRED",
    idempotencyKey: `reauth-fail:${crypto.randomUUID()}`,
  });
  const reauthBlocked = await prisma.agentRun.findUniqueOrThrow({ where: { id: reauthClaim.runId } });
  assert.equal(reauthBlocked.status, "DEAD_LETTER");
  assert.equal(reauthBlocked.error, "HUMAN_REAUTH_REQUIRED");
  assert.equal(await prisma.agentRunEvent.count({
    where: { runId: reauthClaim.runId, type: "human_reauth_required" },
  }), 1);

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
  await prisma.automationDefinition.update({
    where: { id: created.definition.id },
    data: { createdAt: new Date("2026-08-25T01:00:00.000Z") },
  });
  const scheduleNow = new Date("2026-08-28T12:30:00.000Z");
  const firstSchedule = await scheduleDueAutomations({ now: scheduleNow });
  assert.equal(firstSchedule.created, 3, "누락된 daily slot 세 개를 한 번씩 복구해야 한다");
  const afterFirstSchedule = {
    occurrences: await prisma.automationOccurrence.count({
      where: { definitionId: created.definition.id, triggerKind: "SCHEDULE" },
    }),
    runs: await prisma.agentRun.count({
      where: { occurrence: { definitionId: created.definition.id, triggerKind: "SCHEDULE" } },
    }),
  };
  assert.deepEqual(afterFirstSchedule, { occurrences: 3, runs: 1 });
  const replayedSchedule = await scheduleDueAutomations({ now: scheduleNow });
  assert.equal(replayedSchedule.created, 0);
  assert.deepEqual({
    occurrences: await prisma.automationOccurrence.count({
      where: { definitionId: created.definition.id, triggerKind: "SCHEDULE" },
    }),
    runs: await prisma.agentRun.count({
      where: { occurrence: { definitionId: created.definition.id, triggerKind: "SCHEDULE" } },
    }),
  }, afterFirstSchedule, "같은 reconcile은 occurrence와 run을 중복 생성하지 않아야 한다");
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
  const platformRedelivery = await recordWebhookDelivery({
    deliveryId: platformDeliveryId,
    event: "push",
    repoFullName: "seorilabs/platform",
    stableTagPush: platformTag,
  });
  assert.equal(platformRedelivery.duplicate, true);
  assert.equal(await prisma.automationIngressEvent.count({
    where: { sourceKey: `github:${platformDeliveryId}` },
  }), 1, "같은 GitHub delivery의 durable inbox는 하나여야 한다");
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
    runtimeBindingDigest: CODEX_RUNTIME_BINDING,
    agentKind: "CODEX",
    leaseSeconds: 300,
    idempotencyKey: `repository-needs-input:${crypto.randomUUID()}`,
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
