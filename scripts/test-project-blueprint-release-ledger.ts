import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import {
  RELEASE_CANDIDATE_REQUIRED_GATES,
  type PlatformReleaseManifest,
  type ProjectBlueprint,
} from "@/lib/control-plane/contracts";
import { signSnapshot } from "@/lib/control-plane/json";
import { getProjectBlueprintPlan } from "@/lib/control-plane/project-blueprint-service";
import { buildAuthBrokerPolicyGrant } from "@/lib/control-plane/provider-adapter-client";
import {
  claimProviderExecution,
  enqueueProviderExecution,
  approveProviderExecution,
  settleProviderExecution,
} from "@/lib/control-plane/provider-execution-service";
import { createReleaseCandidate, recordReleaseGateObservation } from "@/lib/control-plane/release-ledger";
import { ControlPlaneError } from "@/lib/control-plane/service";
import {
  activateConfigRevision,
  createConfigRevision,
  recordDiscoveryObservation,
} from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("release ledger integration fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("release ledger integration fixture DB 이름은 _contract_test로 끝나야 한다");
}

const APP_ID = "project-blueprint-integration-app";
const REPO_ID = 9_000_000_001n;
const SOURCE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "c".repeat(40);
const WORKFLOW_DIGEST = "2".repeat(64);
const ARTIFACT_SHA = "d".repeat(64);
const RULES_SHA = "e".repeat(64);
const PLATFORM_ARTIFACT_SHA = "f".repeat(64);
const PLATFORM_CONTRACT_REVISION = "1".repeat(64);
const PUBLISHER_ACCOUNT = "1234567890123456789";
const PACKAGE_ID = "com.seorilabs.blueprint";
const SIGNING_KEY = "integration-provider-lease-signing-key-0123456789";
const WORKER_ID = "integration-provider-worker";
const SUBJECT = "k8s:platform:provider-execution-worker";

/**
 * gate 원장에 실제로 남은 관측과 lifecycle 상태를 한 번에 읽는다.
 * 거부 경로가 정말 0 mutation인지 판정하는 기준이다.
 */
async function ledgerSnapshot(candidateId: string) {
  const [gates, candidate, lifecycle, events, audits, observations, executionEvents] = await Promise.all([
    prisma.releaseGateObservation.count({ where: { candidateId } }),
    prisma.releaseCandidate.findUniqueOrThrow({ where: { id: candidateId }, select: { status: true } }),
    prisma.fleetLifecycleState.findUnique({ where: { appId: APP_ID }, select: { stage: true, generation: true } }),
    prisma.fleetLifecycleEvent.count({ where: { appId: APP_ID } }),
    prisma.auditLog.count(),
    prisma.providerObservation.count({ where: { appId: APP_ID } }),
    prisma.providerExecutionEvent.count(),
  ]);
  return {
    gates,
    candidateStatus: candidate.status,
    stage: lifecycle?.stage ?? null,
    generation: lifecycle?.generation ?? 0,
    events,
    audits,
    observations,
    executionEvents,
  };
}

async function expectRejected(
  label: string,
  candidateId: string,
  run: () => Promise<unknown>,
  expectedCode: string,
) {
  const before = await ledgerSnapshot(candidateId);
  let code: string | null = null;
  try {
    await run();
  } catch (error) {
    code = error instanceof ControlPlaneError ? error.code : (error as Error).message;
  }
  assert.equal(code, expectedCode, `${label}: 예상 거부 코드가 아니다`);
  assert.deepEqual(await ledgerSnapshot(candidateId), before, `${label}: 거부 경로가 원장을 변경했다`);
}

/**
 * 한 건의 market provider execution을 enqueue → (필요 시) 승인 → claim → settle까지 끝낸다.
 * gate 관측은 오직 이 settlement transaction 안에서만 만들어진다.
 */
async function runMarketSettlement(input: {
  key: string;
  operation: "READBACK" | "UPLOAD_INTERNAL";
  gate: "UPLOAD" | "PROCESSING" | "DEVICE_QA" | "REVIEW" | "APPROVAL" | "DEPLOYMENT" | "PUBLIC";
  state: "SUCCEEDED" | "APPROVED" | "LIVE";
  candidateId: string;
  observedAt: Date;
  providerReference: string;
}) {
  const enqueued = await enqueueProviderExecution({
    kind: "MARKET_RELEASE",
    repoId: REPO_ID,
    releaseCandidateId: input.candidateId,
    operation: input.operation,
    maxAttempts: 3,
    actor: "integration-human",
    idempotencyKey: `provider-execution-${input.key}`,
  });
  if (enqueued.execution.status === "WAITING_HUMAN_APPROVAL") {
    await approveProviderExecution({
      executionId: enqueued.execution.id,
      expectedGeneration: enqueued.execution.leaseGeneration,
      bindingHash: enqueued.execution.bindingHash,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      actor: "integration-human",
      idempotencyKey: `provider-approval-${input.key}`,
    });
  }
  const claimed = await claimProviderExecution({
    workerId: WORKER_ID,
    leaseSeconds: 300,
    idempotencyKey: `provider-claim-${input.key}`,
    signingKey: SIGNING_KEY,
  });
  assert.equal(claimed.claim?.executionId, enqueued.execution.id);
  const claim = claimed.claim!;
  const observation = {
    kind: "MARKET" as const,
    payload: {
      schemaVersion: 1 as const,
      market: "google-play" as const,
      publicAccountId: PUBLISHER_ACCOUNT,
      publicAppId: PACKAGE_ID,
      gate: input.gate,
      state: input.state,
      sourceSha: SOURCE_SHA,
      configRevision: 1,
      artifactChecksum: ARTIFACT_SHA,
      providerReference: input.providerReference,
      observedAt: input.observedAt,
    },
  };
  // signer가 broker에서 직접 읽었을 때 나오는 영수증과 정확히 같은 값이다.
  const built = buildAuthBrokerPolicyGrant(claim.envelope, SUBJECT);
  const receipt = {
    policyGrantId: built.grant.id,
    policyGrantDigest: built.digest,
    bindingHash: built.grant.bindingHash,
    commandDigest: built.grant.commandDigest,
    policyGeneration: built.grant.policyGeneration,
    generation: claim.generation,
  };
  return { execution: enqueued.execution, claim, observation, receipt };
}

function blueprint(): ProjectBlueprint {
  return {
    schemaVersion: 1,
    organizationId: "123456789",
    folderId: "234567890",
    billingAccountId: "ABCDEF-123456-789ABC",
    project: { projectId: "blueprint-prod", projectNumber: "345678901", region: "asia-northeast3" },
    apis: ["firebase.googleapis.com"],
    iam: [],
    budget: { currencyCode: "KRW", monthlyAmount: 100_000, alertThresholds: [0.5, 1] },
    firebase: {
      authProviders: ["anonymous"],
      appCheckEnforcement: "MONITOR",
      firestoreRulesChecksum: RULES_SHA,
      firestoreIndexesChecksum: RULES_SHA,
      storageRulesChecksum: RULES_SHA,
      functions: { region: "asia-northeast3", runtime: "nodejs24" },
      apps: [{ platform: "ANDROID", packageId: "com.seorilabs.blueprint" }],
    },
    analytics: {
      bigQueryProjectId: "blueprint-prod",
      datasetId: "analytics_blueprint",
      location: "ASIA-NORTHEAST3",
    },
    workspace: { groups: [], domainWideDelegation: [] },
    provisioners: {
      gcp: "shared/gcp/provisioner-session",
      firebase: "shared/gcp/firebase-automation",
      workspace: "shared/google-workspace/provisioner",
    },
  };
}

async function main() {
  await prisma.app.create({
    data: {
      id: APP_ID,
      slug: "project-blueprint-integration",
      displayName: "Project Blueprint Integration",
      repoFullName: "seorilabs/project-blueprint-integration",
      repoId: REPO_ID,
      type: "APP",
      engine: "RN",
      marketTargets: ["play"],
    },
  });
  const observedAt = new Date();
  await recordDiscoveryObservation({
    repoId: REPO_ID,
    sourceSha: SOURCE_SHA,
    sourceRef: "refs/heads/main",
    observedAt,
    observedBy: "integration-worker",
    idempotencyKey: "project-blueprint-integration-discovery",
    workflowCaller: { profile: "react-native", packageManager: "pnpm", workingDirectory: "." },
    payload: { stack: "react-native" },
    buildTargets: [{
      targetKey: "android-release",
      stack: "react-native",
      market: "google-play",
      packageId: "com.seorilabs.blueprint",
    }],
  });
  const draft = await createConfigRevision({
    repoId: REPO_ID,
    actor: "integration-human",
    idempotencyKey: "project-blueprint-integration-config",
    payload: {
      schemaVersion: 1,
      markets: [{ market: "google-play", enabled: true, locales: ["ko-KR"], releaseChannel: "internal" }],
      projectBlueprint: blueprint(),
      build: { workflowBundleSha: WORKFLOW_SHA, platformVersion: "0.6.5", minSdk: 24, targetSdk: 36 },
      complianceDrafts: [{ market: "google-play", declaration: "data-safety", state: "DRAFT", draft: true }],
      assets: [{ market: "google-play", kind: "icon", objectKey: "apps/blueprint/icon", checksum: RULES_SHA }],
    },
  });
  assert.equal(draft.revision.revision, 1);
  await activateConfigRevision({
    repoId: REPO_ID,
    revision: 1,
    expectedActiveRevision: 0,
    actor: "integration-human",
    idempotencyKey: "project-blueprint-integration-activate",
    signingKey: "integration-signing-key",
  });
  await prisma.credentialBinding.createMany({
    data: [
      ["shared/gcp/provisioner-session", "gcp-project-provision"],
      ["shared/gcp/firebase-automation", "firebase-provision"],
      ["shared/google-workspace/provisioner", "workspace-provision"],
    ].map(([logicalCredentialId, capability]) => ({
      appId: APP_ID,
      logicalCredentialId,
      provider: "google",
      capability,
      environment: "production",
      publicIdentity: `${capability}@example.invalid`,
      consumer: "project-blueprint-integration",
      observedAt,
    })),
  });
  const plan = await getProjectBlueprintPlan({ repoId: REPO_ID, sourceSha: SOURCE_SHA, configRevision: 1 });
  assert.equal(plan.status, "READY_TO_APPLY");
  assert.equal(plan.credentialChecks.every((check) => check.state === "READY"), true);

  const platformManifest: PlatformReleaseManifest = {
    schemaVersion: 1,
    approval: "FLEET_APPROVED",
    version: "0.6.5",
    sourceSha: "a".repeat(40),
    contractRevision: PLATFORM_CONTRACT_REVISION,
    classification: "IMPLEMENTATION_ONLY",
    publishedAt: observedAt.toISOString(),
    artifacts: [{
      kind: "TYPESCRIPT",
      version: "0.6.5",
      digest: PLATFORM_ARTIFACT_SHA,
      packageName: "@seorilabs/platform",
    }],
    canaryEvidence: {
      attestationSha256: `sha256:${"3".repeat(64)}`,
      readbackKeyId: "integration-readback-key",
      workflowBundle: {
        repository: "seorilabs/.github",
        sourceSha: WORKFLOW_SHA,
        digest: `sha256:${WORKFLOW_DIGEST}`,
      },
      canaries: ["godot", "react-native"].map((profile, index) => ({
        profile: profile as "godot" | "react-native",
        repositoryId: String(9_200 + index),
        repositoryFullName: `seorilabs/${profile}-release-canary`,
        sourceSha: index === 0 ? "4".repeat(40) : "5".repeat(40),
        staticRun: {
          runId: String(300 + index * 2), conclusion: "success" as const,
          headSha: index === 0 ? "4".repeat(40) : "5".repeat(40), workflowSourceSha: WORKFLOW_SHA,
        },
        buildOnlyRun: {
          runId: String(301 + index * 2), conclusion: "success" as const,
          headSha: index === 0 ? "4".repeat(40) : "5".repeat(40), workflowSourceSha: WORKFLOW_SHA,
          cloudBuildId: `release-build-${index}`,
          builderImageDigest: `sha256:${"6".repeat(64)}`,
          buildConfigDigest: `sha256:${"7".repeat(64)}`,
          artifact: { name: `${profile}.aab`, sha256: `sha256:${"8".repeat(64)}`, size: 1 },
        },
      })) as PlatformReleaseManifest["canaryEvidence"]["canaries"],
    },
    provenance: {
      repository: "seorilabs/platform",
      releaseId: "9200",
      releaseTag: "v0.6.5",
      rawManifestSha256: "9".repeat(64),
      approvalSha256: "a".repeat(64),
      approvalKeyId: "integration-approval-key",
    },
  };
  const signedPlatformManifest = signSnapshot(
    platformManifest as unknown as Parameters<typeof signSnapshot>[0],
    "integration-signing-key",
  );
  const platformRelease = await prisma.platformRelease.create({
    data: {
      version: platformManifest.version,
      sourceSha: platformManifest.sourceSha,
      classification: platformManifest.classification,
      approval: platformManifest.approval,
      contractRevision: platformManifest.contractRevision,
      manifest: platformManifest as unknown as Prisma.InputJsonValue,
      manifestDigest: signedPlatformManifest.digest,
      signature: signedPlatformManifest.signature,
      publishedAt: observedAt,
      observedBy: "integration-worker",
      requestHash: signedPlatformManifest.digest,
      idempotencyKey: "project-blueprint-integration-platform-release",
    },
  });
  await prisma.platformFleetBinding.create({
    data: {
      appId: APP_ID,
      platformReleaseId: platformRelease.id,
      observedVersion: "0.6.5",
      observedDigest: PLATFORM_ARTIFACT_SHA,
      approvedVersion: "0.6.5",
      approvedDigest: PLATFORM_ARTIFACT_SHA,
      manifestDigest: signedPlatformManifest.digest,
      contractRevision: PLATFORM_CONTRACT_REVISION,
      state: "COMPLIANT",
      sourceSha: SOURCE_SHA,
    },
  });

  await assert.rejects(createReleaseCandidate({
    repoId: REPO_ID,
    sourceSha: SOURCE_SHA,
    configRevision: 1,
    market: "google-play",
    targetKey: "android-release",
    artifactType: "android-aab",
    artifactChecksum: ARTIFACT_SHA,
    workflowBundleSha: WORKFLOW_SHA,
    workflowBundleDigest: "0".repeat(64),
    platformVersion: "0.6.5",
    actor: "integration-worker",
    idempotencyKey: "project-blueprint-integration-candidate-wrong-bundle",
  }), (error) => error instanceof ControlPlaneError && error.code === "WORKFLOW_BUNDLE_APPROVAL_MISMATCH");

  const created = await createReleaseCandidate({
    repoId: REPO_ID,
    sourceSha: SOURCE_SHA,
    configRevision: 1,
    market: "google-play",
    targetKey: "android-release",
    artifactType: "android-aab",
    artifactChecksum: ARTIFACT_SHA,
    workflowBundleSha: WORKFLOW_SHA,
    workflowBundleDigest: WORKFLOW_DIGEST,
    platformVersion: "0.6.5",
    actor: "integration-worker",
    idempotencyKey: "project-blueprint-integration-candidate",
  });
  assert.equal(created.candidate.status, "PREPARED");
  assert.equal(created.candidate.workflowBundleDigest, WORKFLOW_DIGEST);
  const replay = await createReleaseCandidate({
    repoId: REPO_ID,
    sourceSha: SOURCE_SHA,
    configRevision: 1,
    market: "google-play",
    targetKey: "android-release",
    artifactType: "android-aab",
    artifactChecksum: ARTIFACT_SHA,
    workflowBundleSha: WORKFLOW_SHA,
    workflowBundleDigest: WORKFLOW_DIGEST,
    platformVersion: "0.6.5",
    actor: "integration-worker",
    idempotencyKey: "project-blueprint-integration-candidate",
  });
  assert.equal(replay.duplicate, true);

  for (const [index, gate] of RELEASE_CANDIDATE_REQUIRED_GATES.entries()) {
    const request = {
      candidateId: created.candidate.id,
      gate,
      status: "PASSED" as const,
      observedAt: new Date(observedAt.getTime() + index),
      evidence: {
        schemaVersion: 1 as const,
        sourceSha: SOURCE_SHA,
        configRevision: 1,
        artifactChecksum: ARTIFACT_SHA,
      },
      actor: "integration-worker",
      idempotencyKey: `project-blueprint-integration-gate-${gate.toLowerCase()}`,
    };
    if (index === 0) {
      const concurrent = await Promise.all([
        recordReleaseGateObservation(request),
        recordReleaseGateObservation(request),
      ]);
      assert.equal(concurrent.filter((result) => result.duplicate).length, 1);
    } else {
      await recordReleaseGateObservation(request);
    }
  }
  const candidate = await prisma.releaseCandidate.findUniqueOrThrow({ where: { id: created.candidate.id } });
  const lifecycle = await prisma.fleetLifecycleState.findUniqueOrThrow({ where: { appId: APP_ID } });
  assert.equal(candidate.status, "READY");
  assert.equal(lifecycle.stage, "RELEASE_CANDIDATE");
  assert.equal(await prisma.fleetLifecycleEvent.count({ where: { appId: APP_ID } }), 1);

  const candidateId = created.candidate.id;

  // 외부 단계 gate는 범용 요청으로 만들 수 없다. 임의 identity 문자열도 원장을 바꾸지 못한다.
  for (const gate of ["UPLOAD", "PROCESSING", "DEVICE_QA", "REVIEW", "APPROVAL", "DEPLOYMENT", "PUBLIC"] as const) {
    await expectRejected(`forged ${gate}`, candidateId, () => recordReleaseGateObservation({
      candidateId,
      gate,
      status: "PASSED",
      observedAt: new Date(),
      evidence: {
        schemaVersion: 1,
        sourceSha: SOURCE_SHA,
        configRevision: 1,
        artifactChecksum: ARTIFACT_SHA,
        providerReference: "forged-provider-reference",
        publicIdentity: "forged-account/forged-app",
      },
      actor: "forged-principal",
      idempotencyKey: `forged-external-gate-${gate.toLowerCase()}`,
    }), "EXTERNAL_GATE_PROVIDER_ONLY");
  }

  // provider market binding과 실행 credential을 등록한다. 비밀값은 저장하지 않는다.
  await prisma.externalBinding.createMany({
    data: [
      { appId: APP_ID, provider: "google-play", bindingType: "publisher-account", externalId: PUBLISHER_ACCOUNT, publicIdentity: PUBLISHER_ACCOUNT, observedAt },
      { appId: APP_ID, provider: "google-play", bindingType: "application", externalId: PACKAGE_ID, publicIdentity: PACKAGE_ID, observedAt },
    ],
  });
  await prisma.credentialBinding.createMany({
    data: [
      ["shared/google-play/upload", "google-play.upload.internal", "upload-bot@example.invalid"],
      ["shared/google-play/readback", "google-play.readback", "readback-bot@example.invalid"],
    ].map(([logicalCredentialId, capability, publicIdentity]) => ({
      appId: APP_ID,
      logicalCredentialId,
      provider: "google-play",
      capability,
      environment: "production",
      publicIdentity,
      consumer: "project-blueprint-integration",
      credentialGeneration: 1,
      policyGeneration: 1,
      adapterId: "google-play-api-v1",
      origin: "https://androidpublisher.googleapis.com",
      authFactors: ["oidc"],
      observedAt,
    })),
  });

  const upload = await runMarketSettlement({
    key: "upload",
    operation: "UPLOAD_INTERNAL",
    gate: "UPLOAD",
    state: "SUCCEEDED",
    candidateId,
    observedAt: new Date(observedAt.getTime() + 1_000),
    providerReference: "edits/upload-1",
  });

  // stale lease는 gate를 만들 수 없다.
  await expectRejected("stale lease", candidateId, () => settleProviderExecution({
    executionId: upload.execution.id,
    generation: upload.claim.generation,
    leaseToken: "0".repeat(64),
    outcome: "OBSERVED",
    observation: upload.observation,
    observationReceipt: upload.receipt,
    workerId: WORKER_ID,
    idempotencyKey: "provider-settle-upload-stale",
  }), "STALE_LEASE");

  // provider app identity가 다르면 settlement 자체가 거부된다.
  await expectRejected("identity mismatch", candidateId, () => settleProviderExecution({
    executionId: upload.execution.id,
    generation: upload.claim.generation,
    leaseToken: upload.claim.leaseToken,
    outcome: "OBSERVED",
    observation: {
      kind: "MARKET",
      payload: { ...upload.observation.payload, publicAppId: "com.attacker.other" },
    },
    observationReceipt: upload.receipt,
    workerId: WORKER_ID,
    idempotencyKey: "provider-settle-upload-identity",
  }), "PROVIDER_IDENTITY_MISMATCH");

  // candidate 결합이 다른 artifact checksum도 거부된다.
  await expectRejected("candidate binding mismatch", candidateId, () => settleProviderExecution({
    executionId: upload.execution.id,
    generation: upload.claim.generation,
    leaseToken: upload.claim.leaseToken,
    outcome: "OBSERVED",
    observation: {
      kind: "MARKET",
      payload: { ...upload.observation.payload, artifactChecksum: "9".repeat(64) },
    },
    observationReceipt: upload.receipt,
    workerId: WORKER_ID,
    idempotencyKey: "provider-settle-upload-artifact",
  }), "CANDIDATE_BINDING_MISMATCH");

  // valid worker identity와 살아 있는 claim이 있어도, broker 영수증 없이는 관측이 원장에 들어가지 않는다.
  await expectRejected("receipt absent", candidateId, () => settleProviderExecution({
    executionId: upload.execution.id,
    generation: upload.claim.generation,
    leaseToken: upload.claim.leaseToken,
    outcome: "OBSERVED",
    observation: upload.observation,
    workerId: WORKER_ID,
    idempotencyKey: "provider-settle-upload-no-receipt",
  }), "PROVIDER_OBSERVATION_RECEIPT_MISMATCH");

  // 영수증의 어느 한 축이라도 execution binding과 어긋나면 gate/candidate/lifecycle/audit이 그대로다.
  const forgedReceipts: Array<[string, Record<string, unknown>]> = [
    ["binding", { bindingHash: "1".repeat(64) }],
    ["generation", { generation: upload.claim.generation + 1 }],
    ["policy generation", { policyGeneration: upload.receipt.policyGeneration + 1 }],
    ["grant id", { policyGrantId: `provider-grant-${"2".repeat(40)}-1` }],
    ["command digest", { commandDigest: "3".repeat(64) }],
    ["grant digest", { policyGrantDigest: "not-a-digest" }],
  ];
  for (const [label, patch] of forgedReceipts) {
    await expectRejected(`forged receipt ${label}`, candidateId, () => settleProviderExecution({
      executionId: upload.execution.id,
      generation: upload.claim.generation,
      leaseToken: upload.claim.leaseToken,
      outcome: "OBSERVED",
      observation: upload.observation,
      observationReceipt: { ...upload.receipt, ...patch } as typeof upload.receipt,
      workerId: WORKER_ID,
      idempotencyKey: `provider-settle-upload-forged-${label.replace(/\s+/g, "-")}`,
    }), "PROVIDER_OBSERVATION_RECEIPT_MISMATCH");
  }

  const settled = await settleProviderExecution({
    executionId: upload.execution.id,
    generation: upload.claim.generation,
    leaseToken: upload.claim.leaseToken,
    outcome: "OBSERVED",
    observation: upload.observation,
    observationReceipt: upload.receipt,
    workerId: WORKER_ID,
    idempotencyKey: "provider-settle-upload",
  });
  assert.equal(settled.status, "SUCCEEDED");
  assert.equal(settled.duplicate, false);

  const afterUpload = await ledgerSnapshot(candidateId);
  assert.equal(afterUpload.stage, "SUBMITTED");
  assert.equal(afterUpload.gates, RELEASE_CANDIDATE_REQUIRED_GATES.length + 1);

  const uploadGate = await prisma.releaseGateObservation.findFirstOrThrow({
    where: { candidateId, gate: "UPLOAD" },
  });
  const uploadEvidence = uploadGate.evidence as Record<string, unknown>;
  assert.equal(uploadEvidence.providerExecutionId, upload.execution.id);
  assert.equal(typeof uploadEvidence.providerObservationId, "string");
  assert.equal(uploadEvidence.publicIdentity, `${PUBLISHER_ACCOUNT}/${PACKAGE_ID}`);
  assert.equal(uploadEvidence.providerReference, "edits/upload-1");
  assert.equal(uploadEvidence.providerPolicyGrantId, upload.receipt.policyGrantId);

  const settlementEvent = await prisma.providerExecutionEvent.findUniqueOrThrow({
    where: { requestId: "provider-settle-upload" },
  });
  const eventPayload = settlementEvent.payload as { observationReceipt?: Record<string, unknown> };
  assert.equal(eventPayload.observationReceipt?.policyGrantId, upload.receipt.policyGrantId);
  assert.equal(eventPayload.observationReceipt?.bindingHash, upload.receipt.bindingHash);

  // 같은 idempotency key 재호출은 원장을 한 번만 반영한다.
  const replayedSettlement = await settleProviderExecution({
    executionId: upload.execution.id,
    generation: upload.claim.generation,
    leaseToken: upload.claim.leaseToken,
    outcome: "OBSERVED",
    observation: upload.observation,
    observationReceipt: upload.receipt,
    workerId: WORKER_ID,
    idempotencyKey: "provider-settle-upload",
  });
  assert.equal(replayedSettlement.duplicate, true);
  assert.deepEqual(await ledgerSnapshot(candidateId), afterUpload);

  const ladder = [
    { key: "processing", gate: "PROCESSING" as const, state: "SUCCEEDED" as const, stage: "SUBMITTED" },
    { key: "device-qa", gate: "DEVICE_QA" as const, state: "SUCCEEDED" as const, stage: "SUBMITTED" },
    { key: "review", gate: "REVIEW" as const, state: "SUCCEEDED" as const, stage: "REVIEW" },
    { key: "approval", gate: "APPROVAL" as const, state: "APPROVED" as const, stage: "APPROVED_FOR_RELEASE" },
    { key: "deployment", gate: "DEPLOYMENT" as const, state: "SUCCEEDED" as const, stage: "DEPLOYED" },
    { key: "public", gate: "PUBLIC" as const, state: "LIVE" as const, stage: "PUBLIC_VERIFIED" },
    { key: "public-sustained", gate: "PUBLIC" as const, state: "LIVE" as const, stage: "MONITORED" },
  ];
  for (const [index, step] of ladder.entries()) {
    const run = await runMarketSettlement({
      key: step.key,
      operation: "READBACK",
      gate: step.gate,
      state: step.state,
      candidateId,
      observedAt: new Date(observedAt.getTime() + 10_000 + index * 1_000),
      providerReference: `edits/${step.key}`,
    });
    const result = await settleProviderExecution({
      executionId: run.execution.id,
      generation: run.claim.generation,
      leaseToken: run.claim.leaseToken,
      outcome: "OBSERVED",
      observation: run.observation,
      observationReceipt: run.receipt,
      workerId: WORKER_ID,
      idempotencyKey: `provider-settle-${step.key}`,
    });
    assert.equal(result.status, "SUCCEEDED");
    const snapshot = await ledgerSnapshot(candidateId);
    assert.equal(snapshot.stage, step.stage, `${step.key}: lifecycle 단계가 예상과 다르다`);
  }

  const final = await ledgerSnapshot(candidateId);
  assert.equal(final.stage, "MONITORED");
  assert.equal(final.candidateStatus, "READY");
  // RELEASE_CANDIDATE + SUBMITTED + REVIEW + APPROVED_FOR_RELEASE + DEPLOYED + PUBLIC_VERIFIED + MONITORED
  assert.equal(final.events, 7);
  assert.equal(
    await prisma.releaseGateObservation.count({ where: { candidateId, observedBy: "forged-principal" } }),
    0,
  );

  console.log(JSON.stringify({
    ok: true,
    candidateStatus: final.candidateStatus,
    lifecycleStage: final.stage,
    gateObservations: final.gates,
    lifecycleEvents: final.events,
    resourceCount: plan.resources.length,
    productionProviderWrite: false,
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
