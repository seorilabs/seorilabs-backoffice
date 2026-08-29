import assert from "node:assert/strict";
import crypto from "node:crypto";

import { Prisma } from "@prisma/client";

import {
  PLATFORM_AFFECTED_CONSUMERS,
  platformFleetTaskInputSchema,
  type PlatformReleaseManifest,
} from "@/lib/control-plane/contracts";
import { jsonDigest, signSnapshot, type JsonValue } from "@/lib/control-plane/json";
import {
  applyPlatformContractIssuePlan,
  applyPlatformRemediationIssuePlan,
  reconcilePlatformFleet,
  recordPlatformRelease,
  type PlatformGithubIssue,
  type TrustedPlatformGithubAdapter,
} from "@/lib/control-plane/platform-fleet";
import { loadExactManagedPlatformConsumers } from "@/lib/control-plane/platform-fleet-cohort";
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
const repoIdC = repoIdA + 2n;
const sourceShaA = "1".repeat(40);
const sourceShaB = "2".repeat(40);
const sourceShaC = "5".repeat(40);
const releaseSourceSha = "3".repeat(40);
const artifactDigest = "a".repeat(64);
const oldArtifactDigest = "b".repeat(64);
const contractRevision = "c".repeat(64);
const oldContractRevision = "d".repeat(64);
const signingKey = "platform-fleet-integration-signing-key";
const repoFullNameA = `seorilabs/platform-fleet-a-${nonce}`;
const repoFullNameB = `seorilabs/platform-fleet-b-${nonce}`;
const repoFullNameC = `seorilabs/platform-fleet-c-${nonce}`;
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
    affectedConsumers: PLATFORM_AFFECTED_CONSUMERS,
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
  status: "ACTIVE" | "PAUSED" | "DEPRECATED";
  platformConsumer: Record<string, unknown>;
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
      status: input.status,
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
      classification: "PRODUCT_APP",
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
    payload: {
      stack: "react-native",
      fixture: "platform-fleet",
      platformConsumer: input.platformConsumer,
    },
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
  // 같은 disposable contract DB에서 먼저 실행된 fixture의 분류는 이 테스트 cohort와 격리한다.
  await prisma.repositoryRegistration.updateMany({
    where: { classification: "PRODUCT_APP" },
    data: { classification: "EXCLUDED" },
  });
  const appIdA = `platform-fleet-a-${nonce}`;
  const appIdB = `platform-fleet-b-${nonce}`;
  const appIdC = `platform-fleet-c-${nonce}`;
  const sdkDiscoveryPayload = {
    schemaVersion: 1,
    sourceSha: sourceShaA,
    integration: "SDK",
    artifactKind: "TYPESCRIPT",
    observedVersion: "0.9.0",
    observedDigest: oldArtifactDigest,
    contractRevision: oldContractRevision,
  } as const;
  const customDiscoveryPayload = {
    schemaVersion: 1,
    sourceSha: sourceShaB,
    integration: "CUSTOM_HTTP",
    evidenceDigest: oldArtifactDigest,
  } as const;
  const missingDiscoveryPayload = {
    schemaVersion: 1,
    sourceSha: sourceShaC,
    integration: "MISSING",
    evidenceDigest: oldArtifactDigest,
  } as const;
  const [discoveryA, discoveryB, discoveryC] = await Promise.all([
    addApp({
      id: appIdA,
      slug: appIdA,
      repoId: repoIdA,
      repoFullName: repoFullNameA,
      sourceSha: sourceShaA,
      status: "ACTIVE",
      platformConsumer: sdkDiscoveryPayload,
    }),
    addApp({
      id: appIdB,
      slug: appIdB,
      repoId: repoIdB,
      repoFullName: repoFullNameB,
      sourceSha: sourceShaB,
      status: "PAUSED",
      platformConsumer: customDiscoveryPayload,
    }),
    addApp({
      id: appIdC,
      slug: appIdC,
      repoId: repoIdC,
      repoFullName: repoFullNameC,
      sourceSha: sourceShaC,
      status: "DEPRECATED",
      platformConsumer: missingDiscoveryPayload,
    }),
  ]);
  const [sdkObservationA, customObservationB, missingObservationC] = await Promise.all([
    addPlatformObservation({
      repoId: repoIdA,
      sourceSha: sourceShaA,
      suffix: "implementation-sdk",
      payload: sdkDiscoveryPayload,
    }),
    addPlatformObservation({
      repoId: repoIdB,
      sourceSha: sourceShaB,
      suffix: "custom-http",
      payload: customDiscoveryPayload,
    }),
    addPlatformObservation({
      repoId: repoIdC,
      sourceSha: sourceShaC,
      suffix: "missing",
      payload: missingDiscoveryPayload,
    }),
  ]);

  const excludedRegistrations = [
    { suffix: "legacy", classification: null, archived: false, status: "MANAGED", managementKind: "APP" },
    { suffix: "infra", classification: "INFRA_REPO", archived: false, status: "MANAGED", managementKind: "UNCLASSIFIED" },
    { suffix: "producer", classification: "PLATFORM_PRODUCER", archived: false, status: "MANAGED", managementKind: "PLATFORM_PRODUCER" },
    { suffix: "excluded", classification: "EXCLUDED", archived: false, status: "MANAGED", managementKind: "UNCLASSIFIED" },
    { suffix: "archived", classification: "PRODUCT_APP", archived: true, status: "ARCHIVED", managementKind: "APP" },
  ] as const;
  for (const [index, excluded] of excludedRegistrations.entries()) {
    const repoId = repoIdC + BigInt(index + 1);
    const id = `platform-fleet-${excluded.suffix}-${nonce}`;
    const repoFullName = `seorilabs/${id}`;
    await prisma.app.create({
      data: {
        id,
        slug: id,
        displayName: id,
        repoId,
        repoFullName,
        type: "APP",
        engine: "RN",
        status: "ACTIVE",
        marketTargets: [],
      },
    });
    await prisma.repositoryRegistration.create({
      data: {
        repoId,
        repoFullName,
        defaultBranch: "main",
        archived: excluded.archived,
        status: excluded.status,
        managementKind: excluded.managementKind,
        classification: excluded.classification,
        lastDefaultPushSha: sourceShaA,
        lastReconciledSha: sourceShaA,
      },
    });
  }
  const exactCohort = await loadExactManagedPlatformConsumers(prisma);
  assert.deepEqual(
    exactCohort.map(({ app }) => ({ repoId: app.repoId, status: app.status })),
    [
      { repoId: repoIdA, status: "ACTIVE" },
      { repoId: repoIdB, status: "PAUSED" },
      { repoId: repoIdC, status: "DEPRECATED" },
    ],
    "producer/reconcile 공용 cohort는 strict PRODUCT_APP만 포함하고 lifecycle 상태로 제외하지 않아야 한다",
  );

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
      {
        repoId: repoIdC.toString(),
        discoveryObservationId: discoveryC.observation.id,
        providerObservationId: missingObservationC.observation.id,
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
  assert.equal(implementationPlans.length, 3);
  const sdkPlan = implementationPlans.find((plan) => plan.appId === appIdA);
  const customPlan = implementationPlans.find((plan) => plan.appId === appIdB);
  const missingPlan = implementationPlans.find((plan) => plan.appId === appIdC);
  if (!sdkPlan || !customPlan || !missingPlan) assert.fail("세 consumer의 Platform plan이 모두 필요합니다.");
  assert.equal(sdkPlan?.kind, "SDK_UPDATE_PR");
  assert.equal(sdkPlan?.status, "QUEUED");
  assert.ok(sdkPlan?.agentRun);
  assert.equal(customPlan?.kind, "CUSTOM_UNMANAGED");
  assert.equal(customPlan?.status, "PENDING");
  assert.equal(customPlan?.agentRunId, null);
  assert.equal(missingPlan?.kind, "MISSING_UNMANAGED");
  assert.equal(missingPlan?.status, "PENDING");
  assert.equal(missingPlan?.agentRunId, null);
  const sdkTask = platformFleetTaskInputSchema.parse(sdkPlan?.agentRun?.taskInput);
  assert.equal(sdkTask.kind, "PLATFORM_SDK_UPDATE");
  if (sdkTask.kind !== "PLATFORM_SDK_UPDATE") assert.fail("SDK update task가 필요합니다.");
  assert.equal(sdkTask.artifact.digest, artifactDigest);
  assert.equal(sdkTask.sourceSha, sourceShaA);
  const customTask = platformFleetTaskInputSchema.parse(customPlan?.desired);
  assert.equal(customTask.kind, "PLATFORM_INTEGRATION_REMEDIATION_ISSUE");
  if (customTask.kind !== "PLATFORM_INTEGRATION_REMEDIATION_ISSUE") assert.fail("custom remediation task가 필요합니다.");
  assert.equal(customTask.integration, "CUSTOM_HTTP");
  assert.equal(customTask.issueMarker, `<!-- seorilabs-platform-remediation:v1:${repoIdB} -->`);
  const missingTask = platformFleetTaskInputSchema.parse(missingPlan?.desired);
  assert.equal(missingTask.kind, "PLATFORM_INTEGRATION_REMEDIATION_ISSUE");
  if (missingTask.kind !== "PLATFORM_INTEGRATION_REMEDIATION_ISSUE") assert.fail("missing remediation task가 필요합니다.");
  assert.equal(missingTask.integration, "MISSING");
  assert.equal(missingTask.issueMarker, `<!-- seorilabs-platform-remediation:v1:${repoIdC} -->`);
  assert.notEqual(customTask.issueMarker, missingTask.issueMarker);
  assert.equal((await reconcilePlatformFleet(implementationInput)).duplicate, true);
  assert.equal(await prisma.platformFleetPlan.count({
    where: { platformReleaseId: implementationRelease.release.id, appId: appIdA },
  }), 1);

  await assert.rejects(
    reconcilePlatformFleet({
      ...implementationInput,
      consumers: [implementationInput.consumers[0]],
      idempotencyKey: `platform-fleet-reconcile:cohort-omission:${nonce}`,
    }),
    (error) => error instanceof ControlPlaneError && error.code === "PLATFORM_CONSUMER_COHORT_MISMATCH",
  );

  const customCalls: string[] = [];
  let customIssue: PlatformGithubIssue = {
    number: 41,
    url: "https://github.com/seorilabs/example/issues/41",
    state: "closed",
    title: "이전 remediation",
    body: `${customTask.issueMarker}\n이전 source`,
    labels: ["no-autopilot"],
  };
  const customAdapter: TrustedPlatformGithubAdapter = {
    async ensureLabels() {
      customCalls.push("ensure-labels");
    },
    async findIssueByMarker() {
      customCalls.push("read-before");
      return { ...customIssue, labels: [...customIssue.labels] };
    },
    async createIssue() {
      throw new Error("stable remediation marker는 중복 Issue를 만들면 안 됩니다.");
    },
    async updateIssue(input) {
      customCalls.push("update-existing");
      customIssue = {
        ...customIssue,
        state: input.state,
        title: input.title,
        body: input.body,
        labels: [...input.labels],
      };
    },
    async readIssue() {
      customCalls.push("read-after");
      return { ...customIssue, labels: [...customIssue.labels] };
    },
    async readPullRequest() {
      throw new Error("unexpected pull request read");
    },
  };
  const customApplied = await applyPlatformRemediationIssuePlan(customPlan.id, customAdapter);
  assert.equal(customApplied.applied, true);
  assert.deepEqual(customCalls, ["ensure-labels", "read-before", "update-existing", "read-after"]);
  assert.equal(customIssue.state, "open");
  assert.ok(customIssue.labels.includes("platform-remediation"));
  assert.ok(customIssue.labels.includes("no-autopilot"), "운영자가 붙인 차단 label을 제거하면 안 된다");
  assert.equal((await prisma.platformFleetPlan.findUniqueOrThrow({ where: { id: customPlan.id } })).status, "ISSUE_OPEN");
  assert.equal(
    (await prisma.platformFleetBinding.findUniqueOrThrow({ where: { appId: appIdB } })).state,
    "CUSTOM_UNMANAGED_REMEDIATION_ISSUE_OPEN",
  );
  assert.equal((await applyPlatformRemediationIssuePlan(customPlan.id, customAdapter)).skipped, true);

  const missingCalls: string[] = [];
  const missingIssue = (): PlatformGithubIssue => ({
    number: 43,
    url: "https://github.com/seorilabs/example/issues/43",
    state: "open",
    title: missingTask.title,
    body: missingTask.body,
    labels: [...missingTask.labels],
  });
  const missingAdapter: TrustedPlatformGithubAdapter = {
    async ensureLabels() {
      missingCalls.push("ensure-labels");
    },
    async findIssueByMarker() {
      missingCalls.push("read-before");
      return null;
    },
    async createIssue() {
      missingCalls.push("create");
      return 43;
    },
    async updateIssue() {
      throw new Error("new remediation Issue는 update할 필요가 없습니다.");
    },
    async readIssue() {
      missingCalls.push("read-after");
      return missingIssue();
    },
    async readPullRequest() {
      throw new Error("unexpected pull request read");
    },
  };
  const missingApplied = await applyPlatformRemediationIssuePlan(missingPlan.id, missingAdapter);
  assert.equal(missingApplied.applied, true);
  assert.deepEqual(missingCalls, ["ensure-labels", "read-before", "create", "read-after"]);
  assert.equal(
    (await prisma.platformFleetBinding.findUniqueOrThrow({ where: { appId: appIdC } })).state,
    "MISSING_UNMANAGED_REMEDIATION_ISSUE_OPEN",
  );

  const normalizedLegacyManifest = releaseManifest({
    version: "0.6.7",
    classification: "IMPLEMENTATION_ONLY",
  });
  const storedLegacyManifest = structuredClone(normalizedLegacyManifest) as unknown as Record<string, unknown>;
  delete storedLegacyManifest.affectedConsumers;
  const storedLegacySignature = signSnapshot(storedLegacyManifest as JsonValue, signingKey);
  const storedLegacyActor = "scheduler:platform-fleet-producer";
  const storedLegacyRequestHash = jsonDigest({
    manifest: storedLegacyManifest,
    manifestDigest: storedLegacySignature.digest,
    signature: storedLegacySignature.signature,
    actor: storedLegacyActor,
  } as JsonValue);
  const storedLegacyIdempotencyKey = `platform-release-producer:${jsonDigest({
    rawManifestSha256: normalizedLegacyManifest.provenance.rawManifestSha256,
    approvalSha256: normalizedLegacyManifest.provenance.approvalSha256,
  } as JsonValue)}`;
  const storedLegacyRelease = await prisma.platformRelease.create({
    data: {
      version: "0.6.7",
      sourceSha: releaseSourceSha,
      classification: "IMPLEMENTATION_ONLY",
      approval: "FLEET_APPROVED",
      contractRevision,
      manifest: storedLegacyManifest as Prisma.InputJsonValue,
      manifestDigest: storedLegacySignature.digest,
      signature: storedLegacySignature.signature,
      publishedAt: new Date(storedLegacyManifest.publishedAt as string),
      observedBy: storedLegacyActor,
      requestHash: storedLegacyRequestHash,
      idempotencyKey: storedLegacyIdempotencyKey,
    },
  });
  const normalizedLegacySignature = signSnapshot(normalizedLegacyManifest as unknown as JsonValue, signingKey);
  const rereadLegacyRelease = await recordPlatformRelease({
    manifest: normalizedLegacyManifest,
    manifestDigest: normalizedLegacySignature.digest,
    signature: normalizedLegacySignature.signature,
    actor: storedLegacyActor,
    idempotencyKey: storedLegacyIdempotencyKey,
    signingKey,
  });
  assert.equal(rereadLegacyRelease.duplicate, true);
  assert.equal(rereadLegacyRelease.release.id, storedLegacyRelease.id);
  for (const incompatibleManifest of [
    {
      ...normalizedLegacyManifest,
      version: "0.6.8",
      provenance: { ...normalizedLegacyManifest.provenance, releaseTag: "v0.6.8" },
    },
    {
      ...normalizedLegacyManifest,
      sourceSha: "4".repeat(40),
    },
    {
      ...normalizedLegacyManifest,
      provenance: { ...normalizedLegacyManifest.provenance, rawManifestSha256: "d".repeat(64) },
    },
    {
      ...normalizedLegacyManifest,
      provenance: { ...normalizedLegacyManifest.provenance, approvalSha256: "c".repeat(64) },
    },
    {
      ...normalizedLegacyManifest,
      classification: "CONTRACT_CHANGE" as const,
    },
  ]) {
    const incompatibleSignature = signSnapshot(incompatibleManifest as unknown as JsonValue, signingKey);
    await assert.rejects(
      recordPlatformRelease({
        manifest: incompatibleManifest,
        manifestDigest: incompatibleSignature.digest,
        signature: incompatibleSignature.signature,
        actor: storedLegacyActor,
        idempotencyKey: storedLegacyIdempotencyKey,
        signingKey,
      }),
      (error) => error instanceof ControlPlaneError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  }
  await assert.rejects(
    recordPlatformRelease({
      manifest: normalizedLegacyManifest,
      manifestDigest: normalizedLegacySignature.digest,
      signature: normalizedLegacySignature.signature,
      actor: "integration:unexpected-platform-producer",
      idempotencyKey: storedLegacyIdempotencyKey,
      signingKey,
    }),
    (error) => error instanceof ControlPlaneError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  const differentKeySignature = signSnapshot(normalizedLegacyManifest as unknown as JsonValue, signingKey);
  await assert.rejects(
    recordPlatformRelease({
      manifest: normalizedLegacyManifest,
      manifestDigest: differentKeySignature.digest,
      signature: differentKeySignature.signature,
      actor: storedLegacyActor,
      idempotencyKey: `platform-release-producer:different-${nonce}`,
      signingKey,
    }),
    (error) => error instanceof ControlPlaneError && error.code === "PLATFORM_RELEASE_CONFLICT",
  );
  const storedLegacyResult = await reconcilePlatformFleet({
    ...implementationInput,
    platformReleaseId: storedLegacyRelease.id,
    idempotencyKey: `platform-fleet-reconcile:legacy-v0.6.7:${nonce}`,
  });
  assert.equal(storedLegacyResult.duplicate, false);
  const storedLegacyReadback = await prisma.platformRelease.findUniqueOrThrow({
    where: { id: storedLegacyRelease.id },
  });
  assert.equal(storedLegacyReadback.manifestDigest, storedLegacySignature.digest);
  assert.equal(storedLegacyReadback.signature, storedLegacySignature.signature);
  assert.equal(storedLegacyReadback.requestHash, storedLegacyRequestHash);
  assert.equal(storedLegacyReadback.idempotencyKey, storedLegacyIdempotencyKey);
  assert.equal(await prisma.platformRelease.count({ where: { version: "0.6.7" } }), 1);
  assert.equal(
    Object.hasOwn(storedLegacyReadback.manifest as Record<string, unknown>, "affectedConsumers"),
    false,
  );

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

  await prisma.repositoryRegistration.updateMany({
    where: { repoId: { in: [repoIdB, repoIdC] } },
    data: { classification: "EXCLUDED" },
  });
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
    state: "open",
    title: issueTask.title,
    body: issueTask.body,
    labels: [...issueTask.labels],
  });
  const adapter: TrustedPlatformGithubAdapter = {
    async ensureLabels() {
      calls.push("ensure-labels");
    },
    async findIssueByMarker() {
      calls.push("read-before");
      return null;
    },
    async createIssue() {
      calls.push("create");
      return 42;
    },
    async updateIssue() {
      throw new Error("contract Issue 기존 동작은 자동 update하지 않습니다.");
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
  assert.deepEqual(calls, ["ensure-labels", "read-before", "create", "read-after"]);
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
    remediationIssues: {
      custom: { number: customApplied.issueNumber, status: "ISSUE_OPEN", reused: true },
      missing: { number: missingApplied.issueNumber, status: "ISSUE_OPEN", reused: false },
    },
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
