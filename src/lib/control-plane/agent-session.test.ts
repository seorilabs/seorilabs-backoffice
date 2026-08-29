import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Prisma } from "@prisma/client";

import {
  agentExecutionPolicy,
  agentRepositorySingletonScope,
  automationPolicy,
} from "@/lib/control-plane/automation-catalog";
import {
  signAgentAdapterAttestation,
  verifyAgentAdapterAttestation,
} from "@/lib/control-plane/agent-adapter-attestation";
import {
  agentWorkerSessionStateError,
  githubInstallationBindingError,
  githubMutationReadbackDisposition,
  githubMutationStepLedgerVerified,
  githubMutationStepDisposition,
  githubObservationTimingError,
  mutationReadbackTerminalEvidenceError,
  mutationReadbackTransitionError,
  trustedMutationDisposition,
} from "@/lib/control-plane/agent-mutation-service";
import {
  agentCompletionSchema,
  agentFailureSchema,
  agentGithubMutationAuthorizeSchema,
  agentGithubMutationStepObservationSchema,
  agentGithubObservationSchema,
  agentHeartbeatSchema,
  agentReadbackResolutionSchema,
} from "@/lib/control-plane/contracts";
import { githubInstallationProviderPayload } from "@/lib/control-plane/github-installation-observation";

const SOURCE_SHA = "a".repeat(40);
const RUNTIME_BINDING = "c".repeat(64);
const NOW = new Date("2026-08-29T10:00:00.000Z");

function sessionState(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "agent-session:public-id",
    sessionRunId: "run-1",
    sessionGeneration: 3,
    sessionPrincipalId: "codex:seorilabs-generic-worker",
    sessionRuntimeBindingDigest: RUNTIME_BINDING,
    sessionRepoId: 42n,
    sessionRepoFullName: "seorilabs/example",
    sessionIssueNumber: 123,
    sessionSourceSha: SOURCE_SHA,
    sessionExpiresAt: new Date(NOW.getTime() + 60_000),
    sessionRevokedAt: null,
    requestedPrincipalId: "codex:seorilabs-generic-worker",
    requestedRuntimeBindingDigest: RUNTIME_BINDING,
    leaseRunId: "run-1",
    leaseGeneration: 3,
    leaseWorkerId: "codex:seorilabs-generic-worker",
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    leaseRevokedAt: null,
    runStatus: "RUNNING",
    runGeneration: 3,
    runRepoFullName: "seorilabs/example",
    runIssueNumber: 123,
    now: NOW,
    ...overrides,
  };
}

function githubObservation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    githubInstallationId: "101",
    providerSnapshotId: "github-snapshot-1",
    complete: true,
    pageCount: 1,
    terminalCursor: null,
    observedAt: NOW,
    repoId: "42",
    repoFullName: "seorilabs/example",
    defaultBranchRef: "refs/heads/main",
    defaultBranchSha: SOURCE_SHA,
    issue: {
      number: 123,
      nodeId: "ISSUE_node_123",
      state: "OPEN",
      labels: ["autopilot", "긴급 개선"],
      updatedAt: NOW,
    },
    openAutopilotPullRequests: [],
    mutationTarget: null,
    ...overrides,
  };
}

function githubInstallationPayload() {
  return githubInstallationProviderPayload({
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
      organization_administration: "write",
    },
    events: ["push", "repository", "pull_request", "issues", "issue_comment", "workflow_run"],
  }, "seorilabs");
}

test("public worker action은 sessionId만 capability locator로 받고 raw lease/grant 입력을 거부한다", () => {
  const heartbeat = { sessionId: "agent-session:public-id", leaseSeconds: 60 };
  assert.equal(agentHeartbeatSchema.safeParse(heartbeat).success, true);
  for (const raw of [
    { ...heartbeat, leaseToken: "x".repeat(64) },
    { ...heartbeat, grantToken: "x".repeat(64) },
    { ...heartbeat, actionToken: "x".repeat(64) },
    { ...heartbeat, runId: "run-1", generation: 3 },
  ]) assert.equal(agentHeartbeatSchema.safeParse(raw).success, false);
  assert.equal(agentCompletionSchema.safeParse({
    sessionId: heartbeat.sessionId,
    result: { outcomeCode: "NO_CHANGES", summary: "변경 없음", costMicros: 0 },
  }).success, true);
  assert.equal(agentCompletionSchema.safeParse({
    sessionId: heartbeat.sessionId,
    result: { outcomeCode: "RESULT_UNKNOWN", summary: "결과 불명", costMicros: 0 },
  }).success, false);
  assert.equal(agentFailureSchema.safeParse({
    sessionId: heartbeat.sessionId,
    result: {
      outcomeCode: "BLOCKED",
      summary: "사람 승인이 필요함",
      costMicros: 0,
      reauthRequestId: "reauth-request-1",
    },
    error: "HUMAN_REAUTH_REQUIRED",
  }).success, true);
  assert.equal(agentFailureSchema.safeParse({
    sessionId: heartbeat.sessionId,
    result: { outcomeCode: "BLOCKED", summary: "사람 승인이 필요함", costMicros: 0 },
    error: "HUMAN_REAUTH_REQUIRED",
  }).success, false);
  assert.equal(agentFailureSchema.safeParse({
    sessionId: heartbeat.sessionId,
    result: { outcomeCode: "NO_CHANGES", summary: "변경 없음", costMicros: 0 },
    error: "WORKER_FAILED",
  }).success, false);
  assert.equal(agentReadbackResolutionSchema.safeParse({
    sessionId: heartbeat.sessionId,
    resolution: "RESUME",
    result: { outcomeCode: "READBACK_CONFIRMED", summary: "mutation 없음", costMicros: 0 },
  }).success, true);

  const queue = readFileSync(join(process.cwd(), "src/lib/control-plane/agent-queue.ts"), "utf8");
  const publicClaim = queue.slice(queue.indexOf("export interface ClaimedAgentRun"), queue.indexOf("async function replayClaim"));
  assert.match(publicClaim, /sessionId: string/);
  assert.doesNotMatch(publicClaim, /(?:lease|grant|action)Token/i);
  for (const route of ["claim", "heartbeat", "complete", "fail", "readback-required", "readback"]) {
    const source = readFileSync(join(process.cwd(), `src/app/api/internal/agents/${route}/route.ts`), "utf8");
    assert.doesNotMatch(source, /AGENT_LEASE_SIGNING_KEY|leaseToken|grantToken|actionToken/);
  }
});

test("worker session은 principal, run generation, repo, issue, source와 TTL에 fail-closed 결합된다", () => {
  assert.equal(agentWorkerSessionStateError(sessionState()), null);
  assert.equal(agentWorkerSessionStateError(sessionState({ requestedPrincipalId: "claude:seorilabs-generic-worker" })), "SESSION_PRINCIPAL_MISMATCH");
  assert.equal(agentWorkerSessionStateError(sessionState({ requestedRuntimeBindingDigest: "d".repeat(64) })), "SESSION_RUNTIME_BINDING_MISMATCH");
  assert.equal(agentWorkerSessionStateError(sessionState({ runGeneration: 4 })), "SESSION_BINDING_MISMATCH");
  assert.equal(agentWorkerSessionStateError(sessionState({ runRepoFullName: "seorilabs/other" })), "SESSION_BINDING_MISMATCH");
  assert.equal(agentWorkerSessionStateError(sessionState({ runIssueNumber: 124 })), "SESSION_BINDING_MISMATCH");
  assert.equal(agentWorkerSessionStateError(sessionState({ sessionSourceSha: "b".repeat(39) })), "SESSION_BINDING_MISMATCH");
  assert.equal(agentWorkerSessionStateError(sessionState({ sessionExpiresAt: NOW })), "STALE_SESSION");
  assert.equal(agentWorkerSessionStateError(sessionState({ leaseRevokedAt: NOW })), "STALE_SESSION");
  assert.equal(agentWorkerSessionStateError(sessionState({ runStatus: "SUCCEEDED" })), "STALE_SESSION");
});

test("trusted adapter attestation은 Ed25519 route, body, runtime, 60초 TTL에 결합된다", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const route = "/api/internal/agent-adapter/github-mutations/authorize";
  const requestId = "adapter-request-1";
  const body = { sessionId: "agent-session:public-id", action: "GITHUB_READY_PR_MUTATE" };
  const token = signAgentAdapterAttestation({
    privateKey,
    runtimeIdentity: "seori-auth:github-adapter:rpi5",
    route,
    requestId,
    body,
    issuedAt: NOW.getTime(),
    expiresAt: NOW.getTime() + 60_000,
    nonce: "nonce-1",
  });
  assert.equal(verifyAgentAdapterAttestation({ token, publicKey, route, requestId, body, now: NOW })?.runtimeIdentity, "seori-auth:github-adapter:rpi5");
  assert.equal(verifyAgentAdapterAttestation({ token, publicKey, route: `${route}/lookalike`, requestId, body, now: NOW }), null);
  assert.equal(verifyAgentAdapterAttestation({ token, publicKey, route, requestId: "adapter-request-2", body, now: NOW }), null);
  assert.equal(verifyAgentAdapterAttestation({ token, publicKey, route, requestId, body: { ...body, action: "OTHER" }, now: NOW }), null);
  assert.equal(verifyAgentAdapterAttestation({ token, publicKey, route, requestId, body, now: new Date(NOW.getTime() + 60_000) }), null);
  assert.throws(() => signAgentAdapterAttestation({
    privateKey,
    runtimeIdentity: "seori-auth:github-adapter:rpi5",
    route,
    requestId,
    body,
    issuedAt: NOW.getTime(),
    expiresAt: NOW.getTime() + 60_001,
    nonce: "nonce-2",
  }), /AGENT_ADAPTER_ATTESTATION_PAYLOAD_INVALID/);
});

test("JIT GitHub observation은 complete snapshot, exact repo URL, 최신 시각과 공개 label만 허용한다", () => {
  assert.equal(agentGithubObservationSchema.safeParse(githubObservation()).success, true);
  assert.equal(githubObservationTimingError(new Date(NOW.getTime() - 60_000), NOW), null);
  assert.equal(githubObservationTimingError(new Date(NOW.getTime() - 60_001), NOW), "GITHUB_OBSERVATION_STALE");
  assert.equal(githubObservationTimingError(new Date(NOW.getTime() + 5_001), NOW), "GITHUB_OBSERVATION_FROM_FUTURE");
  assert.equal(agentGithubObservationSchema.safeParse(githubObservation({ complete: false })).success, false);
  assert.equal(agentGithubObservationSchema.safeParse(githubObservation({ terminalCursor: "next" })).success, false);
  assert.equal(agentGithubObservationSchema.safeParse(githubObservation({
    issue: { ...githubObservation().issue as object, labels: ["autopilot", "password=hunter2"] },
  })).success, false);
  const pullRequest = {
    number: 7,
    nodeId: "PR_node_7",
    url: "https://github.com/seorilabs/other/pull/7",
    state: "OPEN",
    draft: false,
    headRef: "refs/heads/seori/run-1",
    headSha: "b".repeat(40),
    baseRef: "refs/heads/main",
    baseSha: SOURCE_SHA,
    marker: "seori-run:run-1:3",
    closesIssueNumber: 123,
  };
  assert.equal(agentGithubObservationSchema.safeParse(githubObservation({ openAutopilotPullRequests: [pullRequest] })).success, false);
  assert.equal(agentGithubMutationAuthorizeSchema.safeParse({
    sessionId: "agent-session:public-id",
    workerPrincipalId: "codex:seorilabs-generic-worker",
    workerRuntimeBindingDigest: RUNTIME_BINDING,
    action: "GITHUB_READY_PR_MUTATE",
    mutationIntentDigest: "a".repeat(64),
    observation: githubObservation(),
    grantToken: "x".repeat(64),
  }).success, false);
});

test("JIT grant는 앱에 등록된 GitHub installation과 PR mutation capability에 결합된다", () => {
  const payload = githubInstallationPayload();
  assert.equal(githubInstallationBindingError({
    expected: { resourceId: "101", payload },
    observedInstallationId: "101",
  }), null);
  assert.equal(githubInstallationBindingError({
    expected: null,
    observedInstallationId: "101",
  }), "GITHUB_INSTALLATION_OBSERVATION_MISSING");
  assert.equal(githubInstallationBindingError({
    expected: { resourceId: "202", payload },
    observedInstallationId: "101",
  }), "GITHUB_INSTALLATION_BINDING_MISMATCH");
  assert.equal(githubInstallationBindingError({
    expected: {
      resourceId: "101",
      payload: {
        ...payload,
        attributes: {
          ...payload.attributes,
          capabilities: {
            ...payload.attributes.capabilities,
            callerBootstrapPullRequest: {
              state: "MISSING_REQUIREMENT",
              missing: ["permission:contents:write"],
            },
          },
        },
      },
    },
    observedInstallationId: "101",
  }), "GITHUB_INSTALLATION_MUTATION_CAPABILITY_MISSING");
});

test("signed mutation readback은 exact PR, 확정적 미적용, 결과 불명을 구분한다", () => {
  const grant = {
    repoId: 42n,
    repoFullName: "seorilabs/example",
    issueNumber: 123,
    sourceSha: SOURCE_SHA,
    expectedHeadRef: "refs/heads/seori/run-1",
    expectedPullRequestMarker: "seori-run:run-1:3",
    observation: { defaultBranchRef: "refs/heads/main", githubInstallationId: "101" },
  };
  const absent = agentGithubObservationSchema.parse(githubObservation({
    mutationTarget: {
      expectedHeadRef: grant.expectedHeadRef,
      expectedMarker: grant.expectedPullRequestMarker,
      headState: "ABSENT",
      headSha: null,
      complete: true,
      pageCount: 1,
      terminalCursor: null,
      pullRequests: [],
    },
  }));
  assert.deepEqual(githubMutationReadbackDisposition({ observation: absent, grant }), {
    status: "NOT_APPLIED",
    pullRequest: null,
  });

  const pullRequest = {
    number: 7,
    nodeId: "PR_node_7",
    url: "https://github.com/seorilabs/example/pull/7",
    state: "OPEN" as const,
    draft: false,
    headRef: grant.expectedHeadRef,
    headSha: "b".repeat(40),
    baseRef: "refs/heads/main",
    baseSha: SOURCE_SHA,
    marker: grant.expectedPullRequestMarker,
    closesIssueNumber: 123,
  };
  const verified = agentGithubObservationSchema.parse(githubObservation({
    openAutopilotPullRequests: [pullRequest],
    mutationTarget: {
      expectedHeadRef: grant.expectedHeadRef,
      expectedMarker: grant.expectedPullRequestMarker,
      headState: "PRESENT",
      headSha: pullRequest.headSha,
      complete: true,
      pageCount: 1,
      terminalCursor: null,
      pullRequests: [pullRequest],
    },
  }));
  assert.equal(githubMutationReadbackDisposition({ observation: verified, grant }).status, "VERIFIED");
  const closed = agentGithubObservationSchema.parse(githubObservation({
    openAutopilotPullRequests: [],
    mutationTarget: {
      ...verified.mutationTarget,
      headState: "ABSENT",
      headSha: null,
      pullRequests: [{ ...pullRequest, state: "CLOSED" }],
    },
  }));
  assert.equal(githubMutationReadbackDisposition({ observation: closed, grant }).status, "RESULT_UNKNOWN");
  const inconsistentOpenList = agentGithubObservationSchema.parse({
    ...verified,
    openAutopilotPullRequests: [{ ...pullRequest, headSha: "c".repeat(40) }],
  });
  assert.equal(githubMutationReadbackDisposition({ observation: inconsistentOpenList, grant }).status, "RESULT_UNKNOWN");
  const ambiguous = agentGithubObservationSchema.parse(githubObservation({
    mutationTarget: {
      expectedHeadRef: grant.expectedHeadRef,
      expectedMarker: grant.expectedPullRequestMarker,
      headState: "PRESENT",
      headSha: "c".repeat(40),
      complete: true,
      pageCount: 1,
      terminalCursor: null,
      pullRequests: [],
    },
  }));
  assert.equal(githubMutationReadbackDisposition({ observation: ambiguous, grant }).status, "RESULT_UNKNOWN");
  assert.equal(githubMutationReadbackDisposition({
    observation: { ...absent, githubInstallationId: "202" },
    grant,
  }).status, "RESULT_UNKNOWN");
  assert.equal(mutationReadbackTransitionError({
    currentStatus: "VERIFIED",
    nextStatus: "RESULT_UNKNOWN",
    currentPullRequestNumber: 7,
    nextPullRequestNumber: null,
  }), "MUTATION_READBACK_TERMINAL_CONFLICT");
  assert.equal(mutationReadbackTransitionError({
    currentStatus: "NOT_APPLIED",
    nextStatus: "VERIFIED",
    currentPullRequestNumber: null,
    nextPullRequestNumber: 7,
  }), "MUTATION_READBACK_TERMINAL_CONFLICT");
  assert.equal(mutationReadbackTransitionError({
    currentStatus: "RESULT_UNKNOWN",
    nextStatus: "VERIFIED",
    currentPullRequestNumber: null,
    nextPullRequestNumber: 7,
  }), null);
  const terminalEvidence = {
    status: "VERIFIED",
    pullRequestNumber: pullRequest.number,
    pullRequestNodeId: pullRequest.nodeId,
    pullRequestUrl: pullRequest.url,
    pullRequestHeadRef: pullRequest.headRef,
    pullRequestHeadSha: pullRequest.headSha,
    pullRequestBaseSha: pullRequest.baseSha,
    pullRequestMarker: pullRequest.marker,
    closesClaimedIssue: true,
  };
  assert.equal(mutationReadbackTerminalEvidenceError({
    current: terminalEvidence,
    nextStatus: "VERIFIED",
    nextPullRequest: pullRequest,
  }), null);
  assert.equal(mutationReadbackTerminalEvidenceError({
    current: terminalEvidence,
    nextStatus: "VERIFIED",
    nextPullRequest: { ...pullRequest, headSha: "c".repeat(40) },
  }), "MUTATION_READBACK_TERMINAL_EVIDENCE_MISMATCH");
  assert.equal(mutationReadbackTerminalEvidenceError({
    current: {
      ...terminalEvidence,
      status: "NOT_APPLIED",
      pullRequestNumber: null,
      pullRequestNodeId: null,
      pullRequestUrl: null,
      pullRequestHeadRef: null,
      pullRequestHeadSha: null,
      pullRequestBaseSha: null,
      pullRequestMarker: null,
      closesClaimedIssue: null,
    },
    nextStatus: "VERIFIED",
    nextPullRequest: pullRequest,
  }), "MUTATION_READBACK_TERMINAL_CONFLICT");
});

test("mutation step readback은 commit, ref, PR exact binding만 VERIFIED한다", () => {
  const expectedTreeSha = "b".repeat(40);
  const expectedCommitSha = "d".repeat(40);
  const expectedHeadRef = "refs/heads/seori/run-1-3";
  const expectedMarker = "seori-run:run-1:3";
  const grant = {
    repoId: 123n,
    repoFullName: "seorilabs/example",
    issueNumber: 7,
    sourceSha: SOURCE_SHA,
    expectedHeadRef,
    expectedPullRequestMarker: expectedMarker,
    observation: { defaultBranchRef: "refs/heads/main", githubInstallationId: "101" },
  };
  const observation = (stepKind: "CREATE_COMMIT" | "CREATE_REF" | "CREATE_PR") => (
    agentGithubMutationStepObservationSchema.parse({
      schemaVersion: 1,
      stepKind,
      githubInstallationId: "101",
      providerSnapshotId: `snapshot:${stepKind}`,
      complete: true,
      observedAt: NOW,
      repoId: "123",
      repoFullName: "seorilabs/example",
      defaultBranchRef: "refs/heads/main",
      defaultBranchSha: SOURCE_SHA,
      issue: {
        number: 7,
        nodeId: "I_7",
        state: "OPEN",
        labels: ["autopilot", "P1"],
        updatedAt: NOW,
      },
      expectedHeadRef,
      expectedPullRequestMarker: expectedMarker,
      expectedTreeSha,
      expectedCommitSha,
      commit: { sha: expectedCommitSha, treeSha: expectedTreeSha, parentSha: SOURCE_SHA },
      headSha: stepKind === "CREATE_COMMIT" ? null : expectedCommitSha,
      openAutopilotPullRequests: stepKind === "CREATE_PR" ? [{
        number: 9,
        nodeId: "PR_9",
        url: "https://github.com/seorilabs/example/pull/9",
        state: "OPEN",
        draft: false,
        headRef: expectedHeadRef,
        headSha: expectedCommitSha,
        baseRef: "refs/heads/main",
        baseSha: SOURCE_SHA,
        marker: expectedMarker,
        closesIssueNumber: 7,
      }] : [],
      pullRequests: stepKind === "CREATE_PR" ? [{
        number: 9,
        nodeId: "PR_9",
        url: "https://github.com/seorilabs/example/pull/9",
        state: "OPEN",
        draft: false,
        headRef: expectedHeadRef,
        headSha: expectedCommitSha,
        baseRef: "refs/heads/main",
        baseSha: SOURCE_SHA,
        marker: expectedMarker,
        closesIssueNumber: 7,
      }] : [],
    })
  );
  for (const stepKind of ["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"] as const) {
    assert.equal(githubMutationStepDisposition({
      stepKind,
      observation: observation(stepKind),
      grant,
      expectedTreeSha,
      expectedCommitSha,
    }).status, "VERIFIED");
  }
  assert.equal(githubMutationStepDisposition({
    stepKind: "CREATE_REF",
    observation: { ...observation("CREATE_REF"), headSha: "e".repeat(40) },
    grant,
    expectedTreeSha,
    expectedCommitSha,
  }).status, "RESULT_UNKNOWN");
  const extraOpen = {
    number: 10,
    nodeId: "PR_10",
    url: "https://github.com/seorilabs/example/pull/10",
    state: "OPEN" as const,
    draft: false,
    headRef: "refs/heads/seori/other-run",
    headSha: "e".repeat(40),
    baseRef: "refs/heads/main",
    baseSha: SOURCE_SHA,
    marker: "seori-run:other:1",
    closesIssueNumber: 8,
  };
  assert.equal(githubMutationStepDisposition({
    stepKind: "CREATE_PR",
    observation: {
      ...observation("CREATE_PR"),
      openAutopilotPullRequests: [
        ...observation("CREATE_PR").openAutopilotPullRequests,
        extraOpen,
      ],
    },
    grant,
    expectedTreeSha,
    expectedCommitSha,
  }).status, "RESULT_UNKNOWN");
});

test("READY_PR singleton과 write action은 run.createsPr가 아니라 managed action policy에서만 파생된다", () => {
  const ready = agentExecutionPolicy(automationPolicy({ approvalPolicy: "READY_PR", budgetCeilingMicros: 1 }), "START");
  const readOnly = agentExecutionPolicy(automationPolicy({ approvalPolicy: "READ_ONLY", budgetCeilingMicros: 1 }), "START");
  const readback = agentExecutionPolicy(automationPolicy({ approvalPolicy: "READY_PR", budgetCeilingMicros: 1 }), "READBACK_FIRST");
  assert.equal(agentRepositorySingletonScope("Seorilabs/Example", ready), "repo-pr:seorilabs/example");
  assert.equal(ready.mutationAction, "GITHUB_READY_PR_MUTATE");
  assert.equal(agentRepositorySingletonScope("Seorilabs/Example", readOnly), null);
  assert.equal(readOnly.mutationAction, null);
  assert.equal(readback.mutationAction, null);
  const authoritativeSources = [
    "src/lib/control-plane/agent-queue.ts",
    "src/lib/control-plane/agent-mutation-service.ts",
  ].map((path) => readFileSync(join(process.cwd(), path), "utf8")).join("\n");
  assert.doesNotMatch(authoritativeSources, /\.createsPr\b/);
});

test("worker가 주장한 PR 결과는 trusted mutation ledger의 VERIFIED execution 없이는 완료되지 않는다", async () => {
  const withoutExecution = {
    agentMutationExecution: { findMany: async () => [] },
  } as unknown as Prisma.TransactionClient;
  assert.deepEqual(await trustedMutationDisposition(withoutExecution, {
    runId: "run-1",
    sessionId: "agent-session:public-id",
    currentGeneration: 3,
    readbackResolution: false,
    result: {
      outcomeCode: "PR_READY",
      pullRequestNumber: 7,
      pullRequestUrl: "https://github.com/seorilabs/example/pull/7",
    },
  }), { mutationStarted: false, error: "TRUSTED_MUTATION_EVIDENCE_REQUIRED" });

  const expectedTreeSha = "d".repeat(40);
  const expectedCommitSha = "b".repeat(40);
  const mutationInputDigest = "e".repeat(64);
  const verifiedAt = new Date(NOW);
  const durableSteps = [
    {
      kind: "CREATE_COMMIT",
      ordinal: 1,
      status: "VERIFIED",
      generation: 2,
      inputDigest: mutationInputDigest,
      expectedTreeSha,
      expectedCommitSha,
      outputSha: expectedCommitSha,
      outputNumber: null,
      outputNodeId: null,
      outputUrl: null,
      claimExpiresAt: null,
      verifiedAt,
    },
    {
      kind: "CREATE_REF",
      ordinal: 2,
      status: "VERIFIED",
      generation: 1,
      inputDigest: mutationInputDigest,
      expectedTreeSha,
      expectedCommitSha,
      outputSha: expectedCommitSha,
      outputNumber: null,
      outputNodeId: null,
      outputUrl: null,
      claimExpiresAt: null,
      verifiedAt,
    },
    {
      kind: "CREATE_PR",
      ordinal: 3,
      status: "VERIFIED",
      generation: 1,
      inputDigest: mutationInputDigest,
      expectedTreeSha,
      expectedCommitSha,
      outputSha: expectedCommitSha,
      outputNumber: 7,
      outputNodeId: "PR_7",
      outputUrl: "https://github.com/seorilabs/example/pull/7",
      claimExpiresAt: null,
      verifiedAt,
    },
  ];
  assert.equal(githubMutationStepLedgerVerified(durableSteps), true);
  assert.equal(githubMutationStepLedgerVerified([]), false, "legacy 0-step execution은 완료 evidence가 아니다");
  assert.equal(githubMutationStepLedgerVerified(durableSteps.slice(0, 2)), false);
  assert.equal(githubMutationStepLedgerVerified(durableSteps.map((step) => (
    step.kind === "CREATE_REF" ? { ...step, status: "RESULT_UNKNOWN" } : step
  ))), false);

  const verifiedExecution = {
    id: "execution-1",
    status: "VERIFIED",
    pullRequestNumber: 7,
    pullRequestUrl: "https://github.com/seorilabs/example/pull/7",
    pullRequestHeadSha: expectedCommitSha,
    steps: durableSteps,
  };
  const withExecution = {
    agentMutationExecution: { findMany: async () => [verifiedExecution] },
  } as unknown as Prisma.TransactionClient;
  assert.deepEqual(await trustedMutationDisposition(withExecution, {
    runId: "run-1",
    sessionId: "agent-session:public-id",
    currentGeneration: 3,
    readbackResolution: false,
    result: {
      outcomeCode: "PR_READY",
      pullRequestNumber: 7,
      pullRequestUrl: verifiedExecution.pullRequestUrl,
      commitSha: verifiedExecution.pullRequestHeadSha,
      mutationExecutionId: verifiedExecution.id,
    },
  }), { mutationStarted: true, error: null });

  const legacyVerifiedExecution = { ...verifiedExecution, id: "legacy-execution", steps: [] };
  const legacyVerified = {
    agentMutationExecution: { findMany: async () => [legacyVerifiedExecution] },
  } as unknown as Prisma.TransactionClient;
  assert.deepEqual(await trustedMutationDisposition(legacyVerified, {
    runId: "run-1",
    sessionId: "agent-session:public-id",
    currentGeneration: 3,
    readbackResolution: false,
    result: {
      outcomeCode: "PR_READY",
      pullRequestNumber: 7,
      pullRequestUrl: legacyVerifiedExecution.pullRequestUrl,
      commitSha: legacyVerifiedExecution.pullRequestHeadSha,
      mutationExecutionId: legacyVerifiedExecution.id,
    },
  }), { mutationStarted: true, error: "TRUSTED_MUTATION_STEP_EVIDENCE_REQUIRED" });
  assert.deepEqual(await trustedMutationDisposition(withExecution, {
    runId: "run-1",
    sessionId: "agent-session:public-id",
    currentGeneration: 3,
    readbackResolution: false,
    result: { outcomeCode: "NO_CHANGES" },
  }), { mutationStarted: true, error: "TRUSTED_MUTATION_READBACK_REQUIRED" });

  const notApplied = {
    agentMutationExecution: { findMany: async () => [{ ...verifiedExecution, status: "NOT_APPLIED", steps: [] }] },
  } as unknown as Prisma.TransactionClient;
  assert.deepEqual(await trustedMutationDisposition(notApplied, {
    runId: "run-1",
    sessionId: "agent-session:readback",
    currentGeneration: 4,
    readbackResolution: true,
    result: { outcomeCode: "READBACK_CONFIRMED" },
  }), { mutationStarted: false, error: null });
});

test("migration은 session CAS와 1회 JIT grant/readback ledger를 tokenless unique key로 강제한다", () => {
  const migration = readFileSync(join(
    process.cwd(),
    "prisma/migrations/20260829110000_agent_worker_session_boundary/migration.sql",
  ), "utf8");
  assert.match(migration, /CREATE TABLE `agent_worker_session`[\s\S]*UNIQUE INDEX `agent_worker_session_run_generation_key`\(`runId`, `generation`\)/);
  assert.match(migration, /`runtimeBindingDigest` CHAR\(64\) NOT NULL[\s\S]*agent_worker_session_runtime_expiry_idx/);
  assert.match(migration, /CREATE TABLE `agent_adapter_nonce`[\s\S]*PRIMARY KEY \(`nonceDigest`\)/);
  const grantStart = migration.indexOf("CREATE TABLE `agent_action_grant`");
  const executionStart = migration.indexOf("CREATE TABLE `agent_mutation_execution`");
  const grantTable = migration.slice(grantStart, executionStart);
  assert.match(grantTable, /`consumedAt` DATETIME\(3\) NOT NULL/);
  assert.match(grantTable, /UNIQUE INDEX `agent_action_grant_request_id_key`/);
  assert.match(grantTable, /UNIQUE INDEX `agent_action_grant_run_generation_action_key`/);
  assert.doesNotMatch(grantTable, /(?:token|secret|credential)/i);

  const stepMigration = readFileSync(join(
    process.cwd(),
    "prisma/migrations/20260829130000_agent_mutation_step_ledger/migration.sql",
  ), "utf8");
  assert.match(stepMigration, /CREATE TABLE `agent_mutation_step`[\s\S]*agent_mutation_step_execution_kind_key/);
  assert.match(stepMigration, /CREATE TABLE `agent_mutation_step_attempt`[\s\S]*agent_mutation_step_attempt_generation_key/);
  assert.match(stepMigration, /`runtimeBindingDigest` CHAR\(64\) NOT NULL/);
  assert.match(stepMigration, /UNIQUE INDEX `agent_mutation_step_attempt_request_id_key`/);
  assert.match(stepMigration, /UNIQUE INDEX `agent_mutation_step_attempt_completion_request_id_key`/);
  assert.doesNotMatch(stepMigration, /(?:leaseToken|grantToken|actionToken|secret|credential)/i);
});
