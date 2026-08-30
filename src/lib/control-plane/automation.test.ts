import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import {
  automationPolicy,
  automationIdempotencyKey,
  definitionKey,
  dueScheduleSlots,
  fleetProjectFields,
} from "@/lib/control-plane/automation";
import {
  isManagedAutomationDefinition,
  parseManagedAutomationPolicy,
} from "@/lib/control-plane/automation-catalog";
import {
  agentResultPolicyError,
  agentReadbackRequestHash,
  agentSettlementRequestHash,
  expiredLeaseDisposition,
} from "@/lib/control-plane/agent-queue";
import {
  durableIssueObservation,
  durableIssueObservationHash,
  durableIngressEnvelopeHash,
  durableIssueToMirrorInput,
  durableRepositoryDiscovery,
  durableStableTagPush,
  durableStableTagPushHash,
  parseDurableIssueObservation,
  parseDurableRepositoryDiscovery,
  parseDurableStableTagPush,
} from "@/lib/control-plane/automation-inbox";
import {
  automationMutationIdentityMatches,
  automationMutationRequestHash,
} from "@/lib/control-plane/automation-mutation";
import {
  agentSessionActionSchema,
  agentCompletionSchema,
  agentReadbackRequiredSchema,
  agentReadbackResolutionSchema,
  agentResultSchema,
  automationDefinitionCreateSchema,
  containsCredentialCandidate,
  redactCredentialCandidates,
} from "@/lib/control-plane/contracts";
import { redactFleetJson } from "@/lib/control-plane/fleet-view";
import {
  authenticateInternalRequest,
  trustedGithubStepLedgerImplemented,
  trustedGithubRuntimeCanaryApproved,
  trustedMutationAdapterConfigured,
  workflowBundleCandidateExecutorConfigured,
} from "@/lib/control-plane/security";
import { shouldBackofficeAutoPublishReleaseNotes } from "@/lib/core/release-ownership";
import { repositoryAutomationEligible } from "@/lib/control-plane/repository-registration";

test("missed hourly schedule은 마지막 slot 다음부터 현재 경계까지 순서대로 복구한다", () => {
  const slots = dueScheduleSlots({
    cadence: "HOURLY",
    createdAt: new Date("2026-08-28T10:23:00.000Z"),
    lastScheduledFor: null,
    now: new Date("2026-08-28T13:59:59.999Z"),
  });
  assert.deepEqual(slots.map((slot) => slot.toISOString()), [
    "2026-08-28T11:00:00.000Z",
    "2026-08-28T12:00:00.000Z",
    "2026-08-28T13:00:00.000Z",
  ]);
  assert.deepEqual(dueScheduleSlots({
    cadence: "HOURLY",
    createdAt: new Date("2026-08-28T10:23:00.000Z"),
    lastScheduledFor: slots[1],
    now: new Date("2026-08-28T13:59:59.999Z"),
  }).map((slot) => slot.toISOString()), ["2026-08-28T13:00:00.000Z"]);
});

test("manual schedule은 자동 slot을 만들지 않고 catch-up limit은 다음 reconcile에 남긴다", () => {
  assert.deepEqual(dueScheduleSlots({
    cadence: "MANUAL",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    lastScheduledFor: null,
    now: new Date("2026-08-28T00:00:00.000Z"),
  }), []);
  const limited = dueScheduleSlots({
    cadence: "DAILY",
    createdAt: new Date("2026-08-01T01:00:00.000Z"),
    lastScheduledFor: null,
    now: new Date("2026-08-28T00:00:00.000Z"),
    limit: 2,
  });
  assert.deepEqual(limited.map((slot) => slot.toISOString()), [
    "2026-08-02T00:00:00.000Z",
    "2026-08-03T00:00:00.000Z",
  ]);
});

test("schedule과 webhook idempotency key는 동일 입력에 안정적이고 source가 바뀌면 달라진다", () => {
  const base = { definitionId: "def-1", triggerKind: "WEBHOOK" as const, triggerKey: "github:delivery-1" };
  assert.equal(automationIdempotencyKey(base), automationIdempotencyKey(base));
  assert.notEqual(automationIdempotencyKey(base), automationIdempotencyKey({ ...base, triggerKey: "github:delivery-2" }));
  assert.notEqual(
    definitionKey({ appId: "app-1", template: "repo-task-autopilot-v1", agentKind: "CODEX", cadence: "HOURLY" }),
    definitionKey({ appId: "app-1", template: "repo-task-autopilot-v1", agentKind: "CLAUDE", cadence: "HOURLY" }),
  );
  assert.notEqual(
    definitionKey({ appId: "app-1", template: "repo-task-autopilot-v1", agentKind: "CODEX", cadence: "MANUAL" }),
    definitionKey({ appId: "app-1", template: "repo-task-autopilot-v1", agentKind: "CODEX", cadence: "DAILY" }),
  );
});

test("Fleet automation은 MANAGED exact-source registration에서만 실행된다", () => {
  const legacyManaged = {
    archived: false,
    status: "MANAGED",
    managementKind: null,
    lastDefaultPushSha: null,
    lastReconciledSha: null,
  };
  assert.equal(repositoryAutomationEligible(legacyManaged), false, "legacy row는 exact discovery 전 새 Fleet 실행을 시작하지 않는다");
  assert.equal(repositoryAutomationEligible({
    ...legacyManaged,
    managementKind: "APP",
    lastDefaultPushSha: "a".repeat(40),
    lastReconciledSha: "a".repeat(40),
  }), true);
  assert.equal(repositoryAutomationEligible({
    ...legacyManaged,
    managementKind: "APP",
    lastDefaultPushSha: "a".repeat(40),
    lastReconciledSha: "b".repeat(40),
  }), false);
  assert.equal(repositoryAutomationEligible({
    ...legacyManaged,
    managementKind: "APP",
  }), false, "APP도 exact SHA 두 값이 채워지기 전에는 실행할 수 없다");
  assert.equal(repositoryAutomationEligible({ ...legacyManaged, status: "NEEDS_INPUT" }), false);
  assert.equal(repositoryAutomationEligible({ ...legacyManaged, archived: true }), false);
  assert.equal(repositoryAutomationEligible({ ...legacyManaged, managementKind: "UNCLASSIFIED" }), false);
  assert.equal(repositoryAutomationEligible({ ...legacyManaged, managementKind: "PLATFORM_PRODUCER" }), false);
  assert.equal(repositoryAutomationEligible(null), false);
});

test("Project projection은 고정 7개 field만 만들고 approval을 label에서 읽는다", () => {
  assert.deepEqual(fleetProjectFields({
    appSlug: "happy-farm",
    lifecycle: "QA",
    priority: "P1",
    labels: ["autopilot", "kind:platform", "approval:release"],
    agentKind: "CODEX",
    runStatus: "RUNNING",
    issueState: "OPEN",
  }), {
    priority: "P1",
    app: "happy-farm",
    kind: "platform",
    lifecycle: "QA",
    agent: "CODEX",
    approval: "release",
    outcome: "RUNNING",
  });
});

test("worker 결과 계약은 공개 usage만 허용하고 credential 후보와 임의 field를 거부한다", () => {
  const result = {
    outcomeCode: "PR_READY",
    summary: "PR #123 checks passed",
    pullRequestNumber: 123,
    pullRequestUrl: "https://github.com/seorilabs/example/pull/123",
    mutationExecutionId: "mutation-execution-123",
    model: "gpt-5.6-sol",
    inputTokens: 1_000,
    outputTokens: 200,
    costMicros: 42_000,
  };
  assert.equal(agentResultSchema.safeParse(result).success, true);
  assert.equal(agentResultSchema.safeParse({ ...result, summary: "Bearer abc.def.ghi" }).success, false);
  assert.equal(agentResultSchema.safeParse({ ...result, secret: "never" }).success, false);
  assert.equal(agentResultSchema.safeParse({ ...result, pullRequestUrl: undefined }).success, false);
  assert.equal(agentResultSchema.safeParse({ ...result, costMicros: undefined }).success, false);
  const syntheticToken = `ghp_${"a".repeat(36)}`;
  assert.equal(agentResultSchema.safeParse({ ...result, model: syntheticToken }).success, false);
  assert.equal(agentResultSchema.safeParse({ ...result, reauthRequestId: syntheticToken }).success, false);
  assert.equal(agentResultSchema.safeParse({
    ...result,
    pullRequestUrl: `https://github.com/seorilabs/example/pull/${syntheticToken}`,
  }).success, false);
  assert.equal(agentSessionActionSchema.safeParse({ sessionId: "session-1" }).success, true);
  assert.equal(agentSessionActionSchema.safeParse({
    sessionId: "session-1",
    runId: "run-1",
    generation: 1,
    leaseToken: "x".repeat(32),
  }).success, false);
  assert.equal(agentCompletionSchema.safeParse({
    sessionId: "session-1",
  }).success, false);
  assert.equal(agentReadbackRequiredSchema.safeParse({
    sessionId: "session-1",
    result: { outcomeCode: "RESULT_UNKNOWN", summary: "PR create response timed out", costMicros: 0 },
  }).success, true);
});

test("worker 결과와 Fleet redaction은 대표 secret과 opaque credential 후보를 fail-closed한다", () => {
  const candidates = [
    `gh${"p_"}${"a".repeat(36)}`,
    `github_${"pat_"}${"b".repeat(48)}`,
    `AI${"za"}${"C".repeat(35)}`,
    `AK${"IA"}${"D".repeat(16)}`,
    `Bearer ${"e".repeat(24)}`,
    `client_secret=${"f".repeat(24)}`,
    "mN7xQ2vB9cL4kP8sT5wY1zR6dF3hJ0uA",
  ];
  for (const candidate of candidates) {
    const summary = `debug output ${candidate}`;
    assert.equal(containsCredentialCandidate(summary), true, candidate.slice(0, 8));
    assert.equal(agentResultSchema.safeParse({ outcomeCode: "NO_CHANGES", summary }).success, false);
    assert.doesNotMatch(redactCredentialCandidates(summary), new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    assert.doesNotMatch(JSON.stringify(redactFleetJson({ summary })), new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  }
  const sourceSha = "a".repeat(40);
  const checksum = "b".repeat(64);
  const publicRequestId = "123e4567-e89b-42d3-a456-426614174000";
  const publicIdentifiers = `source ${sourceSha} checksum ${checksum} request ${publicRequestId}`;
  assert.equal(containsCredentialCandidate(publicIdentifiers), false);
  assert.equal(redactCredentialCandidates(publicIdentifiers), publicIdentifiers);
});

test("agent worker bearer는 고유 principal token에 결합되고 legacy shared token은 거부된다", () => {
  const names = [
    "AGENT_WORKER_TOKEN",
    "AGENT_WORKER_CODEX_TOKEN",
    "AGENT_WORKER_CLAUDE_TOKEN",
  ] as const;
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const runtimeBinding = "a".repeat(64);
  const request = (principal: string, token: string, header = "authorization", binding = runtimeBinding) => new NextRequest(
    "https://backoffice.invalid/api/internal/agents/claim",
    { headers: {
      [header]: header === "authorization" ? `Bearer ${token}` : token,
      "x-seori-principal": principal,
      ...(binding ? { "x-seori-worker-runtime-binding": binding } : {}),
    } },
  );
  try {
    process.env.AGENT_WORKER_TOKEN = "legacy-unit-token";
    delete process.env.AGENT_WORKER_CODEX_TOKEN;
    delete process.env.AGENT_WORKER_CLAUDE_TOKEN;
    assert.equal(authenticateInternalRequest(
      request("codex:seorilabs-generic-worker", "legacy-unit-token"),
      "agent-worker",
    ), null);

    process.env.AGENT_WORKER_CODEX_TOKEN = "codex-unit-token";
    process.env.AGENT_WORKER_CLAUDE_TOKEN = "claude-unit-token";
    assert.equal(authenticateInternalRequest(
      request("codex:seorilabs-generic-worker", "codex-unit-token"),
      "agent-worker",
    )?.id, "codex:seorilabs-generic-worker");
    assert.equal(authenticateInternalRequest(
      request("codex:seorilabs-generic-worker", "codex-unit-token", "authorization", ""),
      "agent-worker",
    ), null);
    assert.equal(authenticateInternalRequest(
      request("claude:seorilabs-generic-worker", "codex-unit-token"),
      "agent-worker",
    ), null);
    assert.equal(authenticateInternalRequest(
      request("codex:seorilabs-generic-worker", "codex-unit-token", "x-admin-token"),
      "agent-worker",
    ), null);

    process.env.AGENT_WORKER_CODEX_TOKEN = "duplicate-unit-token";
    process.env.AGENT_WORKER_CLAUDE_TOKEN = "duplicate-unit-token";
    assert.equal(authenticateInternalRequest(
      request("codex:seorilabs-generic-worker", "duplicate-unit-token"),
      "agent-worker",
    ), null);
  } finally {
    for (const name of names) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("control-plane admin token은 설정된 단일 workload principal과 결합된다", () => {
  const names = ["CONTROL_PLANE_ADMIN_TOKEN", "CONTROL_PLANE_ADMIN_PRINCIPAL"] as const;
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.CONTROL_PLANE_ADMIN_TOKEN = "control-plane-unit-token";
    process.env.CONTROL_PLANE_ADMIN_PRINCIPAL = "backoffice:fleet-operator";
    const request = (principal: string) => new NextRequest(
      "https://backoffice.invalid/api/control-plane/automation-definitions",
      { headers: {
        authorization: "Bearer control-plane-unit-token",
        "x-seori-principal": principal,
      } },
    );
    assert.equal(authenticateInternalRequest(
      request("backoffice:fleet-operator"),
      "control-plane",
    )?.id, "backoffice:fleet-operator");
    assert.equal(authenticateInternalRequest(
      request("spoofed:operator"),
      "control-plane",
    ), null);
    delete process.env.CONTROL_PLANE_ADMIN_PRINCIPAL;
    assert.equal(authenticateInternalRequest(
      request("backoffice:fleet-operator"),
      "control-plane",
    ), null);
  } finally {
    for (const name of names) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("readback resolution은 공개 session ID와 비용을 요구하고 raw lease 입력을 거부한다", () => {
  const base = {
    sessionId: "session-2",
    resolution: "RESUME",
    result: { outcomeCode: "READBACK_CONFIRMED", summary: "PR does not exist", costMicros: 0 },
  };
  assert.equal(agentReadbackResolutionSchema.safeParse(base).success, true);
  const withoutSession = {
    resolution: base.resolution,
    result: base.result,
  };
  assert.equal(agentReadbackResolutionSchema.safeParse(withoutSession).success, false);
  assert.equal(agentReadbackResolutionSchema.safeParse({
    ...base,
    leaseToken: "x".repeat(32),
  }).success, false);
  assert.equal(agentReadbackResolutionSchema.safeParse({
    ...base,
    result: { ...base.result, outcomeCode: "NO_CHANGES" },
  }).success, false);
});

test("durable webhook inbox는 issue body를 버리고 marker와 공개 observation만 checksum으로 봉인한다", () => {
  const observation = durableIssueObservation({
    number: 17,
    node_id: "I_node",
    title: "P1 fleet work",
    state: "open",
    state_reason: null,
    body: "password=never-store\n<!-- bo:req=123e4567-e89b-12d3-a456-426614174000 -->",
    user: { login: "operator" },
    assignees: [{ login: "codex" }],
    labels: [{ name: "autopilot" }, { name: "P1" }],
    milestone: { title: "Fleet" },
    created_at: "2026-08-28T00:00:00.000Z",
    updated_at: "2026-08-28T00:01:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(observation), /never-store/);
  assert.equal(observation.clientRequestId, "123e4567-e89b-12d3-a456-426614174000");
  const binding = {
    sourceKey: "github:delivery-issue",
    event: "issues",
    action: "opened",
    repoFullName: "seorilabs/example",
  };
  const hash = durableIngressEnvelopeHash({ ...binding, payload: observation });
  assert.deepEqual(parseDurableIssueObservation({ ...binding, payload: observation, payloadHash: hash }), observation);
  assert.equal(durableIssueToMirrorInput(observation).body, "<!-- bo:req=123e4567-e89b-12d3-a456-426614174000 -->");
  assert.throws(
    () => parseDurableIssueObservation({ ...binding, payload: { ...observation, state: "closed" }, payloadHash: hash }),
    /checksum mismatch/,
  );
  assert.notEqual(durableIssueObservationHash(observation), hash);
});

test("정식 tag push만 durable inbox에 봉인하고 snapshot, 삭제, 손상 SHA는 거부한다", () => {
  const tag = durableStableTagPush({
    ref: "refs/tags/v1.2.3",
    created: true,
    deleted: false,
    after: "a".repeat(40),
  });
  assert.ok(tag);
  const binding = {
    sourceKey: "github:delivery-tag",
    event: "push",
    action: null,
    repoFullName: "seorilabs/example",
  };
  const payloadHash = durableIngressEnvelopeHash({ ...binding, payload: tag });
  assert.deepEqual(parseDurableStableTagPush({ ...binding, payload: tag, payloadHash }), tag);
  assert.throws(
    () => parseDurableStableTagPush({ ...binding, payload: tag, payloadHash: "0".repeat(64) }),
    /checksum mismatch/,
  );
  assert.notEqual(durableStableTagPushHash(tag), payloadHash);
  assert.throws(
    () => parseDurableStableTagPush({ ...binding, repoFullName: "seorilabs/other", payload: tag, payloadHash }),
    /checksum mismatch/,
  );
  assert.equal(durableStableTagPush({
    ref: "refs/tags/v1.2.3-snapshot.1",
    created: true,
    after: "a".repeat(40),
  }), null);
  assert.equal(durableStableTagPush({
    ref: "refs/tags/v1.2.3",
    created: false,
    deleted: true,
    after: "0".repeat(40),
  }), null);
  assert.equal(durableStableTagPush({
    ref: "refs/tags/v1.2.3",
    created: true,
    after: "not-a-sha",
  }), null);
});

test("default push와 repository lifecycle은 공개 identity만 durable discovery payload로 봉인한다", () => {
  const discovery = durableRepositoryDiscovery({
    event: "push",
    repository: {
      id: 123456,
      full_name: "seorilabs/example",
      name: "example",
      default_branch: "main",
      private: true,
      archived: false,
    },
    ref: "refs/heads/main",
    after: "a".repeat(40),
    organization: "seorilabs",
  });
  assert.ok(discovery);
  const binding = {
    sourceKey: "github:delivery-discovery",
    event: "push",
    action: null,
    repoFullName: "seorilabs/example",
  };
  const payloadHash = durableIngressEnvelopeHash({ ...binding, payload: discovery });
  assert.deepEqual(parseDurableRepositoryDiscovery({
    ...binding,
    payload: discovery,
    payloadHash,
  }), discovery);
  assert.equal(durableRepositoryDiscovery({
    event: "push",
    repository: {
      id: 123456,
      full_name: "seorilabs/example",
      default_branch: "main",
    },
    ref: "refs/tags/v1.2.3",
    after: "a".repeat(40),
    organization: "seorilabs",
  }), null);
  assert.throws(() => parseDurableRepositoryDiscovery({
    ...binding,
    repoFullName: "seorilabs/other",
    payload: discovery,
    payloadHash,
  }), /binding mismatch/);
});

test("release-note 자동 발행은 조직의 exact platform repo만 제외하고 다른 tag repo를 유지한다", () => {
  assert.equal(shouldBackofficeAutoPublishReleaseNotes("seorilabs/platform", "seorilabs"), false);
  assert.equal(shouldBackofficeAutoPublishReleaseNotes("SeoriLabs/Platform", "seorilabs"), false);
  assert.equal(shouldBackofficeAutoPublishReleaseNotes("seorilabs/platform-tools", "seorilabs"), true);
  assert.equal(shouldBackofficeAutoPublishReleaseNotes("another/platform", "seorilabs"), true);

  const webhook = readFileSync(join(process.cwd(), "src/app/api/webhooks/route.ts"), "utf8");
  const service = readFileSync(join(process.cwd(), "src/lib/control-plane/automation-service.ts"), "utf8");
  const releaseOps = readFileSync(join(process.cwd(), "src/lib/core/release-ops.ts"), "utf8");
  assert.match(webhook, /stableTagPush: stableTagObservation/);
  assert.match(webhook, /drainAutomationIngress\(\{ sourceKey: `github:\$\{deliveryId\}`/);
  assert.doesNotMatch(webhook, /import \{ generateAndPublishReleaseNotes \}/);
  assert.match(
    service,
    /shouldBackofficeAutoPublishReleaseNotes\(event\.repoFullName, env\.githubOrg\(\)\)[\s\S]*generateAndPublishReleaseNotes/,
  );
  assert.match(service, /resolveRefSha\(event\.repoFullName, tag\.version\)[\s\S]*tag\.headSha/);
  assert.match(service, /status: "PROCESSING", attempts: claimGeneration/);
  assert.ok(
    releaseOps.indexOf("shouldBackofficeAutoPublishReleaseNotes(opts.repoFullName")
      < releaseOps.indexOf("const targetRef = opts.targetRef"),
  );
});

test("legacy AutomationDefinition은 기본값 승격 없이 실행과 UI에서 fail-closed한다", () => {
  const configuration = automationPolicy({ approvalPolicy: "READY_PR", budgetCeilingMicros: 1_000_000 });
  assert.deepEqual(parseManagedAutomationPolicy(configuration), configuration);
  assert.equal(isManagedAutomationDefinition({
    template: "repo-task-autopilot-v1",
    agentKind: "CODEX",
    configuration,
  }), true);
  assert.equal(isManagedAutomationDefinition({ template: "legacy", agentKind: null, configuration: null }), false);
  assert.equal(parseManagedAutomationPolicy({ approvalPolicy: "READY_PR" }), null);
  assert.equal(parseManagedAutomationPolicy({ ...configuration, unreviewed: true }), null);
});

test("READ_ONLY action과 누적 run budget은 settlement 전에 fail-closed한다", () => {
  const readOnly = automationPolicy({ approvalPolicy: "READ_ONLY", budgetCeilingMicros: 100 });
  assert.equal(agentResultPolicyError({
    policy: readOnly,
    configuredModel: null,
    spentMicros: 20n,
    result: { outcomeCode: "NO_CHANGES", costMicros: 30 },
  }), null);
  assert.equal(agentResultPolicyError({
    policy: readOnly,
    configuredModel: null,
    spentMicros: 20n,
    result: { outcomeCode: "ISSUE_RESOLVED", costMicros: 0 },
  }), "APPROVAL_POLICY_VIOLATION");
  assert.equal(agentResultPolicyError({
    policy: readOnly,
    configuredModel: null,
    spentMicros: 80n,
    result: { outcomeCode: "NO_CHANGES", costMicros: 21 },
  }), "BUDGET_CEILING_EXCEEDED");
  assert.equal(agentResultPolicyError({
    policy: readOnly,
    configuredModel: null,
    spentMicros: 0n,
    result: { outcomeCode: "NO_CHANGES" },
  }), "RESULT_COST_REQUIRED");
});

test("READY_PR은 worker와 분리된 trusted adapter identity가 없으면 생성과 claim이 fail-closed다", () => {
  const names = [
    "AGENT_TRUSTED_ADAPTER_PRINCIPAL",
    "AGENT_TRUSTED_ADAPTER_RUNTIME_IDENTITY",
    "AGENT_TRUSTED_ADAPTER_DEPLOYED",
    "AGENT_TRUSTED_ADAPTER_TOKEN",
    "AGENT_TRUSTED_ADAPTER_PUBLIC_KEY",
    "WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_DEPLOYED",
    "AGENT_WORKER_CODEX_TOKEN",
    "CONTROL_PLANE_ADMIN_PRINCIPAL",
  ] as const;
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.equal(trustedMutationAdapterConfigured(), false);
    process.env.AGENT_TRUSTED_ADAPTER_PRINCIPAL = "seori-auth:github-adapter";
    process.env.AGENT_TRUSTED_ADAPTER_RUNTIME_IDENTITY = "spiffe://seorilabs.local/ns/auth-broker/sa/github-adapter";
    process.env.AGENT_TRUSTED_ADAPTER_DEPLOYED = "true";
    process.env.AGENT_TRUSTED_ADAPTER_TOKEN = "adapter-test-token";
    process.env.AGENT_TRUSTED_ADAPTER_PUBLIC_KEY = "not-an-ed25519-public-key";
    assert.equal(trustedMutationAdapterConfigured(), false, "검증 불가능한 public key를 거부한다");
    process.env.AGENT_TRUSTED_ADAPTER_PUBLIC_KEY = generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    assert.equal(trustedGithubStepLedgerImplemented(), true);
    assert.equal(trustedGithubRuntimeCanaryApproved(), false);
    assert.equal(trustedMutationAdapterConfigured(), false, "실제 GitHub canary 승인 전에는 activation을 열지 않는다");
    assert.equal(workflowBundleCandidateExecutorConfigured(), false, "candidate executor는 별도 deploy gate 전에는 닫혀 있다");
    process.env.WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_DEPLOYED = "true";
    assert.equal(workflowBundleCandidateExecutorConfigured(), true, "candidate 전용 gate는 유효한 adapter identity에서만 열린다");
    process.env.AGENT_WORKER_CODEX_TOKEN = "adapter-test-token";
    assert.equal(trustedMutationAdapterConfigured(), false, "worker token 재사용을 거부한다");
    delete process.env.AGENT_WORKER_CODEX_TOKEN;
    process.env.CONTROL_PLANE_ADMIN_PRINCIPAL = "seori-auth:github-adapter";
    assert.equal(trustedMutationAdapterConfigured(), false, "admin principal 재사용을 거부한다");
    const service = readFileSync(join(process.cwd(), "src/lib/control-plane/automation-service.ts"), "utf8");
    const queue = readFileSync(join(process.cwd(), "src/lib/control-plane/agent-queue.ts"), "utf8");
    assert.match(service, /approvalPolicy === "READY_PR"[\s\S]*MUTATION_CAPABILITY_BROKER_REQUIRED/);
    assert.match(queue, /trustedMutationRuntimeAvailable \?\? trustedMutationAdapterConfigured\(\)/);
  } finally {
    for (const name of names) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("PR-capable lease 만료는 시도 상한에서도 dead-letter 대신 durable readback으로 간다", () => {
  assert.deepEqual(expiredLeaseDisposition({
    mutationStarted: true,
    readbackRequested: false,
    attempts: 3,
    maxAttempts: 3,
  }), {
    readbackRequired: true,
    terminal: false,
    status: "FAILED",
    eventType: "readback_required",
  });
  assert.equal(expiredLeaseDisposition({
    mutationStarted: false,
    readbackRequested: false,
    attempts: 3,
    maxAttempts: 3,
  }).status, "DEAD_LETTER");
  assert.equal(expiredLeaseDisposition({
    mutationStarted: false,
    readbackRequested: true,
    attempts: 3,
    maxAttempts: 3,
  }).status, "FAILED");
});

test("automation mutation idempotency 원장은 actor, operation, target, payload 전체를 hash에 결합한다", () => {
  const identity = {
    actor: "operator",
    operation: "RUN_NOW",
    targetKey: "definition:def-1",
    request: { command: "RUN_NOW" },
  } as const;
  const hash = automationMutationRequestHash(identity);
  assert.equal(hash, automationMutationRequestHash(identity));
  assert.notEqual(hash, automationMutationRequestHash({ ...identity, targetKey: "definition:def-2" }));
  assert.equal(automationMutationIdentityMatches({ ...identity, requestHash: hash }, {
    requestId: "request-1",
    ...identity,
  }, hash), true);
  assert.equal(automationMutationIdentityMatches({ ...identity, requestHash: hash }, {
    requestId: "request-1",
    ...identity,
    actor: "other",
  }, hash), false);
});

test("worker settlement와 readback idempotency는 전체 result와 비용에 결합된다", () => {
  const settlement = {
    outcome: "complete" as const,
    result: { outcomeCode: "NO_CHANGES", summary: "done", costMicros: 10 },
  };
  assert.equal(agentSettlementRequestHash(settlement), agentSettlementRequestHash(settlement));
  assert.notEqual(
    agentSettlementRequestHash(settlement),
    agentSettlementRequestHash({ ...settlement, result: { ...settlement.result, costMicros: 11 } }),
  );
  const readback = {
    resolution: "RESUME" as const,
    result: { outcomeCode: "READBACK_CONFIRMED", summary: "absent", costMicros: 0 },
  };
  assert.notEqual(
    agentReadbackRequestHash(readback),
    agentReadbackRequestHash({ ...readback, result: { ...readback.result, summary: "different" } }),
  );
});

test("routine 생성 validator는 공개 template, agent, cadence만 허용한다", () => {
  const valid = {
    repoId: "123",
    template: "repo-task-autopilot-v1",
    agentKind: "CODEX",
    cadence: "HOURLY",
    approvalPolicy: "READ_ONLY",
    budgetCeilingMicros: 500_000,
    maxAttempts: 3,
  };
  assert.equal(automationDefinitionCreateSchema.safeParse(valid).success, true);
  assert.equal(automationDefinitionCreateSchema.safeParse({ ...valid, agentKind: "SHELL" }).success, false);
  assert.equal(automationDefinitionCreateSchema.safeParse({ ...valid, credential: "never" }).success, false);
  assert.equal(automationPolicy({ approvalPolicy: "READ_ONLY", budgetCeilingMicros: 500_000 }).createsPr, false);
});

test("migration은 기존 enum/table을 파괴하지 않고 inbox, work dedupe, repo guard를 확장한다", () => {
  const migration = readFileSync(join(
    process.cwd(),
    "prisma/migrations/20260828210000_fleet_agent_automation/migration.sql",
  ), "utf8");
  assert.doesNotMatch(migration, /\b(?:DROP|MODIFY|CHANGE|TRUNCATE|RENAME)\b/i);
  assert.match(migration, /ADD COLUMN `workKey` VARCHAR\(191\) NULL/);
  assert.match(migration, /ADD COLUMN `spentMicros` BIGINT NULL/);
  assert.match(migration, /UNIQUE INDEX `agent_run_workKey_key`/);
  assert.match(migration, /UNIQUE INDEX `agent_repo_guard_activeScopeKey_key`/);
  assert.match(migration, /UNIQUE INDEX `automation_ingress_event_sourceKey_key`/);
  assert.match(migration, /`payloadHash` CHAR\(64\) NULL/);
  assert.match(migration, /CREATE TABLE `automation_mutation_request`/);
  assert.match(migration, /UNIQUE INDEX `fleet_project_projection_projectNodeId_issueNodeId_key`/);
});

test("GitHub delivery와 automation inbox는 handler보다 먼저 같은 durable 경계에 기록된다", () => {
  const webhook = readFileSync(join(process.cwd(), "src/app/api/webhooks/route.ts"), "utf8");
  const service = readFileSync(join(process.cwd(), "src/lib/control-plane/automation-service.ts"), "utf8");
  assert.ok(webhook.indexOf("const delivery = await recordWebhookDelivery") < webhook.indexOf("await handleEvent(event"));
  const duplicateStart = webhook.indexOf("if (delivery.duplicate)");
  assert.ok(duplicateStart >= 0);
  assert.match(webhook, /repositoryDiscovery: discoveryObservation/);
  assert.match(webhook, /stableTagObservation \|\| discoveryObservation/);
  assert.doesNotMatch(webhook, /webhookDelivery\.deleteMany/);
  assert.match(service, /prisma\.\$transaction[\s\S]*webhookDelivery\.createMany[\s\S]*automationIngressEvent\.createMany/);
  assert.match(service, /parseDurableRepositoryDiscovery[\s\S]*repositoryDiscoveryReadback[\s\S]*registerRepositoryWebhook/);
  assert.match(service, /parseDurableIssueObservation[\s\S]*upsertIssue[\s\S]*issue mirror did not converge/);
});

test("Fleet UI 상단 parity gate는 현재 source와 ACTIVE config vector만 신뢰한다", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/apps/[id]/fleet/page.tsx"), "utf8");
  assert.match(page, /latestObservedParity\?\.sourceSha === latestDiscovery\.sourceSha/);
  assert.match(page, /latestObservedParity\.configRevisionId === activeConfig\.id/);
  assert.match(page, /현재 벡터 미검증/);
});

test("RESULT_UNKNOWN은 새 readback lease 재claim 뒤에만 resolve되고 mutation audit은 ledger CAS와 함께 기록된다", () => {
  const queue = readFileSync(join(process.cwd(), "src/lib/control-plane/agent-queue.ts"), "utf8");
  const mutation = readFileSync(join(process.cwd(), "src/lib/control-plane/automation-mutation.ts"), "utf8");
  assert.match(queue, /status: "FAILED", readbackRequestedAt: \{ not: null \}/);
  assert.match(queue, /const priorSession = readbackClaim[\s\S]*generation: \{ lte: run\.leaseGeneration \}[\s\S]*sourceSha/);
  assert.match(queue, /const sourceLease = session\.lease[\s\S]*agentWorkerSessionStateError[\s\S]*run\.status !== "RUNNING"[\s\S]*readbackRequestedAt/);
  assert.match(queue, /agentWorkerSession\.update[\s\S]*revokedAt: now, settledAt: now, expiresAt: now/);
  assert.match(mutation, /status: "PENDING"[\s\S]*auditLog\.create/);
});

test("Project projection은 claim source가 아니며 durable scheduler가 운영 manifest에 고정된다", () => {
  const queue = readFileSync(join(process.cwd(), "src/lib/control-plane/agent-queue.ts"), "utf8");
  const deployedSchedulers = readFileSync(join(process.cwd(), "k8s/scheduler-cronjobs.yaml"), "utf8");
  assert.doesNotMatch(queue, /fleetProjectProjection|projectNodeId|ProjectV2/);
  assert.match(deployedSchedulers, /name: backoffice-automation-scheduler/);
  assert.match(deployedSchedulers, /schedule: "\* \* \* \* \*"[\s\S]*suspend: false/);
  assert.match(deployedSchedulers, /\/api\/admin\/automation\/schedule/);
});

test("PR_READY repo guard는 PR closed readback 전까지 유지된다", () => {
  const queue = readFileSync(join(process.cwd(), "src/lib/control-plane/agent-queue.ts"), "utf8");
  const webhook = readFileSync(join(process.cwd(), "src/app/api/webhooks/route.ts"), "utf8");
  assert.match(queue, /retainsPrGuard[\s\S]*outcomeCode === "PR_READY"/);
  assert.match(queue, /if \(!pullRequest \|\| pullRequest\.state === "OPEN"\) continue/);
  assert.match(webhook, /upsertPr[\s\S]*reconcileTerminalRepoGuards/);
});

test("closed 또는 blocked issue의 work key는 eligibility가 돌아왔을 때 같은 이슈를 다시 소진할 수 있게 해제한다", () => {
  const service = readFileSync(join(process.cwd(), "src/lib/control-plane/automation-service.ts"), "utf8");
  assert.match(service, /work_key_released_ineligible/);
  assert.match(service, /workKey: \{ not: null \}[\s\S]*data: \{ workKey: null \}/);
  assert.match(service, /cancellation_readback_required/);
  assert.match(service, /single Seorilabs Fleet Project|단일 Seorilabs Fleet Project/);
});

test("generic worker contract은 Codex와 Claude 설치를 각각 하나로 제한한다", () => {
  const contract = JSON.parse(readFileSync(join(
    process.cwd(),
    "docs/automation/seorilabs-worker-contract.v1.json",
  ), "utf8")) as {
    workerInstallations: Array<{ key: string; agentKind: string; maximumActiveInstallations: number }>;
    authentication: {
      transport: { local: string; kubernetes: string };
      distinctCapabilitiesRequired: boolean;
      legacySharedTokenAccepted: boolean;
      workerVisibleCredentialMaterial: boolean;
      publicSessionField: string;
      forbidden: string[];
    };
    claimPolicy: {
      fields: string[];
      templatePolicies: Record<string, string>;
    };
  };
  assert.deepEqual(contract.workerInstallations.map((worker) => worker.agentKind).sort(), ["CLAUDE", "CODEX"]);
  assert.equal(new Set(contract.workerInstallations.map((worker) => worker.key)).size, 2);
  assert.equal(contract.workerInstallations.every((worker) => worker.maximumActiveInstallations === 1), true);
  assert.match(contract.authentication.transport.local, /seori-auth/);
  assert.match(contract.authentication.transport.kubernetes, /seori-auth/);
  assert.equal(contract.authentication.distinctCapabilitiesRequired, true);
  assert.equal(contract.authentication.legacySharedTokenAccepted, false);
  assert.equal(contract.authentication.workerVisibleCredentialMaterial, false);
  assert.equal(contract.authentication.publicSessionField, "sessionId");
  assert.equal(contract.authentication.forbidden.includes("leaseToken"), true);
  assert.equal(contract.claimPolicy.fields.includes("template"), true);
  assert.equal(contract.claimPolicy.fields.includes("taskInput"), true);
  assert.match(contract.claimPolicy.templatePolicies["platform-fleet-reconcile-v1"], /CODEX/);
});
