import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import {
  PLATFORM_AFFECTED_CONSUMERS,
  RELEASE_CANDIDATE_REQUIRED_GATES,
  type PlatformReleaseManifest,
  type ProjectBlueprint,
} from "@/lib/control-plane/contracts";
import { jsonDigest, signSnapshot, type JsonValue } from "@/lib/control-plane/json";
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
  recordProviderObservation,
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
const PLATFORM_GDSCRIPT_SHA = "6".repeat(64);
const PLATFORM_GDSCRIPT_TREE_SHA = "7".repeat(64);
const PLATFORM_CONTRACT_REVISION = "1".repeat(64);
const PUBLISHER_ACCOUNT = "1234567890123456789";
const PACKAGE_ID = "com.seorilabs.blueprint";
const SIGNING_KEY = "integration-provider-lease-signing-key-0123456789";
const WORKER_ID = "integration-provider-worker";
const SUBJECT = "k8s:platform:provider-execution-worker";
const GODOT_APP_ID = "project-blueprint-godot-integration-app";
const GODOT_REPO_ID = 9_000_000_002n;
const GODOT_SOURCE_SHA = "4".repeat(40);
const GODOT_ARTIFACT_SHA = "5".repeat(64);
const GODOT_PACKAGE_ID = "com.seorilabs.blueprint.godot";

function discoveryPayload(input: {
  repoId: bigint;
  repoFullName: string;
  sourceSha: string;
}) {
  return {
    schemaVersion: 2,
    contractVersion: "repository-discovery/v8",
    repository: {
      id: Number(input.repoId),
      fullName: input.repoFullName,
      sourceSha: input.sourceSha,
      sourceRef: "refs/heads/main",
    },
    status: "ACTIVE",
    classification: "PRODUCT_APP",
  };
}

async function recordManagedRegistration(input: {
  repoId: bigint;
  repoFullName: string;
  sourceSha: string;
}) {
  await prisma.repositoryRegistration.create({
    data: {
      repoId: input.repoId,
      repoFullName: input.repoFullName,
      defaultBranch: "main",
      status: "MANAGED",
      managementKind: "APP",
      classification: "PRODUCT_APP",
      discoveryContractVersion: "repository-discovery/v8",
      lastDefaultPushSha: input.sourceSha,
      lastReconciledSha: input.sourceSha,
    },
  });
}

/**
 * gate 원장에 실제로 남은 관측과 lifecycle 상태를 한 번에 읽는다.
 * 거부 경로가 정말 0 mutation인지 판정하는 기준이다.
 */
async function ledgerSnapshot(candidateId: string, appId = APP_ID) {
  const [gates, candidate, lifecycle, events, audits, observations, executionEvents] = await Promise.all([
    prisma.releaseGateObservation.count({ where: { candidateId } }),
    prisma.releaseCandidate.findUniqueOrThrow({ where: { id: candidateId }, select: { status: true } }),
    prisma.fleetLifecycleState.findUnique({ where: { appId }, select: { stage: true, generation: true } }),
    prisma.fleetLifecycleEvent.count({ where: { appId } }),
    prisma.auditLog.count(),
    prisma.providerObservation.count({ where: { appId } }),
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
  appId = APP_ID,
) {
  const before = await ledgerSnapshot(candidateId, appId);
  let code: string | null = null;
  try {
    await run();
  } catch (error) {
    code = error instanceof ControlPlaneError ? error.code : (error as Error).message;
  }
  assert.equal(code, expectedCode, `${label}: 예상 거부 코드가 아니다`);
  assert.deepEqual(await ledgerSnapshot(candidateId, appId), before, `${label}: 거부 경로가 원장을 변경했다`);
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

function blueprint(input: {
  projectId?: string;
  packageId?: string;
} = {}): ProjectBlueprint {
  const projectId = input.projectId ?? "blueprint-prod";
  const packageId = input.packageId ?? PACKAGE_ID;
  return {
    schemaVersion: 1,
    organizationId: "123456789",
    folderId: "234567890",
    billingAccountId: "ABCDEF-123456-789ABC",
    project: { projectId, projectNumber: "345678901", region: "asia-northeast3" },
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
      apps: [{ platform: "ANDROID", packageId }],
    },
    analytics: {
      bigQueryProjectId: projectId,
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

function configPayload(input: {
  projectBlueprint?: ProjectBlueprint;
  assetKey: string;
}) {
  return {
    schemaVersion: 1,
    markets: [{ market: "google-play" as const, enabled: true, locales: ["ko-KR"], releaseChannel: "internal" as const }],
    ...(input.projectBlueprint ? { projectBlueprint: input.projectBlueprint } : {}),
    build: {
      workflowBundleSha: WORKFLOW_SHA,
      workflowBundleDigest: `sha256:${WORKFLOW_DIGEST}`,
      platformVersion: "0.6.5",
      minSdk: 24,
      targetSdk: 36,
    },
    complianceDrafts: [{ market: "google-play" as const, declaration: "data-safety" as const, state: "DRAFT" as const, draft: true }],
    assets: [{ market: "google-play" as const, kind: "icon", objectKey: input.assetKey, checksum: RULES_SHA }],
  };
}

async function recordCompliantBlueprintReadbacks(input: {
  repoId: bigint;
  sourceSha: string;
  configRevision: number;
  keyPrefix: string;
  observedAt: Date;
}) {
  const plan = await getProjectBlueprintPlan({
    repoId: input.repoId,
    sourceSha: input.sourceSha,
    configRevision: input.configRevision,
  });
  for (const [index, resource] of plan.resources.entries()) {
    const payload = {
      schemaVersion: 1,
      visibility: "VISIBLE",
      state: "PRESENT",
      ...(resource.publicIdentity ? { publicIdentity: resource.publicIdentity } : {}),
      attributes: { desiredHash: resource.desiredHash },
    };
    await recordProviderObservation({
      repoId: input.repoId,
      provider: resource.provider,
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
      observedAt: new Date(input.observedAt.getTime() + index),
      observedBy: "integration-worker",
      idempotencyKey: `${input.keyPrefix}-resource-${index}`,
      payload,
    });
  }
  return getProjectBlueprintPlan({
    repoId: input.repoId,
    sourceSha: input.sourceSha,
    configRevision: input.configRevision,
  });
}

async function runGodotReleaseCandidateFixture(input: {
  platformReleaseId: string;
  manifestDigest: string;
  observedAt: Date;
}) {
  await prisma.app.create({
    data: {
      id: GODOT_APP_ID,
      slug: "project-blueprint-godot-integration",
      displayName: "Project Blueprint Godot Integration",
      repoFullName: "seorilabs/project-blueprint-godot-integration",
      repoId: GODOT_REPO_ID,
      type: "GAME",
      engine: "GODOT",
      marketTargets: ["play"],
    },
  });
  await recordManagedRegistration({
    repoId: GODOT_REPO_ID,
    repoFullName: "seorilabs/project-blueprint-godot-integration",
    sourceSha: GODOT_SOURCE_SHA,
  });
  await recordDiscoveryObservation({
    repoId: GODOT_REPO_ID,
    sourceSha: GODOT_SOURCE_SHA,
    sourceRef: "refs/heads/main",
    observedAt: input.observedAt,
    observedBy: "integration-worker",
    idempotencyKey: "project-blueprint-godot-discovery",
    workflowCaller: { profile: "godot", packageManager: null, workingDirectory: "." },
    payload: discoveryPayload({
      repoId: GODOT_REPO_ID,
      repoFullName: "seorilabs/project-blueprint-godot-integration",
      sourceSha: GODOT_SOURCE_SHA,
    }),
    buildTargets: [{
      targetKey: "android-release",
      stack: "godot",
      market: "google-play",
      packageId: GODOT_PACKAGE_ID,
    }],
  });
  const withoutBlueprint = await createConfigRevision({
    repoId: GODOT_REPO_ID,
    expectedLatestRevision: 0,
    actor: "integration-human",
    idempotencyKey: "project-blueprint-godot-config-without-blueprint",
    payload: configPayload({ assetKey: "apps/blueprint-godot/icon" }),
  });
  assert.equal(withoutBlueprint.revision.revision, 1);
  await activateConfigRevision({
    repoId: GODOT_REPO_ID,
    revision: 1,
    expectedActiveRevision: 0,
    actor: "integration-human",
    idempotencyKey: "project-blueprint-godot-activate-without-blueprint",
    signingKey: "integration-signing-key",
  });
  await prisma.credentialBinding.createMany({
    data: [
      ["shared/gcp/provisioner-session", "gcp-project-provision"],
      ["shared/gcp/firebase-automation", "firebase-provision"],
      ["shared/google-workspace/provisioner", "workspace-provision"],
    ].map(([logicalCredentialId, capability]) => ({
      appId: GODOT_APP_ID,
      logicalCredentialId,
      provider: "google",
      capability,
      environment: "production",
      publicIdentity: `${capability}@example.invalid`,
      consumer: "project-blueprint-godot-integration",
      observedAt: input.observedAt,
    })),
  });
  await prisma.platformFleetBinding.create({
    data: {
      appId: GODOT_APP_ID,
      platformReleaseId: input.platformReleaseId,
      observedVersion: "0.6.5",
      observedDigest: PLATFORM_GDSCRIPT_SHA,
      approvedVersion: "0.6.5",
      approvedDigest: PLATFORM_GDSCRIPT_SHA,
      manifestDigest: input.manifestDigest,
      contractRevision: PLATFORM_CONTRACT_REVISION,
      state: "COMPLIANT",
      sourceSha: GODOT_SOURCE_SHA,
    },
  });
  const missingBlueprintCandidate = await createReleaseCandidate({
    repoId: GODOT_REPO_ID,
    sourceSha: GODOT_SOURCE_SHA,
    configRevision: 1,
    market: "google-play",
    targetKey: "android-release",
    artifactType: "android-aab",
    artifactChecksum: GODOT_ARTIFACT_SHA,
    workflowBundleSha: WORKFLOW_SHA,
    workflowBundleDigest: WORKFLOW_DIGEST,
    platformVersion: "0.6.5",
    actor: "integration-worker",
    idempotencyKey: "project-blueprint-godot-candidate-without-blueprint",
  });
  await expectRejected(
    "godot provider shell blueprint missing",
    missingBlueprintCandidate.candidate.id,
    () => recordReleaseGateObservation({
      candidateId: missingBlueprintCandidate.candidate.id,
      gate: "PROVIDER_SHELL",
      status: "PASSED",
      observedAt: new Date(input.observedAt.getTime() + 1_000),
      evidence: {
        schemaVersion: 1,
        sourceSha: GODOT_SOURCE_SHA,
        configRevision: 1,
        artifactChecksum: GODOT_ARTIFACT_SHA,
      },
      actor: "integration-worker",
      idempotencyKey: "project-blueprint-godot-provider-shell-missing",
    }),
    "BLUEPRINT_NOT_CONFIGURED",
    GODOT_APP_ID,
  );

  const configured = await createConfigRevision({
    repoId: GODOT_REPO_ID,
    expectedLatestRevision: 1,
    actor: "integration-human",
    idempotencyKey: "project-blueprint-godot-config-compliant",
    payload: configPayload({
      projectBlueprint: blueprint({
        projectId: "blueprint-godot-prod",
        packageId: GODOT_PACKAGE_ID,
      }),
      assetKey: "apps/blueprint-godot/icon",
    }),
  });
  assert.equal(configured.revision.revision, 2);
  await activateConfigRevision({
    repoId: GODOT_REPO_ID,
    revision: 2,
    expectedActiveRevision: 1,
    actor: "integration-human",
    idempotencyKey: "project-blueprint-godot-activate-compliant",
    signingKey: "integration-signing-key",
  });
  const candidate = await createReleaseCandidate({
    repoId: GODOT_REPO_ID,
    sourceSha: GODOT_SOURCE_SHA,
    configRevision: 2,
    market: "google-play",
    targetKey: "android-release",
    artifactType: "android-aab",
    artifactChecksum: GODOT_ARTIFACT_SHA,
    workflowBundleSha: WORKFLOW_SHA,
    workflowBundleDigest: WORKFLOW_DIGEST,
    platformVersion: "0.6.5",
    actor: "integration-worker",
    idempotencyKey: "project-blueprint-godot-candidate-compliant",
  });
  for (const [index, gate] of RELEASE_CANDIDATE_REQUIRED_GATES.filter((name) => name !== "PROVIDER_SHELL").entries()) {
    await recordReleaseGateObservation({
      candidateId: candidate.candidate.id,
      gate,
      status: "PASSED",
      observedAt: new Date(input.observedAt.getTime() + 2_000 + index),
      evidence: {
        schemaVersion: 1,
        sourceSha: GODOT_SOURCE_SHA,
        configRevision: 2,
        artifactChecksum: GODOT_ARTIFACT_SHA,
      },
      actor: "integration-worker",
      idempotencyKey: `project-blueprint-godot-gate-${gate.toLowerCase()}`,
    });
  }
  const readyToApply = await getProjectBlueprintPlan({
    repoId: GODOT_REPO_ID,
    sourceSha: GODOT_SOURCE_SHA,
    configRevision: 2,
  });
  assert.equal(readyToApply.status, "READY_TO_APPLY");
  const compliant = await recordCompliantBlueprintReadbacks({
    repoId: GODOT_REPO_ID,
    sourceSha: GODOT_SOURCE_SHA,
    configRevision: 2,
    keyPrefix: "project-blueprint-godot-compliant",
    observedAt: new Date(input.observedAt.getTime() + 90_000),
  });
  assert.equal(compliant.status, "COMPLIANT");
  assert.equal(compliant.appId, GODOT_APP_ID);
  await recordReleaseGateObservation({
    candidateId: candidate.candidate.id,
    gate: "PROVIDER_SHELL",
    status: "PASSED",
    observedAt: new Date(input.observedAt.getTime() + 110_000),
    evidence: {
      schemaVersion: 1,
      sourceSha: GODOT_SOURCE_SHA,
      configRevision: 2,
      artifactChecksum: GODOT_ARTIFACT_SHA,
    },
    actor: "integration-worker",
    idempotencyKey: "project-blueprint-godot-provider-shell-compliant",
  });
  const [storedCandidate, lifecycle, shellGate] = await Promise.all([
    prisma.releaseCandidate.findUniqueOrThrow({ where: { id: candidate.candidate.id } }),
    prisma.fleetLifecycleState.findUniqueOrThrow({ where: { appId: GODOT_APP_ID } }),
    prisma.releaseGateObservation.findFirstOrThrow({
      where: { candidateId: candidate.candidate.id, gate: "PROVIDER_SHELL" },
    }),
  ]);
  assert.equal(storedCandidate.status, "READY");
  assert.equal(lifecycle.stage, "RELEASE_CANDIDATE");
  assert.equal((shellGate.evidence as { projectBlueprint?: { appId?: string; configRevision?: number } })
    .projectBlueprint?.appId, GODOT_APP_ID);
  assert.equal((shellGate.evidence as { projectBlueprint?: { appId?: string; configRevision?: number } })
    .projectBlueprint?.configRevision, 2);
  return { candidateStatus: storedCandidate.status, lifecycleStage: lifecycle.stage };
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
  await recordManagedRegistration({
    repoId: REPO_ID,
    repoFullName: "seorilabs/project-blueprint-integration",
    sourceSha: SOURCE_SHA,
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
    payload: discoveryPayload({
      repoId: REPO_ID,
      repoFullName: "seorilabs/project-blueprint-integration",
      sourceSha: SOURCE_SHA,
    }),
    buildTargets: [{
      targetKey: "android-release",
      stack: "react-native",
      market: "google-play",
      packageId: "com.seorilabs.blueprint",
    }],
  });
  const draft = await createConfigRevision({
    repoId: REPO_ID,
    expectedLatestRevision: 0,
    actor: "integration-human",
    idempotencyKey: "project-blueprint-integration-config",
    payload: configPayload({ projectBlueprint: blueprint(), assetKey: "apps/blueprint/icon" }),
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
    affectedConsumers: PLATFORM_AFFECTED_CONSUMERS,
    publishedAt: observedAt.toISOString(),
    artifacts: [{
      kind: "TYPESCRIPT",
      version: "0.6.5",
      digest: PLATFORM_ARTIFACT_SHA,
      packageName: "@seorilabs/platform",
    }, {
      kind: "GDSCRIPT",
      version: "0.6.5",
      digest: PLATFORM_GDSCRIPT_SHA,
      releaseAssetUrl: "https://github.com/seorilabs/platform/releases/download/v0.6.5/platform-gdscript.zip",
      treeChecksum: PLATFORM_GDSCRIPT_TREE_SHA,
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
  }), (error) => error instanceof ControlPlaneError && error.code === "WORKFLOW_BUNDLE_DIGEST_MISMATCH");

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

  for (const [index, gate] of RELEASE_CANDIDATE_REQUIRED_GATES.filter((name) => name !== "PROVIDER_SHELL").entries()) {
    await recordReleaseGateObservation({
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
    });
  }

  const providerShellEvidence = {
    schemaVersion: 1 as const,
    sourceSha: SOURCE_SHA,
    configRevision: 1,
    artifactChecksum: ARTIFACT_SHA,
  };
  const providerShellRequest = (idempotencyKey: string) => ({
    candidateId: created.candidate.id,
    gate: "PROVIDER_SHELL" as const,
    status: "PASSED" as const,
    observedAt: new Date(observedAt.getTime() + 80_000),
    evidence: providerShellEvidence,
    actor: "integration-worker",
    idempotencyKey,
  });

  await expectRejected(
    "provider shell source mismatch",
    created.candidate.id,
    () => recordReleaseGateObservation({
      ...providerShellRequest("project-blueprint-provider-shell-source-mismatch"),
      evidence: {
        ...providerShellEvidence,
        sourceSha: "9".repeat(40),
      },
    }),
    "EVIDENCE_MISMATCH",
  );
  await expectRejected(
    "provider shell config mismatch",
    created.candidate.id,
    () => recordReleaseGateObservation({
      ...providerShellRequest("project-blueprint-provider-shell-config-mismatch"),
      evidence: {
        ...providerShellEvidence,
        configRevision: 2,
      },
    }),
    "EVIDENCE_MISMATCH",
  );

  // shared credential만 준비되고 provider readback이 없으면 임의 PASSED를 원장에 넣을 수 없다.
  await expectRejected(
    "provider shell ready-to-apply",
    created.candidate.id,
    () => recordReleaseGateObservation(providerShellRequest("project-blueprint-provider-shell-unobserved")),
    "PROVIDER_SHELL_NOT_COMPLIANT",
  );

  const compliantPlan = await recordCompliantBlueprintReadbacks({
    repoId: REPO_ID,
    sourceSha: SOURCE_SHA,
    configRevision: 1,
    keyPrefix: "project-blueprint-integration-compliant",
    observedAt: new Date(observedAt.getTime() + 30_000),
  });
  assert.equal(compliantPlan.status, "COMPLIANT");
  assert.equal(compliantPlan.appId, APP_ID);

  // 더 최신 readback이 drift면 과거 PRESENT가 있어도 fail-closed한다.
  const driftResource = compliantPlan.resources[0];
  await recordProviderObservation({
    repoId: REPO_ID,
    provider: driftResource.provider,
    resourceType: driftResource.resourceType,
    resourceId: driftResource.resourceId,
    observedAt: new Date(observedAt.getTime() + 60_000),
    observedBy: "integration-worker",
    idempotencyKey: "project-blueprint-integration-drift",
    payload: {
      schemaVersion: 1,
      visibility: "VISIBLE",
      state: "PRESENT",
      ...(driftResource.publicIdentity ? { publicIdentity: driftResource.publicIdentity } : {}),
      attributes: { desiredHash: "0".repeat(64) },
    },
  });
  assert.equal(
    (await getProjectBlueprintPlan({ repoId: REPO_ID, sourceSha: SOURCE_SHA, configRevision: 1 })).status,
    "READY_TO_APPLY",
  );
  await expectRejected(
    "provider shell drift",
    created.candidate.id,
    () => recordReleaseGateObservation(providerShellRequest("project-blueprint-provider-shell-drift")),
    "PROVIDER_SHELL_NOT_COMPLIANT",
  );

  await recordProviderObservation({
    repoId: REPO_ID,
    provider: driftResource.provider,
    resourceType: driftResource.resourceType,
    resourceId: driftResource.resourceId,
    observedAt: new Date(observedAt.getTime() + 70_000),
    observedBy: "integration-worker",
    idempotencyKey: "project-blueprint-integration-drift-recovered",
    payload: {
      schemaVersion: 1,
      visibility: "VISIBLE",
      state: "PRESENT",
      ...(driftResource.publicIdentity ? { publicIdentity: driftResource.publicIdentity } : {}),
      attributes: { desiredHash: driftResource.desiredHash },
    },
  });
  const recoveredPlan = await getProjectBlueprintPlan({
    repoId: REPO_ID,
    sourceSha: SOURCE_SHA,
    configRevision: 1,
  });
  assert.equal(recoveredPlan.status, "COMPLIANT");

  // 같은 exact request의 동시 호출도 서버 검증된 PROVIDER_SHELL 관측 하나만 만든다.
  const concurrentProviderShell = await Promise.all([
    recordReleaseGateObservation(providerShellRequest("project-blueprint-provider-shell-compliant")),
    recordReleaseGateObservation(providerShellRequest("project-blueprint-provider-shell-compliant")),
  ]);
  assert.equal(concurrentProviderShell.filter((result) => result.duplicate).length, 1);
  const providerShell = await prisma.releaseGateObservation.findFirstOrThrow({
    where: { candidateId: created.candidate.id, gate: "PROVIDER_SHELL" },
  });
  const storedProviderShellEvidence = providerShell.evidence as Record<string, unknown>;
  assert.deepEqual(storedProviderShellEvidence.projectBlueprint, {
    schemaVersion: 1,
    appId: APP_ID,
    projectId: recoveredPlan.projectId,
    sourceSha: SOURCE_SHA,
    configRevision: 1,
    planDigest: jsonDigest(recoveredPlan as unknown as JsonValue),
    providerObservationIds: recoveredPlan.resources.flatMap((resource) => (
      resource.providerObservationId ? [resource.providerObservationId] : []
    )),
  });
  assert.equal(
    (storedProviderShellEvidence.projectBlueprint as { providerObservationIds?: unknown[] })
      .providerObservationIds?.length,
    recoveredPlan.resources.length,
  );

  const candidate = await prisma.releaseCandidate.findUniqueOrThrow({ where: { id: created.candidate.id } });
  const lifecycle = await prisma.fleetLifecycleState.findUniqueOrThrow({ where: { appId: APP_ID } });
  assert.equal(candidate.status, "READY");
  assert.equal(lifecycle.stage, "RELEASE_CANDIDATE");
  assert.equal(await prisma.fleetLifecycleEvent.count({ where: { appId: APP_ID } }), 1);

  const godotResult = await runGodotReleaseCandidateFixture({
    platformReleaseId: platformRelease.id,
    manifestDigest: signedPlatformManifest.digest,
    observedAt: new Date(observedAt.getTime() + 120_000),
  });

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
    releaseCandidateEngines: {
      reactNative: { candidateStatus: candidate.status, lifecycleStage: lifecycle.stage },
      godot: godotResult,
    },
    productionProviderWrite: false,
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
