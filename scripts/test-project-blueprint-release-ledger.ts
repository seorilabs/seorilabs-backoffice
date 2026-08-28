import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import {
  RELEASE_CANDIDATE_REQUIRED_GATES,
  type PlatformReleaseManifest,
  type ProjectBlueprint,
} from "@/lib/control-plane/contracts";
import { signSnapshot } from "@/lib/control-plane/json";
import { getProjectBlueprintPlan } from "@/lib/control-plane/project-blueprint-service";
import { createReleaseCandidate, recordReleaseGateObservation } from "@/lib/control-plane/release-ledger";
import {
  activateConfigRevision,
  createConfigRevision,
  recordDiscoveryObservation,
} from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

const APP_ID = "project-blueprint-integration-app";
const REPO_ID = 9_000_000_001n;
const SOURCE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "c".repeat(40);
const ARTIFACT_SHA = "d".repeat(64);
const RULES_SHA = "e".repeat(64);
const PLATFORM_ARTIFACT_SHA = "f".repeat(64);
const PLATFORM_CONTRACT_REVISION = "1".repeat(64);

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
    consumers: [{ repoId: REPO_ID.toString(), artifactKind: "TYPESCRIPT" }],
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

  const created = await createReleaseCandidate({
    repoId: REPO_ID,
    sourceSha: SOURCE_SHA,
    configRevision: 1,
    market: "google-play",
    targetKey: "android-release",
    artifactType: "android-aab",
    artifactChecksum: ARTIFACT_SHA,
    workflowBundleSha: WORKFLOW_SHA,
    platformVersion: "0.6.5",
    actor: "integration-worker",
    idempotencyKey: "project-blueprint-integration-candidate",
  });
  assert.equal(created.candidate.status, "PREPARED");
  const replay = await createReleaseCandidate({
    repoId: REPO_ID,
    sourceSha: SOURCE_SHA,
    configRevision: 1,
    market: "google-play",
    targetKey: "android-release",
    artifactType: "android-aab",
    artifactChecksum: ARTIFACT_SHA,
    workflowBundleSha: WORKFLOW_SHA,
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
  console.log(JSON.stringify({
    ok: true,
    candidateStatus: candidate.status,
    lifecycleStage: lifecycle.stage,
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
