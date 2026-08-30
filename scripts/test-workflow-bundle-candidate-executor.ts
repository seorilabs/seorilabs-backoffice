import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { strToU8, zipSync } from "fflate";

import {
  WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PRINCIPAL,
  WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY,
  WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
} from "@/lib/control-plane/automation-catalog";
import {
  authorizeCandidateMutation,
  claimCandidateExecutor,
  claimCandidateMutationStep,
  completeCandidateMutationStep,
  heartbeatCandidateExecutor,
  planCandidateCommitStep,
  readbackCandidateMutation,
  recoverCandidateMutation,
  settleCandidateExecutor,
  workflowBundleCandidateRuntimeBindingDigest,
} from "@/lib/control-plane/workflow-bundle-candidate-executor-service";
import {
  enqueueWorkflowBundleCandidateExecution,
  planWorkflowBundleCandidateExecution,
  readWorkflowBundleCandidateOidcBinding,
} from "@/lib/control-plane/workflow-bundle-candidate-service";
import {
  deterministicGithubCommitSha,
  executeWorkflowBundleCandidateReadyPr,
  observeGithubReadyPr,
  recoverGithubReadyPr,
  type GithubCommitState,
  type GithubMutationControlPlane,
  type GithubPullRequestState,
  type GithubReadyPrPort,
} from "@/lib/control-plane/github-ready-pr-adapter";
import { githubInstallationProviderPayload } from "@/lib/control-plane/github-installation-observation";
import { canonicalJson, jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { REPOSITORY_DISCOVERY_CONTRACT_VERSION } from "@/lib/control-plane/repository-discovery";
import {
  activateConfigRevision,
  ControlPlaneError,
  createConfigRevision,
  recordDiscoveryObservation,
  recordProviderObservation,
} from "@/lib/control-plane/service";
import {
  importWorkflowBundleCandidate,
  type WorkflowBundleRegistryDependencies,
} from "@/lib/control-plane/workflow-bundle-v5-registry";
import { prisma } from "@/lib/prisma";

if (process.env.MIGRATION_FIXTURE_ACK !== "LOCAL_SCHEMA_ONLY") {
  throw new Error("MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY가 필요하다");
}
const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("candidate executor fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("candidate executor fixture DB 이름은 _contract_test로 끝나야 한다");
}

const REPOSITORY_ID = 1_250_442_131n;
const REPOSITORY_FULL_NAME = "seorilabs/happy-farm";
const SOURCE_SHA = "a".repeat(40);
const BUNDLE_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);
const SIGNING_KEY = "workflow-bundle-candidate-fixture-signing-key";
const INSTALLATION_ID = "101";
const ISSUE_NUMBER = 42;
const ARTIFACT_RUN_ID = 777n;
const ARTIFACT_ID = 888n;
const FIXTURE_ACTOR = "fixture:workflow-bundle-candidate";

function prefixedDigest(value: string | Buffer | JsonValue): string {
  const bytes = typeof value === "string" || Buffer.isBuffer(value)
    ? value
    : canonicalJson(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function candidateBundle() {
  const payload = {
    schemaVersion: 2,
    bundleVersion: "5.0.0",
    source: {
      repository: "seorilabs/.github",
      sha: BUNDLE_SHA,
      workflowExecutionSha: BUNDLE_SHA,
    },
    quality: {
      contractDigests: { "contracts/workflow-bundle-v5.schema.json": `sha256:${"1".repeat(64)}` },
      runtimeAssetDigests: {
        ".github/cloud-build/rn-android-build-only.yaml": `sha256:${"2".repeat(64)}`,
        ".github/cloud-build/godot-android-build-only.yaml": `sha256:${"3".repeat(64)}`,
      },
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
        builderImage: `builder/rn@sha256:${"4".repeat(64)}`,
        sha: BUNDLE_SHA,
      },
      "godot-android": {
        target: "android",
        executor: "cloud-build-x64",
        workflow: ".github/workflows/godot-build-android-cloud-v2.yml",
        artifactKind: "android-aab",
        scriptPath: "scripts/build-android.sh",
        builderImage: `builder/godot@sha256:${"5".repeat(64)}`,
        sha: BUNDLE_SHA,
      },
    },
    actions: {},
    runners: {},
    toolchains: {},
    callerPolicies: {},
    lifecyclePolicy: {},
    approval: { state: "CANDIDATE", evidence: [] },
  };
  return {
    ...payload,
    integrity: {
      algorithm: "sha256",
      payloadDigest: prefixedDigest(payload as unknown as JsonValue),
    },
  };
}

function mutationRequestId(operationId: string, phase: string): string {
  return `ghm:${jsonDigest({ schemaVersion: 1, operationId, phase })}`;
}

class FixtureGithub implements GithubReadyPrPort {
  readonly installationId = INSTALLATION_ID;
  readonly commits = new Map<string, GithubCommitState>();
  readonly refs = new Map<string, string>();
  readonly pullRequests: GithubPullRequestState[] = [];
  commitWrites = 0;
  refWrites = 0;
  pullRequestWrites = 0;

  async getRepository() {
    return {
      id: Number(REPOSITORY_ID),
      fullName: REPOSITORY_FULL_NAME,
      defaultBranch: "main",
      defaultBranchSha: SOURCE_SHA,
    };
  }

  async getIssue() {
    return {
      number: ISSUE_NUMBER,
      nodeId: "I_candidate_fixture_42",
      state: "OPEN" as const,
      labels: ["P1", "autopilot"],
      updatedAt: new Date(),
    };
  }

  async listPullRequests(input: { state: "OPEN" | "ALL"; page: number; perPage: number }) {
    const visible = input.state === "OPEN"
      ? this.pullRequests.filter((pullRequest) => pullRequest.state === "OPEN")
      : this.pullRequests;
    const start = (input.page - 1) * input.perPage;
    return structuredClone(visible.slice(start, start + input.perPage));
  }

  async getRef(_repoFullName: string, ref: string) {
    const sha = this.refs.get(ref);
    return sha ? { sha } : null;
  }

  async getCommit(_repoFullName: string, sha: string) {
    return this.commits.get(sha) ?? null;
  }

  async createTree() {
    return { sha: TREE_SHA };
  }

  async createCommit(input: { sourceSha: string; treeSha: string; message: string; date: Date }) {
    const sha = deterministicGithubCommitSha({
      treeSha: input.treeSha,
      parentSha: input.sourceSha,
      message: input.message,
      date: input.date,
    });
    assert.equal(this.commits.has(sha), false, "같은 commit object를 두 번 생성하지 않아야 한다");
    this.commitWrites += 1;
    this.commits.set(sha, { sha, treeSha: input.treeSha, parentSha: input.sourceSha });
    return { sha };
  }

  async createRef(input: { ref: string; sha: string }) {
    assert.equal(this.refs.has(input.ref), false, "같은 ref를 두 번 생성하지 않아야 한다");
    this.refWrites += 1;
    this.refs.set(input.ref, input.sha);
  }

  async createPullRequest(input: {
    baseBranch: string;
    headRef: string;
    title: string;
    body: string;
  }) {
    assert.equal(
      this.pullRequests.some((pullRequest) => pullRequest.headRef === input.headRef),
      false,
      "같은 head의 PR을 두 번 생성하지 않아야 한다",
    );
    const headSha = this.refs.get(input.headRef);
    assert.ok(headSha, "PR 생성 전 exact head ref가 필요하다");
    this.pullRequestWrites += 1;
    this.pullRequests.push({
      number: 495,
      nodeId: "PR_candidate_fixture_495",
      url: `https://github.com/${REPOSITORY_FULL_NAME}/pull/495`,
      state: "OPEN",
      draft: false,
      headRef: input.headRef,
      headRepoFullName: REPOSITORY_FULL_NAME,
      headSha,
      baseRef: `refs/heads/${input.baseBranch}`,
      baseRepoFullName: REPOSITORY_FULL_NAME,
      baseSha: SOURCE_SHA,
      body: input.body,
    });
  }
}

function adapterIdentity(runtimeBindingDigest: string, idempotencyKey: string) {
  return {
    adapterPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PRINCIPAL,
    adapterRuntimeIdentity: WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY,
    runtimeBindingDigest,
    idempotencyKey,
  };
}

function candidateControlPlane(input: {
  runtimeBindingDigest: string;
  captureExecutionId?: (executionId: string) => void;
  crashBeforeRefClaim?: { pending: boolean };
}): GithubMutationControlPlane {
  return {
    recover: async ({ requestId, body }) => recoverCandidateMutation({
      ...adapterIdentity(input.runtimeBindingDigest, requestId),
      sessionId: body.sessionId,
    }),
    authorize: async ({ requestId, body }) => {
      const authorization = await authorizeCandidateMutation({
        ...adapterIdentity(input.runtimeBindingDigest, requestId),
        sessionId: body.sessionId,
        mutationIntentDigest: body.mutationIntentDigest,
        observation: body.observation,
      });
      input.captureExecutionId?.(authorization.executionId);
      return { ...authorization, action: "GITHUB_READY_PR_MUTATE" as const };
    },
    claimStep: async ({ requestId, body }) => {
      if (body.stepKind === "CREATE_REF" && input.crashBeforeRefClaim?.pending) {
        input.crashBeforeRefClaim.pending = false;
        throw new Error("SIMULATED_PROCESS_CRASH_AFTER_COMMIT");
      }
      return claimCandidateMutationStep({
        ...adapterIdentity(input.runtimeBindingDigest, requestId),
        sessionId: body.sessionId,
        executionId: body.executionId,
        stepKind: body.stepKind,
      });
    },
    planStep: async ({ requestId, body }) => planCandidateCommitStep({
      ...adapterIdentity(input.runtimeBindingDigest, requestId),
      sessionId: body.sessionId,
      executionId: body.executionId,
      stepId: body.stepId,
      attemptId: body.attemptId,
      generation: body.generation,
      expectedTreeSha: body.expectedTreeSha,
      expectedCommitSha: body.expectedCommitSha,
    }),
    completeStep: async ({ requestId, body }) => completeCandidateMutationStep({
      ...adapterIdentity(input.runtimeBindingDigest, requestId),
      sessionId: body.sessionId,
      executionId: body.executionId,
      stepId: body.stepId,
      attemptId: body.attemptId,
      generation: body.generation,
      stepKind: body.stepKind,
      observation: body.observation,
    }),
    readback: async ({ requestId, body }) => {
      const readback = await readbackCandidateMutation({
        ...adapterIdentity(input.runtimeBindingDigest, requestId),
        sessionId: body.sessionId,
        executionId: body.executionId,
        observation: body.observation,
      });
      assert.ok(["VERIFIED", "NOT_APPLIED", "RESULT_UNKNOWN"].includes(readback.status));
      return {
        ...readback,
        status: readback.status as "VERIFIED" | "NOT_APPLIED" | "RESULT_UNKNOWN",
      };
    },
  };
}

function enqueueResult(value: unknown) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const result = value as {
    gate: { state: "READY" | "BLOCKED" };
    runId: string;
    duplicate: boolean;
  };
  assert.equal(typeof result.runId, "string");
  assert.equal(typeof result.duplicate, "boolean");
  return result;
}

async function expectControlPlaneCode(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error) => error instanceof ControlPlaneError && error.code === code);
}

async function createRegistryRecord() {
  const bundle = candidateBundle();
  const archive = Buffer.from(zipSync({
    "workflow-bundle-v5.json": strToU8(`${JSON.stringify(bundle)}\n`),
  }));
  const dependencies: WorkflowBundleRegistryDependencies = {
    trustedApprovalKeysJson: "",
    async readCandidateArtifact() {
      return {
        repository: "seorilabs/.github",
        repositoryId: "1241442018",
        sourceSha: BUNDLE_SHA,
        workflowPath: ".github/workflows/workflow-bundle-v5-candidate.yml",
        eventName: "push",
        headBranch: "main",
        runId: ARTIFACT_RUN_ID,
        runAttempt: 1,
        runStatus: "completed",
        runConclusion: "success",
        artifactId: ARTIFACT_ID,
        artifactName: `workflow-bundle-v5-candidate-${BUNDLE_SHA}`,
        artifactDigest: prefixedDigest(archive),
        artifactExpired: false,
        artifactWorkflowRunId: ARTIFACT_RUN_ID,
        artifactWorkflowRepositoryId: "1241442018",
        artifactWorkflowHeadSha: BUNDLE_SHA,
        archive,
      };
    },
  };
  const result = await importWorkflowBundleCandidate({
    sourceSha: BUNDLE_SHA,
    runId: ARTIFACT_RUN_ID,
    runAttempt: 1,
    artifactId: ARTIFACT_ID,
    idempotencyKey: "fixture-workflow-bundle-candidate-import",
    actor: FIXTURE_ACTOR,
  }, prisma, dependencies);
  return result.record;
}

async function recordInstallation(input: {
  suffix: string;
  observedAt: Date;
  mutationPermissions: boolean;
}) {
  const payload = githubInstallationProviderPayload({
    installationId: INSTALLATION_ID,
    appId: "202",
    targetId: "303",
    accountLogin: "seorilabs",
    targetType: "Organization",
    repositorySelection: "all",
    suspended: false,
    permissions: input.mutationPermissions
      ? { metadata: "read", contents: "write", pull_requests: "write", workflows: "write" }
      : { metadata: "read", contents: "read", pull_requests: "read", workflows: "read" },
    events: ["push", "repository", "pull_request"],
  }, "seorilabs");
  return recordProviderObservation({
    repoId: REPOSITORY_ID,
    provider: "github",
    resourceType: "github-app-installation",
    resourceId: INSTALLATION_ID,
    observedAt: input.observedAt,
    observedBy: FIXTURE_ACTOR,
    idempotencyKey: `fixture-workflow-bundle-installation-${input.suffix}`,
    payload,
  });
}

async function main() {
  const existing = await Promise.all([
    prisma.app.findFirst({ where: { OR: [{ repoId: REPOSITORY_ID }, { repoFullName: REPOSITORY_FULL_NAME }] } }),
    prisma.repositoryRegistration.findUnique({ where: { repoId: REPOSITORY_ID } }),
    prisma.workflowBundleRegistryRecord.findFirst({ where: { sourceSha: BUNDLE_SHA } }),
  ]);
  assert.deepEqual(existing, [null, null, null], "fixture 대상은 빈 migration DB에 존재하지 않아야 한다");

  const candidateKey = generateKeyPairSync("ed25519");
  const genericKey = generateKeyPairSync("ed25519");
  process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY = SIGNING_KEY;
  process.env.WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_DEPLOYED = "true";
  process.env.WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PRINCIPAL = WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PRINCIPAL;
  process.env.WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY =
    WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY;
  process.env.WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_TOKEN = "fixture-candidate-adapter-token-distinct";
  process.env.WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PUBLIC_KEY = candidateKey.publicKey.export({
    type: "spki",
    format: "pem",
  }).toString();
  process.env.AGENT_TRUSTED_ADAPTER_PUBLIC_KEY = genericKey.publicKey.export({
    type: "spki",
    format: "pem",
  }).toString();

  const observedAt = new Date(Date.now() - 30_000);
  const app = await prisma.app.create({
    data: {
      slug: "happy-farm",
      displayName: "Happy Farm Candidate Fixture",
      repoFullName: REPOSITORY_FULL_NAME,
      repoId: REPOSITORY_ID,
      type: "GAME",
      engine: "RN",
      status: "ACTIVE",
      marketTargets: ["play"],
      playPackage: "com.seorilabs.happyfarm.fixture",
    },
  });
  await prisma.repositoryRegistration.create({
    data: {
      repoId: REPOSITORY_ID,
      repoFullName: REPOSITORY_FULL_NAME,
      defaultBranch: "main",
      archived: false,
      status: "MANAGED",
      managementKind: "APP",
      classification: "PRODUCT_APP",
      discoveryContractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
      lastDefaultPushSha: SOURCE_SHA,
      lastReconciledSha: SOURCE_SHA,
    },
  });
  await recordDiscoveryObservation({
    repoId: REPOSITORY_ID,
    sourceSha: SOURCE_SHA,
    sourceRef: "refs/heads/main",
    observedAt,
    observedBy: FIXTURE_ACTOR,
    idempotencyKey: "fixture-workflow-bundle-candidate-discovery",
    workflowCaller: { profile: "react-native", packageManager: "pnpm", workingDirectory: "." },
    payload: {
      schemaVersion: 2,
      contractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
      repository: {
        id: Number(REPOSITORY_ID),
        fullName: REPOSITORY_FULL_NAME,
        sourceSha: SOURCE_SHA,
        sourceRef: "refs/heads/main",
      },
      status: "ACTIVE",
      classification: "PRODUCT_APP",
    },
    buildTargets: [{
      targetKey: "android-release",
      stack: "react-native",
      market: "google-play",
      packageId: "com.seorilabs.happyfarm.fixture",
    }],
  });
  const registry = await createRegistryRecord();
  const draft = await createConfigRevision({
    repoId: REPOSITORY_ID,
    expectedLatestRevision: 0,
    actor: FIXTURE_ACTOR,
    idempotencyKey: "fixture-workflow-bundle-candidate-config",
    payload: {
      schemaVersion: 1,
      markets: [{
        market: "google-play",
        enabled: true,
        locales: ["ko-KR"],
        releaseChannel: "internal",
      }],
      build: {
        workflowBundleSha: BUNDLE_SHA,
        workflowBundleDigest: registry.payloadDigest,
      },
    },
  });
  await activateConfigRevision({
    repoId: REPOSITORY_ID,
    revision: draft.revision.revision,
    expectedActiveRevision: 0,
    actor: FIXTURE_ACTOR,
    idempotencyKey: "fixture-workflow-bundle-candidate-activate",
    signingKey: SIGNING_KEY,
  });
  await prisma.issueMirror.create({
    data: {
      appId: app.id,
      repoFullName: REPOSITORY_FULL_NAME,
      number: ISSUE_NUMBER,
      nodeId: "I_candidate_fixture_42",
      title: "WorkflowBundle v5 candidate fixture",
      state: "OPEN",
      assignees: [],
      labels: ["P1", "autopilot"],
      priority: "P1",
      isAutopilot: true,
      isBlocked: false,
      ghCreatedAt: observedAt,
      ghUpdatedAt: observedAt,
    },
  });

  await recordInstallation({ suffix: "denied", observedAt, mutationPermissions: false });
  const blocked = await planWorkflowBundleCandidateExecution({
    workflowBundleRecordId: registry.id,
    repositoryId: REPOSITORY_ID.toString(),
    sourceSha: SOURCE_SHA,
    issueNumber: ISSUE_NUMBER,
  });
  assert.equal(blocked.gate.state, "BLOCKED");
  assert.deepEqual(blocked.gate.missing, [
    "permission:contents:write",
    "permission:pull_requests:write",
    "permission:workflows:write",
  ]);
  await recordInstallation({
    suffix: "granted",
    observedAt: new Date(observedAt.getTime() + 1_000),
    mutationPermissions: true,
  });

  const enqueued = enqueueResult(await enqueueWorkflowBundleCandidateExecution({
    workflowBundleRecordId: registry.id,
    repositoryId: REPOSITORY_ID.toString(),
    sourceSha: SOURCE_SHA,
    issueNumber: ISSUE_NUMBER,
    actor: FIXTURE_ACTOR,
    idempotencyKey: "fixture-workflow-bundle-candidate-enqueue",
  }));
  assert.equal(enqueued.gate.state, "READY");
  const replay = enqueueResult(await enqueueWorkflowBundleCandidateExecution({
    workflowBundleRecordId: registry.id,
    repositoryId: REPOSITORY_ID.toString(),
    sourceSha: SOURCE_SHA,
    issueNumber: ISSUE_NUMBER,
    actor: FIXTURE_ACTOR,
    idempotencyKey: "fixture-workflow-bundle-candidate-enqueue",
  }));
  assert.equal(replay.duplicate, true);
  assert.equal(replay.runId, enqueued.runId);

  const runtimeBindingDigest = workflowBundleCandidateRuntimeBindingDigest({
    adapterPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_PRINCIPAL,
    adapterRuntimeIdentity: WORKFLOW_BUNDLE_CANDIDATE_ADAPTER_RUNTIME_IDENTITY,
  });
  const first = await claimCandidateExecutor(adapterIdentity(
    runtimeBindingDigest,
    "fixture-workflow-bundle-candidate-claim-1",
  ));
  assert.ok(first);
  assert.equal(first.runId, enqueued.runId);
  assert.equal(first.resumeMode, "START");
  assert.equal(first.generation, 1);
  await expectControlPlaneCode(() => heartbeatCandidateExecutor({
    ...adapterIdentity(runtimeBindingDigest, "fixture-workflow-bundle-heartbeat-wrong-1"),
    sessionId: first.sessionId,
    generation: 2,
  }), "WORKFLOW_BUNDLE_CANDIDATE_HEARTBEAT_GENERATION_MISMATCH");
  const heartbeat = await heartbeatCandidateExecutor({
    ...adapterIdentity(runtimeBindingDigest, "fixture-workflow-bundle-heartbeat-1"),
    sessionId: first.sessionId,
    generation: first.generation,
  });
  assert.equal(heartbeat.generation, first.generation);

  const github = new FixtureGithub();
  let executionId: string | null = null;
  const crash = { pending: true };
  const firstControlPlane = candidateControlPlane({
    runtimeBindingDigest,
    captureExecutionId: (value) => { executionId = value; },
    crashBeforeRefClaim: crash,
  });
  await assert.rejects(() => executeWorkflowBundleCandidateReadyPr({
    operationId: first.sessionId,
    workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    workerRuntimeBindingDigest: runtimeBindingDigest,
    task: first.task,
    sessionId: first.sessionId,
    github,
    controlPlane: firstControlPlane,
  }), /SIMULATED_PROCESS_CRASH_AFTER_COMMIT/u);
  assert.ok(executionId);
  assert.deepEqual(
    [github.commitWrites, github.refWrites, github.pullRequestWrites],
    [1, 0, 0],
    "crash 시점에는 commit prefix만 provider에서 검증되어야 한다",
  );

  const freshObservation = await observeGithubReadyPr({
    github,
    repoFullName: REPOSITORY_FULL_NAME,
    issueNumber: ISSUE_NUMBER,
    now: new Date(),
  });
  const authorizationReplay = await authorizeCandidateMutation({
    ...adapterIdentity(
      runtimeBindingDigest,
      mutationRequestId(first.sessionId, "authorize"),
    ),
    sessionId: first.sessionId,
    mutationIntentDigest: first.task.mutation.intentDigest,
    observation: freshObservation,
  });
  assert.equal(authorizationReplay.duplicate, true);
  assert.equal(authorizationReplay.executionId, executionId);

  await settleCandidateExecutor({
    ...adapterIdentity(runtimeBindingDigest, "fixture-workflow-bundle-settle-unknown-1"),
    sessionId: first.sessionId,
    mode: "START",
    status: "RESULT_UNKNOWN",
    executionId,
    pullRequestNumber: null,
    pullRequestUrl: null,
    commitSha: null,
    errorCode: "SIMULATED_PROCESS_CRASH_AFTER_COMMIT",
  });
  const readbackClaim = await claimCandidateExecutor(adapterIdentity(
    runtimeBindingDigest,
    "fixture-workflow-bundle-candidate-claim-2",
  ));
  assert.ok(readbackClaim);
  assert.equal(readbackClaim.runId, first.runId);
  assert.equal(readbackClaim.resumeMode, "READBACK_FIRST");
  assert.equal(readbackClaim.generation, 2);
  await expectControlPlaneCode(() => heartbeatCandidateExecutor({
    ...adapterIdentity(runtimeBindingDigest, "fixture-workflow-bundle-heartbeat-wrong-2"),
    sessionId: readbackClaim.sessionId,
    generation: first.generation,
  }), "WORKFLOW_BUNDLE_CANDIDATE_HEARTBEAT_GENERATION_MISMATCH");
  await heartbeatCandidateExecutor({
    ...adapterIdentity(runtimeBindingDigest, "fixture-workflow-bundle-heartbeat-2"),
    sessionId: readbackClaim.sessionId,
    generation: readbackClaim.generation,
  });

  const readbackControlPlane = candidateControlPlane({ runtimeBindingDigest });
  const recovery = await readbackControlPlane.recover({
    requestId: "fixture-workflow-bundle-candidate-recovery",
    body: {
      sessionId: readbackClaim.sessionId,
      workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
      workerRuntimeBindingDigest: runtimeBindingDigest,
    },
  });
  const recovered = await recoverGithubReadyPr({
    operationId: readbackClaim.sessionId,
    sessionId: readbackClaim.sessionId,
    workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    workerRuntimeBindingDigest: runtimeBindingDigest,
    recovery,
    github,
    controlPlane: readbackControlPlane,
  });
  assert.equal(recovered.status, "RESULT_UNKNOWN");
  assert.equal(recovered.safeToResume, true);
  assert.deepEqual(
    [github.commitWrites, github.refWrites, github.pullRequestWrites],
    [1, 0, 0],
    "READBACK_FIRST는 provider write를 만들지 않아야 한다",
  );
  const resumed = await settleCandidateExecutor({
    ...adapterIdentity(runtimeBindingDigest, "fixture-workflow-bundle-settle-partial-2"),
    sessionId: readbackClaim.sessionId,
    mode: "READBACK_FIRST",
    status: "PARTIAL_VERIFIED",
    executionId: recovered.executionId,
    pullRequestNumber: null,
    pullRequestUrl: null,
    commitSha: null,
    errorCode: null,
  });
  assert.equal(resumed.status, "PENDING");

  const finalClaim = await claimCandidateExecutor(adapterIdentity(
    runtimeBindingDigest,
    "fixture-workflow-bundle-candidate-claim-3",
  ));
  assert.ok(finalClaim);
  assert.equal(finalClaim.runId, first.runId);
  assert.equal(finalClaim.resumeMode, "START");
  assert.equal(finalClaim.generation, 3);
  assert.equal(finalClaim.task.planDigest, first.task.planDigest);
  assert.deepEqual(finalClaim.task.candidate, first.task.candidate);
  assert.deepEqual(finalClaim.task.config, first.task.config);
  assert.deepEqual(finalClaim.task.repository, first.task.repository);
  assert.equal(finalClaim.task.github.expectedHeadRef, first.task.github.expectedHeadRef);
  assert.equal(
    finalClaim.task.github.expectedPullRequestMarker,
    first.task.github.expectedPullRequestMarker,
  );
  assert.equal(finalClaim.task.mutation.intentDigest, first.task.mutation.intentDigest);
  const oidc = await readWorkflowBundleCandidateOidcBinding({
    repositoryId: REPOSITORY_ID.toString(),
    sourceSha: SOURCE_SHA,
    workflowBundleSha: BUNDLE_SHA,
  });
  assert.equal(oidc.runId, first.runId);
  assert.equal(oidc.expectedHeadRef, finalClaim.task.github.expectedHeadRef.replace(/^refs\/heads\//u, ""));
  assert.match(
    oidc.expectedHeadRef,
    new RegExp(`^seori/workflow-bundle-v5-canary/${REPOSITORY_ID}/${BUNDLE_SHA.slice(0, 12)}/[0-9a-f]{64}$`, "u"),
  );

  const finalResult = await executeWorkflowBundleCandidateReadyPr({
    operationId: finalClaim.sessionId,
    workerPrincipalId: WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_PRINCIPAL,
    workerRuntimeBindingDigest: runtimeBindingDigest,
    task: finalClaim.task,
    sessionId: finalClaim.sessionId,
    github,
    controlPlane: candidateControlPlane({ runtimeBindingDigest }),
  });
  assert.equal(finalResult.status, "VERIFIED");
  await settleCandidateExecutor({
    ...adapterIdentity(runtimeBindingDigest, "fixture-workflow-bundle-settle-verified-3"),
    sessionId: finalClaim.sessionId,
    mode: "START",
    status: "VERIFIED",
    executionId: finalResult.executionId,
    pullRequestNumber: finalResult.pullRequestNumber ?? null,
    pullRequestUrl: finalResult.pullRequestUrl ?? null,
    commitSha: null,
    errorCode: null,
  });
  assert.deepEqual(
    [github.commitWrites, github.refWrites, github.pullRequestWrites],
    [1, 1, 1],
    "partial recovery 뒤 commit/ref/PR은 각각 한 번만 생성되어야 한다",
  );

  const durable = await prisma.agentRun.findUniqueOrThrow({
    where: { id: first.runId },
    include: {
      leases: { orderBy: { generation: "asc" } },
      repoGuard: true,
      events: true,
    },
  });
  assert.equal(durable.status, "SUCCEEDED");
  assert.deepEqual(durable.leases.map((lease) => lease.generation), [1, 2, 3]);
  assert.ok(durable.leases.every((lease) => lease.revokedAt !== null));
  assert.equal(durable.repoGuard?.activeScopeKey, `repo-pr:${REPOSITORY_FULL_NAME}`);
  assert.equal(await prisma.agentMutationExecution.count({ where: { runId: first.runId } }), 1);
  const grant = await prisma.agentActionGrant.findFirstOrThrow({
    where: { runId: first.runId },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(grant.repoId, REPOSITORY_ID);
  assert.equal(grant.repoFullName, REPOSITORY_FULL_NAME);
  assert.equal(grant.sourceSha, SOURCE_SHA);
  assert.equal(grant.expectedHeadRef, finalClaim.task.github.expectedHeadRef);
  assert.equal(
    grant.expectedPullRequestMarker,
    finalClaim.task.github.expectedPullRequestMarker,
  );
  assert.equal(grant.mutationIntentDigest, finalClaim.task.mutation.intentDigest);
  const steps = await prisma.agentMutationStep.findMany({
    where: { execution: { runId: first.runId } },
    orderBy: { ordinal: "asc" },
  });
  assert.deepEqual(steps.map((step) => [step.kind, step.status]), [
    ["CREATE_COMMIT", "VERIFIED"],
    ["CREATE_REF", "VERIFIED"],
    ["CREATE_PR", "VERIFIED"],
  ]);
  assert.equal(github.pullRequests.length, 1);

  console.log("WorkflowBundle candidate executor MySQL 통합 계약 통과");
}

main()
  .finally(async () => {
    try {
      // 뒤이어 같은 fresh/cutover DB를 사용하는 fleet-wide fixture의 cohort와
      // restore signing-key 검증에 이 exact-repository fixture가 섞이지 않도록
      // provider 이력은 보존하고 ACTIVE/config registration만 terminal state로 닫는다.
      await prisma.$transaction([
        prisma.configRevision.updateMany({
          where: { app: { repoId: REPOSITORY_ID }, status: "ACTIVE" },
          data: {
            status: "SUPERSEDED",
            activeSlot: null,
            supersededAt: new Date(),
          },
        }),
        prisma.repositoryRegistration.updateMany({
          where: { repoId: REPOSITORY_ID },
          data: { archived: true, status: "ARCHIVED" },
        }),
        prisma.app.updateMany({
          where: { repoId: REPOSITORY_ID },
          data: { status: "DEPRECATED" },
        }),
      ]);
    } finally {
      await prisma.$disconnect();
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
