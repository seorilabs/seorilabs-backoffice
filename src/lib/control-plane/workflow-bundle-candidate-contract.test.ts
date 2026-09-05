import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKFLOW_BUNDLE_CANDIDATE_AUTOMATION_POLICY,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
  parseManagedWorkerPolicy,
} from "@/lib/control-plane/automation-catalog";
import { resolveGithubMutationTarget } from "@/lib/control-plane/agent-mutation-service";
import { trustedExecutorHeartbeatGenerationError } from "@/lib/control-plane/trusted-mutation-executor-service";
import { canonicalJson, jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";
import {
  buildWorkflowBundleCandidateTask,
  candidateHeadRef,
  prepareWorkflowBundleCandidateFiles,
  workflowBundleCandidateExecutorRequestSchema,
  workflowBundleCandidateTaskSchema,
} from "@/lib/control-plane/workflow-bundle-candidate-contract";

const BUNDLE_SHA = "6".repeat(40);
const APP_SHA = "a".repeat(40);

function bundle() {
  const payload = {
    schemaVersion: 2,
    bundleVersion: "5.0.0",
    source: {
      repository: "seorilabs/.github",
      sha: BUNDLE_SHA,
      workflowExecutionSha: BUNDLE_SHA,
    },
    quality: {
      contractDigests: { "contracts/v5.json": `sha256:${"1".repeat(64)}` },
      runtimeAssetDigests: { "cloud-build/rn.yaml": `sha256:${"2".repeat(64)}` },
    },
    promotionScope: {
      staticProfiles: ["react-native", "godot", "capacitor", "ait-web"],
      buildProfiles: ["react-native-android", "godot-android"],
    },
    staticRuntimeBinding: {},
    buildRuntimeBinding: {},
    staticProfiles: {
      "react-native": {
        path: ".github/workflows/js-static-checks-v1.yml",
        runtime: "react-native",
        sha: BUNDLE_SHA,
      },
      godot: {
        path: ".github/workflows/godot-checks-v3.yml",
        runtime: "godot",
        sha: BUNDLE_SHA,
      },
      capacitor: {
        path: ".github/workflows/js-static-checks-v1.yml",
        runtime: "capacitor",
        sha: BUNDLE_SHA,
      },
      "ait-web": {
        path: ".github/workflows/js-static-checks-v1.yml",
        runtime: "ait-web",
        sha: BUNDLE_SHA,
      },
    },
    buildProfiles: {
      "react-native-android": {
        target: "android",
        executor: "cloud-build-x64",
        workflow: ".github/workflows/rn-build-android-cloud-v2.yml",
        artifactKind: "android-aab",
        scriptPath: "scripts/build-android.sh",
        builderImage: `registry/rn@sha256:${"3".repeat(64)}`,
        sha: BUNDLE_SHA,
      },
      "godot-android": {
        target: "android",
        executor: "cloud-build-x64",
        workflow: ".github/workflows/godot-build-android-cloud-v2.yml",
        artifactKind: "android-aab",
        scriptPath: "scripts/build-android.sh",
        builderImage: `registry/godot@sha256:${"4".repeat(64)}`,
        sha: BUNDLE_SHA,
      },
    },
    actions: {},
    runners: {},
    toolchains: {},
    callerPolicies: {},
    lifecyclePolicy: {},
    approval: { state: "CANDIDATE", evidence: [] },
  } as const;
  return {
    ...payload,
    integrity: {
      algorithm: "sha256",
      payloadDigest: `sha256:${jsonDigest(payload as unknown as JsonValue)}`,
    },
  };
}

function task(input: {
  appSha?: string;
  configId?: string;
  configRevision?: number;
  snapshotDigest?: string;
} = {}) {
  const candidate = bundle();
  const appSha = input.appSha ?? APP_SHA;
  return buildWorkflowBundleCandidateTask({
    record: {
      id: "candidate-record-1",
      approvalState: "CANDIDATE",
      sourceSha: BUNDLE_SHA,
      payloadDigest: candidate.integrity.payloadDigest,
      artifactRunId: 33284412163n,
      artifactId: 9723970878n,
      artifactDigest: `sha256:${"5".repeat(64)}`,
      bundle: candidate,
    },
    resolved: {
      app: { status: "ACTIVE", repoFullName: "seorilabs/happy-farm", repoId: "1250442131" },
      source: { sha: appSha, ref: "refs/heads/main" },
      workflowCaller: { profile: "react-native" },
      config: {
        id: input.configId ?? "config-revision-5",
        revision: input.configRevision ?? 5,
        status: "ACTIVE",
        digest: input.snapshotDigest ?? "7".repeat(64),
        signature: "8".repeat(64),
      },
      workflowBundleBinding: {
        sourceSha: BUNDLE_SHA,
        payloadDigest: candidate.integrity.payloadDigest,
      },
    },
    repositoryId: "1250442131",
    fullName: "seorilabs/happy-farm",
    sourceSha: appSha,
    defaultBranch: "main",
    issueNumber: null,
    installationId: "12345678",
  });
}

test("candidate task는 exact registry/config/source와 두 caller만 고정한다", () => {
  const candidate = task();
  assert.equal(candidate.github.expectedHeadRef.startsWith(
    `refs/heads/seori/workflow-bundle-v5-canary/1250442131/${BUNDLE_SHA.slice(0, 12)}/`,
  ), true);
  assert.match(candidate.github.expectedHeadRef, /\/[0-9a-f]{12}\/[0-9a-f]{64}$/u);
  assert.match(candidate.github.expectedPullRequestMarker, /^seori-run:workflow-bundle-v5-canary:/u);
  const files = prepareWorkflowBundleCandidateFiles(candidate);
  assert.deepEqual(files.map((file) => file.path), [
    ".github/workflows/android-build-only.yml",
    ".github/workflows/org-contract.yml",
  ]);
  const staticCaller = files.find((file) => file.path.endsWith("org-contract.yml"))?.content ?? "";
  const buildCaller = files.find((file) => file.path.endsWith("android-build-only.yml"))?.content ?? "";
  assert.equal(staticCaller, [
    "# WorkflowBundle v5 generator가 관리합니다. 수동 편집하지 마십시오.",
    "name: Org Contract",
    "on:",
    "  pull_request:",
    "    paths:",
    "      - .github/workflows/org-contract.yml",
    "permissions:",
    "  contents: read",
    "  id-token: write",
    "  packages: read",
    "concurrency:",
    "  group: org-contract-${{ github.repository_id }}-${{ github.ref }}",
    "  cancel-in-progress: true",
    "jobs:",
    "  org-contract:",
    `    uses: seorilabs/.github/.github/workflows/js-static-checks-v1.yml@${BUNDLE_SHA}`,
    "",
  ].join("\n"));
  assert.match(buildCaller, new RegExp(`rn-build-android-cloud-v2\\.yml@${BUNDLE_SHA}$`, "m"));
  assert.equal(workflowBundleCandidateTaskSchema.parse(candidate).planDigest, candidate.planDigest);
});

test("candidate task의 caller, digest, config binding 변조는 fail-closed한다", () => {
  const candidate = task();
  const tampered = structuredClone(candidate);
  tampered.mutation.files[0].contentSha256 = "0".repeat(64);
  assert.equal(workflowBundleCandidateTaskSchema.safeParse(tampered).success, false);

  const wrongBinding = structuredClone(candidate);
  wrongBinding.github.expectedHeadRef = candidateHeadRef(
    "1250442131",
    "b".repeat(40),
    "c".repeat(64),
  );
  assert.equal(workflowBundleCandidateTaskSchema.safeParse(wrongBinding).success, false);

  assert.throws(() => buildWorkflowBundleCandidateTask({
    record: {
      id: candidate.candidate.recordId,
      approvalState: "CANDIDATE",
      sourceSha: BUNDLE_SHA,
      payloadDigest: candidate.candidate.payloadDigest,
      artifactRunId: BigInt(candidate.candidate.artifactRunId),
      artifactId: BigInt(candidate.candidate.artifactId),
      artifactDigest: candidate.candidate.artifactDigest,
      bundle: bundle(),
    },
    resolved: {
      app: { status: "ACTIVE", repoFullName: candidate.repository.fullName, repoId: candidate.repository.id },
      source: { sha: candidate.repository.sourceSha, ref: "refs/heads/main" },
      workflowCaller: { profile: "react-native" },
      config: {
        id: candidate.config.revisionId,
        revision: candidate.config.revision,
        status: "ACTIVE",
        digest: candidate.config.snapshotDigest,
        signature: "8".repeat(64),
      },
      workflowBundleBinding: { sourceSha: "b".repeat(40), payloadDigest: candidate.candidate.payloadDigest },
    },
    repositoryId: candidate.repository.id,
    fullName: candidate.repository.fullName,
    sourceSha: candidate.repository.sourceSha,
    defaultBranch: candidate.repository.defaultBranch,
    issueNumber: null,
    installationId: candidate.github.installationId,
  }), /WORKFLOW_BUNDLE_CANDIDATE_ACTIVE_CONFIG_MISMATCH/u);
});

test("candidate branch는 같은 plan replay에 안정적이고 source 또는 config가 바뀌면 충돌하지 않는다", () => {
  const first = task();
  const replay = task();
  const nextSource = task({ appSha: "b".repeat(40) });
  const nextConfig = task({
    configId: "config-revision-6",
    configRevision: 6,
    snapshotDigest: "9".repeat(64),
  });

  assert.equal(replay.planDigest, first.planDigest);
  assert.equal(replay.github.expectedHeadRef, first.github.expectedHeadRef);
  assert.notEqual(nextSource.planDigest, first.planDigest);
  assert.notEqual(nextSource.github.expectedHeadRef, first.github.expectedHeadRef);
  assert.notEqual(nextConfig.planDigest, first.planDigest);
  assert.notEqual(nextConfig.github.expectedHeadRef, first.github.expectedHeadRef);
  assert.notEqual(nextSource.github.expectedHeadRef, nextConfig.github.expectedHeadRef);
});

test("candidate executor definition과 내부 operation은 strict exact 계약이다", () => {
  assert.deepEqual(parseManagedWorkerPolicy({
    template: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
    agentKind: null,
    configuration: WORKFLOW_BUNDLE_CANDIDATE_AUTOMATION_POLICY,
  }), WORKFLOW_BUNDLE_CANDIDATE_AUTOMATION_POLICY);
  assert.equal(parseManagedWorkerPolicy({
    template: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
    agentKind: "CODEX",
    configuration: WORKFLOW_BUNDLE_CANDIDATE_AUTOMATION_POLICY,
  }), null);
  assert.equal(parseManagedWorkerPolicy({
    template: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
    agentKind: null,
    configuration: { ...WORKFLOW_BUNDLE_CANDIDATE_AUTOMATION_POLICY, budgetCeilingMicros: 2 },
  }), null);
  assert.equal(workflowBundleCandidateExecutorRequestSchema.safeParse({ operation: "CLAIM" }).success, true);
  assert.equal(workflowBundleCandidateExecutorRequestSchema.safeParse({
    operation: "HEARTBEAT",
    sessionId: "agent-session:00000000-0000-4000-8000-000000000001",
    generation: 2,
  }).success, true);
  assert.equal(workflowBundleCandidateExecutorRequestSchema.safeParse({
    operation: "HEARTBEAT",
    sessionId: "agent-session:00000000-0000-4000-8000-000000000001",
  }).success, false);
  assert.equal(workflowBundleCandidateExecutorRequestSchema.safeParse({
    operation: "CLAIM",
    capability: "unexpected",
  }).success, false);
  assert.equal(
    canonicalJson(workflowBundleCandidateTaskSchema.parse(task()) as unknown as JsonValue),
    canonicalJson(task() as unknown as JsonValue),
  );
});

test("candidate heartbeat는 claim session의 동일 generation에만 결합된다", () => {
  assert.equal(trustedExecutorHeartbeatGenerationError({
    requestedGeneration: 3,
    sessionGeneration: 3,
    leaseGeneration: 3,
    runGeneration: 3,
    code: "WORKFLOW_BUNDLE_CANDIDATE_HEARTBEAT_GENERATION_MISMATCH",
  }), null);
  assert.equal(trustedExecutorHeartbeatGenerationError({
    requestedGeneration: 2,
    sessionGeneration: 3,
    leaseGeneration: 3,
    runGeneration: 3,
    code: "WORKFLOW_BUNDLE_CANDIDATE_HEARTBEAT_GENERATION_MISMATCH",
  }), "WORKFLOW_BUNDLE_CANDIDATE_HEARTBEAT_GENERATION_MISMATCH");
  assert.equal(trustedExecutorHeartbeatGenerationError({
    requestedGeneration: 3,
    sessionGeneration: 3,
    leaseGeneration: 2,
    runGeneration: 3,
    code: "WORKFLOW_BUNDLE_CANDIDATE_HEARTBEAT_GENERATION_MISMATCH",
  }), "WORKFLOW_BUNDLE_CANDIDATE_HEARTBEAT_GENERATION_MISMATCH");
});

test("candidate custom ref는 signed task와 전용 principal에만 결합된다", () => {
  const candidate = task();
  const requested = {
    headRef: candidate.github.expectedHeadRef,
    marker: candidate.github.expectedPullRequestMarker,
  };
  assert.deepEqual(resolveGithubMutationTarget({
    definition: {
      template: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
      agentKind: null,
    },
    taskInput: candidate,
    session: {
      repoId: BigInt(candidate.repository.id),
      repoFullName: candidate.repository.fullName,
      issueNumber: candidate.repository.issueNumber,
      sourceSha: candidate.repository.sourceSha,
    },
    workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    mutationIntentDigest: candidate.mutation.intentDigest,
    requested,
    generated: { headRef: "refs/heads/seori/run-generic", marker: "seori-run:generic:1" },
  }), requested);

  assert.throws(() => resolveGithubMutationTarget({
    definition: { template: "repo-task-autopilot-v1", agentKind: "CODEX" },
    taskInput: candidate,
    session: {
      repoId: BigInt(candidate.repository.id),
      repoFullName: candidate.repository.fullName,
      issueNumber: candidate.repository.issueNumber,
      sourceSha: candidate.repository.sourceSha,
    },
    workerPrincipalId: "codex:seorilabs-generic-worker",
    mutationIntentDigest: candidate.mutation.intentDigest,
    requested,
    generated: { headRef: "refs/heads/seori/run-generic", marker: "seori-run:generic:1" },
  }), (error: unknown) => (
    error instanceof ControlPlaneError && error.code === "CUSTOM_MUTATION_TARGET_FORBIDDEN"
  ));

  assert.throws(() => resolveGithubMutationTarget({
    definition: {
      template: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_TEMPLATE_KEY,
      agentKind: null,
    },
    taskInput: candidate,
    session: {
      repoId: BigInt(candidate.repository.id),
      repoFullName: candidate.repository.fullName,
      issueNumber: candidate.repository.issueNumber,
      sourceSha: candidate.repository.sourceSha,
    },
    workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    mutationIntentDigest: candidate.mutation.intentDigest,
    requested: { ...requested, marker: "seori-run:wrong" },
    generated: { headRef: "refs/heads/seori/run-generic", marker: "seori-run:generic:1" },
  }), (error: unknown) => (
    error instanceof ControlPlaneError
    && error.code === "WORKFLOW_BUNDLE_CANDIDATE_TASK_BINDING_MISMATCH"
  ));
});
