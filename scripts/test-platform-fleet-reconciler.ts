import assert from "node:assert/strict";
import crypto from "node:crypto";

import { Prisma } from "@prisma/client";

import {
  platformFleetTaskInputSchema,
  type PlatformReleaseManifest,
} from "@/lib/control-plane/contracts";
import { signSnapshot, type JsonValue } from "@/lib/control-plane/json";
import {
  applyPlatformContractIssuePlan,
  reconcilePlatformFleet,
  recordPlatformRelease,
  type PlatformGithubIssue,
  type TrustedPlatformGithubAdapter,
} from "@/lib/control-plane/platform-fleet";
import { prisma } from "@/lib/prisma";
import {
  ControlPlaneError,
  recordDiscoveryObservation,
  recordProviderObservation,
} from "@/lib/control-plane/service";

const nonce = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const implementationVersion = `0.${Date.now()}.0`;
const contractVersion = `0.${Date.now()}.1`;
const repoIdA = BigInt(`8${Date.now()}`);
const repoIdB = repoIdA + 1n;
const sourceShaA = "1".repeat(40);
const sourceShaB = "2".repeat(40);
const releaseSourceSha = "3".repeat(40);
const artifactDigest = "a".repeat(64);
const oldArtifactDigest = "b".repeat(64);
const contractRevision = "c".repeat(64);
const oldContractRevision = "d".repeat(64);
const signingKey = "platform-fleet-integration-signing-key";
const repoFullNameA = `seorilabs/platform-fleet-a-${nonce}`;
const repoFullNameB = `seorilabs/platform-fleet-b-${nonce}`;
const workflowSourceSha = "4".repeat(40);

function canaryEvidence(): PlatformReleaseManifest["canaryEvidence"] {
  return {
    attestationSha256: `sha256:${"5".repeat(64)}`,
    readbackKeyId: "integration-readback-key",
    workflowBundle: {
      repository: "seorilabs/.github",
      sourceSha: workflowSourceSha,
      digest: `sha256:${"6".repeat(64)}`,
    },
    canaries: ["godot", "react-native"].map((profile, index) => ({
      profile: profile as "godot" | "react-native",
      repositoryId: String(9_100 + index),
      repositoryFullName: `seorilabs/${profile}-platform-canary`,
      sourceSha: index === 0 ? sourceShaA : sourceShaB,
      staticRun: {
        runId: String(200 + index * 2), conclusion: "success" as const,
        headSha: index === 0 ? sourceShaA : sourceShaB, workflowSourceSha,
      },
      buildOnlyRun: {
        runId: String(201 + index * 2), conclusion: "success" as const,
        headSha: index === 0 ? sourceShaA : sourceShaB, workflowSourceSha,
        cloudBuildId: `integration-build-${index}`,
        builderImageDigest: `sha256:${"7".repeat(64)}`,
        buildConfigDigest: `sha256:${"8".repeat(64)}`,
        artifact: { name: `${profile}.aab`, sha256: `sha256:${"9".repeat(64)}`, size: 1 },
      },
    })) as PlatformReleaseManifest["canaryEvidence"]["canaries"],
  };
}

function releaseManifest(input: {
  version: string;
  classification: PlatformReleaseManifest["classification"];
}): PlatformReleaseManifest {
  return {
    schemaVersion: 1,
    approval: "FLEET_APPROVED",
    version: input.version,
    sourceSha: releaseSourceSha,
    contractRevision,
    classification: input.classification,
    publishedAt: new Date().toISOString(),
    artifacts: [{
      kind: "TYPESCRIPT",
      version: input.version,
      digest: artifactDigest,
      packageName: "@seorilabs/platform",
    }],
    canaryEvidence: canaryEvidence(),
    provenance: {
      repository: "seorilabs/platform",
      releaseId: "9001",
      releaseTag: `v${input.version}`,
      rawManifestSha256: "a".repeat(64),
      approvalSha256: "b".repeat(64),
      approvalKeyId: "integration-approval-key",
    },
  };
}

async function addApp(input: {
  id: string;
  slug: string;
  repoId: bigint;
  repoFullName: string;
  sourceSha: string;
}) {
  await prisma.app.create({
    data: {
      id: input.id,
      slug: input.slug,
      displayName: input.slug,
      repoId: input.repoId,
      repoFullName: input.repoFullName,
      type: "APP",
      engine: "RN",
      status: "ACTIVE",
      marketTargets: [],
    },
  });
  await prisma.repositoryRegistration.create({
    data: {
      repoId: input.repoId,
      repoFullName: input.repoFullName,
      defaultBranch: "main",
      status: "MANAGED",
      managementKind: "APP",
      lastDefaultPushSha: input.sourceSha,
      lastReconciledSha: input.sourceSha,
    },
  });
  return recordDiscoveryObservation({
    repoId: input.repoId,
    sourceSha: input.sourceSha,
    sourceRef: "refs/heads/main",
    observedAt: new Date(),
    observedBy: "integration:platform-fleet",
    idempotencyKey: `platform-fleet-discovery:${input.repoId}:${nonce}`,
    workflowCaller: { profile: "react-native", packageManager: "pnpm", workingDirectory: "." },
    payload: { stack: "react-native", fixture: "platform-fleet" },
    buildTargets: [],
  });
}

async function addPlatformObservation(input: {
  repoId: bigint;
  sourceSha: string;
  suffix: string;
  payload: Record<string, unknown>;
}) {
  return recordProviderObservation({
    repoId: input.repoId,
    provider: "platform",
    resourceType: "platform-consumer",
    resourceId: input.repoId.toString(),
    observedAt: new Date(),
    observedBy: "integration:platform-fleet",
    idempotencyKey: `platform-fleet-provider:${input.repoId}:${input.suffix}:${nonce}`,
    payload: input.payload,
  });
}

async function addRelease(manifest: PlatformReleaseManifest, suffix: string) {
  const signed = signSnapshot(manifest as unknown as JsonValue, signingKey);
  return recordPlatformRelease({
    manifest,
    manifestDigest: signed.digest,
    signature: signed.signature,
    actor: "integration:platform-producer",
    idempotencyKey: `platform-fleet-release:${suffix}:${nonce}`,
    signingKey,
  });
}

async function main() {
  // 같은 disposable contract DB에서 먼저 실행된 fixture 앱은 이 테스트의 current cohort가 아니다.
  await prisma.app.updateMany({ where: { status: "ACTIVE" }, data: { status: "PAUSED" } });
  const appIdA = `platform-fleet-a-${nonce}`;
  const appIdB = `platform-fleet-b-${nonce}`;
  const [discoveryA, discoveryB] = await Promise.all([
    addApp({ id: appIdA, slug: appIdA, repoId: repoIdA, repoFullName: repoFullNameA, sourceSha: sourceShaA }),
    addApp({ id: appIdB, slug: appIdB, repoId: repoIdB, repoFullName: repoFullNameB, sourceSha: sourceShaB }),
  ]);
  const [sdkObservationA, customObservationB] = await Promise.all([
    addPlatformObservation({
      repoId: repoIdA,
      sourceSha: sourceShaA,
      suffix: "implementation-sdk",
      payload: {
        schemaVersion: 1,
        sourceSha: sourceShaA,
        integration: "SDK",
        artifactKind: "TYPESCRIPT",
        observedVersion: "0.9.0",
        observedDigest: oldArtifactDigest,
        contractRevision: oldContractRevision,
      },
    }),
    addPlatformObservation({
      repoId: repoIdB,
      sourceSha: sourceShaB,
      suffix: "custom-http",
      payload: {
        schemaVersion: 1,
        sourceSha: sourceShaB,
        integration: "CUSTOM_HTTP",
        evidenceDigest: oldArtifactDigest,
      },
    }),
  ]);

  const implementationRelease = await addRelease(releaseManifest({
    version: implementationVersion,
    classification: "IMPLEMENTATION_ONLY",
  }), "implementation");
  const implementationInput = {
    platformReleaseId: implementationRelease.release.id,
    consumers: [
      {
        repoId: repoIdA.toString(),
        discoveryObservationId: discoveryA.observation.id,
        providerObservationId: sdkObservationA.observation.id,
      },
      {
        repoId: repoIdB.toString(),
        discoveryObservationId: discoveryB.observation.id,
        providerObservationId: customObservationB.observation.id,
      },
    ],
    actor: "integration:platform-fleet",
    idempotencyKey: `platform-fleet-reconcile:implementation:${nonce}`,
    signingKey,
  };
  const implementation = await reconcilePlatformFleet(implementationInput);
  assert.equal(implementation.duplicate, false);
  const implementationPlans = await prisma.platformFleetPlan.findMany({
    where: { platformReleaseId: implementationRelease.release.id },
    include: { agentRun: true },
  });
  assert.equal(implementationPlans.length, 2);
  const sdkPlan = implementationPlans.find((plan) => plan.appId === appIdA);
  const customPlan = implementationPlans.find((plan) => plan.appId === appIdB);
  assert.equal(sdkPlan?.kind, "SDK_UPDATE_PR");
  assert.equal(sdkPlan?.status, "QUEUED");
  assert.ok(sdkPlan?.agentRun);
  assert.equal(customPlan?.kind, "CUSTOM_UNMANAGED");
  assert.equal(customPlan?.status, "UNMANAGED");
  assert.equal(customPlan?.agentRunId, null);
  const sdkTask = platformFleetTaskInputSchema.parse(sdkPlan?.agentRun?.taskInput);
  assert.equal(sdkTask.kind, "PLATFORM_SDK_UPDATE");
  if (sdkTask.kind !== "PLATFORM_SDK_UPDATE") assert.fail("SDK update task가 필요합니다.");
  assert.equal(sdkTask.artifact.digest, artifactDigest);
  assert.equal(sdkTask.sourceSha, sourceShaA);
  assert.equal((await reconcilePlatformFleet(implementationInput)).duplicate, true);
  assert.equal(await prisma.platformFleetPlan.count({
    where: { platformReleaseId: implementationRelease.release.id, appId: appIdA },
  }), 1);

  const missingRepoAppId = `platform-fleet-missing-repo-${nonce}`;
  await prisma.app.create({
    data: {
      id: missingRepoAppId,
      slug: missingRepoAppId,
      displayName: missingRepoAppId,
      repoFullName: `seorilabs/${missingRepoAppId}`,
      type: "APP",
      engine: "RN",
      status: "ACTIVE",
      marketTargets: [],
    },
  });
  await assert.rejects(
    reconcilePlatformFleet({
      ...implementationInput,
      idempotencyKey: `platform-fleet-reconcile:missing-repo:${nonce}`,
    }),
    (error) => error instanceof ControlPlaneError && error.code === "PLATFORM_ACTIVE_REPOSITORY_ID_REQUIRED",
  );
  await prisma.app.update({ where: { id: missingRepoAppId }, data: { status: "PAUSED" } });

  const currentContractObservationA = await addPlatformObservation({
    repoId: repoIdA,
    sourceSha: sourceShaA,
    suffix: "contract-sdk",
    payload: {
      schemaVersion: 1,
      sourceSha: sourceShaA,
      integration: "SDK",
      artifactKind: "TYPESCRIPT",
      observedVersion: implementationVersion,
      observedDigest: oldArtifactDigest,
      contractRevision: oldContractRevision,
    },
  });
  await assert.rejects(
    reconcilePlatformFleet({
      ...implementationInput,
      idempotencyKey: `platform-fleet-reconcile:stale-observation:${nonce}`,
    }),
    (error) => error instanceof ControlPlaneError && error.code === "PLATFORM_PROVIDER_OBSERVATION_STALE",
  );

  await prisma.app.update({ where: { id: appIdB }, data: { status: "PAUSED" } });
  const contractRelease = await addRelease(releaseManifest({
    version: contractVersion,
    classification: "CONTRACT_CHANGE",
  }), "contract");
  const contract = await reconcilePlatformFleet({
    platformReleaseId: contractRelease.release.id,
    consumers: [{
      repoId: repoIdA.toString(),
      discoveryObservationId: discoveryA.observation.id,
      providerObservationId: currentContractObservationA.observation.id,
    }],
    actor: "integration:platform-fleet",
    idempotencyKey: `platform-fleet-reconcile:contract:${nonce}`,
    signingKey,
  });
  assert.equal(contract.duplicate, false);
  const contractPlan = await prisma.platformFleetPlan.findFirstOrThrow({
    where: { platformReleaseId: contractRelease.release.id, appId: appIdA },
  });
  assert.equal(contractPlan.kind, "CONTRACT_ISSUE");
  assert.equal(contractPlan.status, "PENDING");
  const issueTask = platformFleetTaskInputSchema.parse(contractPlan.desired);
  assert.equal(issueTask.kind, "PLATFORM_CONTRACT_ISSUE");
  if (issueTask.kind !== "PLATFORM_CONTRACT_ISSUE") assert.fail("contract Issue task가 필요합니다.");

  const calls: string[] = [];
  const issue = (): PlatformGithubIssue => ({
    number: 42,
    url: "https://github.com/seorilabs/example/issues/42",
    title: issueTask.title,
    body: issueTask.body,
    labels: [...issueTask.labels],
  });
  const adapter: TrustedPlatformGithubAdapter = {
    async findIssueByMarker() {
      calls.push("read-before");
      return null;
    },
    async createIssue() {
      calls.push("create");
      return 42;
    },
    async readIssue() {
      calls.push("read-after");
      return issue();
    },
    async readPullRequest() {
      throw new Error("unexpected pull request read");
    },
  };
  const applied = await applyPlatformContractIssuePlan(contractPlan.id, adapter);
  assert.equal(applied.applied, true);
  assert.deepEqual(calls, ["read-before", "create", "read-after"]);
  assert.equal((await prisma.platformFleetPlan.findUniqueOrThrow({ where: { id: contractPlan.id } })).status, "ISSUE_OPEN");
  assert.equal((await prisma.platformFleetBinding.findUniqueOrThrow({ where: { appId: appIdA } })).issueNumber, 42);
  assert.equal((await applyPlatformContractIssuePlan(contractPlan.id, adapter)).skipped, true);

  const publicRows = await prisma.$queryRaw<Array<{ secretColumns: bigint }>>(Prisma.sql`
    SELECT COUNT(*) AS secretColumns
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN ('platform_release', 'platform_fleet_plan', 'platform_fleet_reconcile_run')
      AND LOWER(COLUMN_NAME) REGEXP 'password|totp|cookie|token|privatekey|apikey'
  `);
  assert.equal(publicRows[0]?.secretColumns ?? 0n, 0n);

  console.log(JSON.stringify({
    ok: true,
    implementationPlans: implementationPlans.map(({ kind, status }) => ({ kind, status })),
    contractIssue: { number: applied.issueNumber, status: "ISSUE_OPEN" },
    githubMutation: "fake-adapter-only",
    productionProviderWrite: false,
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
