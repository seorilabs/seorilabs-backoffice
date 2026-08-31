import assert from "node:assert/strict";

import {
  activateConfigRevision,
  assertResolvableConfigRevision,
  autoRebaseCurrentActiveConfigSource,
  createConfigRevision,
  recordDiscoveryObservation,
} from "@/lib/control-plane/service";
import { REPOSITORY_DISCOVERY_CONTRACT_VERSION } from "@/lib/control-plane/repository-discovery";
import { runDesiredStateDraftBackfill } from "@/lib/control-plane/desired-state-backfill";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("config source auto rebase fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("config source auto rebase fixture DB 이름은 _contract_test로 끝나야 한다");
}

const SIGNING_KEY = "config-source-auto-rebase-integration-signing-key";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function discoveryPayload(input: {
  repoId: bigint;
  repoFullName: string;
  sourceSha: string;
}) {
  return {
    schemaVersion: 2,
    contractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
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

function configPayload(complianceDraft = true) {
  return {
    schemaVersion: 1,
    markets: [{
      market: "google-play" as const,
      enabled: true,
      locales: ["ko-KR"],
      releaseChannel: "internal" as const,
    }],
    complianceDrafts: [{
      market: "google-play" as const,
      declaration: "data-safety" as const,
      state: "DRAFT" as const,
      draft: complianceDraft,
    }],
  };
}

async function createFixture(input: {
  suffix: string;
  repoId: bigint;
  observedAt: Date;
}) {
  const appId = `config-source-auto-${input.suffix}`;
  const repoFullName = `seorilabs/config-source-auto-${input.suffix}`;
  await prisma.app.create({
    data: {
      id: appId,
      slug: appId,
      displayName: `Config Source Auto ${input.suffix}`,
      repoFullName,
      repoId: input.repoId,
      type: "APP",
      engine: "RN",
      marketTargets: ["play"],
    },
  });
  await prisma.repositoryRegistration.create({
    data: {
      repoId: input.repoId,
      repoFullName,
      defaultBranch: "main",
      status: "MANAGED",
      managementKind: "APP",
      classification: "PRODUCT_APP",
      discoveryContractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
      lastDefaultPushSha: SHA_A,
      lastReconciledSha: SHA_A,
    },
  });
  await observeSource({
    appId,
    repoId: input.repoId,
    repoFullName,
    sourceSha: SHA_A,
    observedAt: input.observedAt,
    markets: ["google-play"],
  });
  const draft = await createConfigRevision({
    repoId: input.repoId,
    expectedLatestRevision: 0,
    payload: configPayload(),
    actor: "integration-human",
    idempotencyKey: `config-source-auto-${input.suffix}-config-a`,
  });
  await activateConfigRevision({
    repoId: input.repoId,
    revision: draft.revision.revision,
    expectedActiveRevision: 0,
    actor: "integration-human",
    idempotencyKey: `config-source-auto-${input.suffix}-activate-a`,
    signingKey: SIGNING_KEY,
  });
  return { appId, repoFullName, repoId: input.repoId };
}

async function observeSource(input: {
  appId: string;
  repoId: bigint;
  repoFullName: string;
  sourceSha: string;
  observedAt: Date;
  markets: Array<"google-play" | "app-store">;
}) {
  await prisma.repositoryRegistration.update({
    where: { repoId: input.repoId },
    data: {
      lastDefaultPushSha: input.sourceSha,
      lastReconciledSha: input.sourceSha,
      discoveryContractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
    },
  });
  return recordDiscoveryObservation({
    repoId: input.repoId,
    sourceSha: input.sourceSha,
    sourceRef: "refs/heads/main",
    observedAt: input.observedAt,
    observedBy: "integration-worker",
    idempotencyKey: `config-source-auto-${input.appId}-${input.sourceSha}`,
    workflowCaller: { profile: "react-native", packageManager: "pnpm", workingDirectory: "." },
    payload: discoveryPayload({
      repoId: input.repoId,
      repoFullName: input.repoFullName,
      sourceSha: input.sourceSha,
    }),
    buildTargets: input.markets.map((market) => ({
      targetKey: market,
      stack: "react-native",
      market,
      packageId: market === "google-play" ? `com.seorilabs.${input.appId}` : null,
      bundleId: market === "app-store" ? `com.seorilabs.${input.appId}` : null,
    })),
  });
}

async function main() {
  const observedAt = new Date(Date.now() - 60_000);
  const safe = await createFixture({ suffix: "safe", repoId: 9_000_000_091n, observedAt });
  await observeSource({
    ...safe,
    sourceSha: SHA_B,
    observedAt: new Date(observedAt.getTime() + 1_000),
    markets: ["google-play"],
  });
  const providerCountsBefore = await Promise.all([
    prisma.providerObservation.count({ where: { appId: safe.appId } }),
    prisma.providerExecution.count({ where: { appId: safe.appId } }),
    prisma.releaseCandidate.count({ where: { appId: safe.appId } }),
  ]);
  const concurrent = await Promise.all([
    autoRebaseCurrentActiveConfigSource({
      repoId: safe.repoId,
      actor: "scheduler:desired-state-backfill",
      signingKey: SIGNING_KEY,
    }),
    autoRebaseCurrentActiveConfigSource({
      repoId: safe.repoId,
      actor: "scheduler:desired-state-backfill",
      signingKey: SIGNING_KEY,
    }),
  ]);
  assert.equal(
    concurrent.filter((result) => result.outcome === "SOURCE_REBASED_AND_ACTIVATED").length,
    1,
  );
  assert.equal(concurrent.filter((result) => result.outcome === "ALREADY_CURRENT").length, 1);
  const revisions = await prisma.configRevision.findMany({
    where: { appId: safe.appId },
    orderBy: { revision: "asc" },
    include: { sourceObservation: true },
  });
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0]?.status, "SUPERSEDED");
  assert.equal(revisions[1]?.status, "ACTIVE");
  assert.equal(revisions[1]?.sourceObservation?.sourceSha, SHA_B);
  assert.equal(revisions[1]?.payloadHash, revisions[0]?.payloadHash);
  assert.equal(
    jsonDigest(revisions[1]?.payload as JsonValue),
    jsonDigest(revisions[0]?.payload as JsonValue),
  );
  assertResolvableConfigRevision(revisions[1]!, SIGNING_KEY);
  assert.deepEqual(await Promise.all([
    prisma.providerObservation.count({ where: { appId: safe.appId } }),
    prisma.providerExecution.count({ where: { appId: safe.appId } }),
    prisma.releaseCandidate.count({ where: { appId: safe.appId } }),
  ]), providerCountsBefore);
  assert.equal(await prisma.auditLog.count({
    where: {
      entityId: revisions[1]!.id,
      action: "control-plane.config.source-auto-activated",
    },
  }), 1);
  const replay = await autoRebaseCurrentActiveConfigSource({
    repoId: safe.repoId,
    actor: "scheduler:desired-state-backfill",
    signingKey: SIGNING_KEY,
  });
  assert.equal(replay.outcome, "ALREADY_CURRENT");
  assert.equal(await prisma.configRevision.count({ where: { appId: safe.appId } }), 2);

  await observeSource({
    ...safe,
    sourceSha: SHA_C,
    observedAt: new Date(observedAt.getTime() + 2_000),
    markets: ["google-play"],
  });
  const changedDraft = await createConfigRevision({
    repoId: safe.repoId,
    expectedLatestRevision: 2,
    payload: configPayload(false),
    actor: "integration-human",
    idempotencyKey: "config-source-auto-safe-human-draft-c",
  });
  const changed = await autoRebaseCurrentActiveConfigSource({
    repoId: safe.repoId,
    actor: "scheduler:desired-state-backfill",
    signingKey: SIGNING_KEY,
  });
  assert.equal(changed.outcome, "NEEDS_INPUT");
  if (changed.outcome === "NEEDS_INPUT") assert.equal(changed.reason, "DESIRED_PAYLOAD_CHANGED");
  assert.equal((await prisma.configRevision.findUniqueOrThrow({
    where: { id: changedDraft.revision.id },
  })).status, "DRAFT");
  assert.equal((await prisma.configRevision.findFirstOrThrow({
    where: { appId: safe.appId, status: "ACTIVE" },
  })).revision, 2);
  assert.equal(await prisma.configRevision.count({ where: { appId: safe.appId } }), 3);

  const targetDrift = await createFixture({
    suffix: "target-drift",
    repoId: 9_000_000_092n,
    observedAt: new Date(observedAt.getTime() + 10_000),
  });
  await observeSource({
    ...targetDrift,
    sourceSha: SHA_B,
    observedAt: new Date(observedAt.getTime() + 11_000),
    markets: ["app-store"],
  });
  const targetChanged = await autoRebaseCurrentActiveConfigSource({
    repoId: targetDrift.repoId,
    actor: "scheduler:desired-state-backfill",
    signingKey: SIGNING_KEY,
  });
  assert.equal(targetChanged.outcome, "NEEDS_INPUT");
  if (targetChanged.outcome === "NEEDS_INPUT") {
    assert.equal(targetChanged.reason, "BUILD_TARGET_MARKET_CHANGED");
  }
  assert.equal(await prisma.configRevision.count({ where: { appId: targetDrift.appId } }), 1);

  const invalidSnapshot = await createFixture({
    suffix: "invalid-snapshot",
    repoId: 9_000_000_093n,
    observedAt: new Date(observedAt.getTime() + 20_000),
  });
  await prisma.configRevision.updateMany({
    where: { appId: invalidSnapshot.appId, status: "ACTIVE" },
    data: { snapshotSignature: "0".repeat(64) },
  });
  await observeSource({
    ...invalidSnapshot,
    sourceSha: SHA_B,
    observedAt: new Date(observedAt.getTime() + 21_000),
    markets: ["google-play"],
  });
  const invalid = await autoRebaseCurrentActiveConfigSource({
    repoId: invalidSnapshot.repoId,
    actor: "scheduler:desired-state-backfill",
    signingKey: SIGNING_KEY,
  });
  assert.equal(invalid.outcome, "NEEDS_INPUT");
  if (invalid.outcome === "NEEDS_INPUT") assert.equal(invalid.reason, "ACTIVE_SNAPSHOT_INVALID");
  assert.equal(await prisma.configRevision.count({ where: { appId: invalidSnapshot.appId } }), 1);

  const scheduler = await createFixture({
    suffix: "scheduler",
    repoId: 9_000_000_094n,
    observedAt: new Date(observedAt.getTime() + 30_000),
  });
  await observeSource({
    ...scheduler,
    sourceSha: SHA_B,
    observedAt: new Date(observedAt.getTime() + 31_000),
    markets: ["google-play"],
  });
  const paused = await createFixture({
    suffix: "paused",
    repoId: 9_000_000_095n,
    observedAt: new Date(observedAt.getTime() + 40_000),
  });
  const deprecated = await createFixture({
    suffix: "deprecated",
    repoId: 9_000_000_096n,
    observedAt: new Date(observedAt.getTime() + 50_000),
  });
  const nonProduct = await createFixture({
    suffix: "non-product",
    repoId: 9_000_000_097n,
    observedAt: new Date(observedAt.getTime() + 60_000),
  });
  const archived = await createFixture({
    suffix: "archived",
    repoId: 9_000_000_098n,
    observedAt: new Date(observedAt.getTime() + 70_000),
  });
  await Promise.all([
    prisma.app.update({ where: { id: paused.appId }, data: { status: "PAUSED" } }),
    prisma.app.update({ where: { id: deprecated.appId }, data: { status: "DEPRECATED" } }),
    prisma.app.update({ where: { id: nonProduct.appId }, data: { status: "PAUSED" } }),
    prisma.app.update({ where: { id: archived.appId }, data: { status: "DEPRECATED" } }),
    prisma.repositoryRegistration.update({
      where: { repoId: nonProduct.repoId },
      data: { classification: "INFRA_REPO" },
    }),
    prisma.repositoryRegistration.update({
      where: { repoId: archived.repoId },
      data: { archived: true, status: "ARCHIVED" },
    }),
  ]);
  await Promise.all([
    observeSource({
      ...paused,
      sourceSha: SHA_B,
      observedAt: new Date(observedAt.getTime() + 41_000),
      markets: ["google-play"],
    }),
    observeSource({
      ...deprecated,
      sourceSha: SHA_B,
      observedAt: new Date(observedAt.getTime() + 51_000),
      markets: ["google-play"],
    }),
  ]);
  for (const rejected of [nonProduct, archived]) {
    await assert.rejects(
      autoRebaseCurrentActiveConfigSource({
        repoId: rejected.repoId,
        actor: "scheduler:desired-state-backfill",
        signingKey: SIGNING_KEY,
      }),
      (error) => error instanceof Error
        && "code" in error
        && error.code === "CONFIG_SOURCE_NOT_CURRENT",
    );
    assert.equal(await prisma.configRevision.count({ where: { appId: rejected.appId } }), 1);
  }
  const run = await runDesiredStateDraftBackfill({
    actor: "scheduler:desired-state-backfill",
    idempotencyKey: "desired-state-safe-source-rebase:integration:1",
    trigger: "CONTROL_PLANE_API",
    sourceSha: null,
  }, { signingKey: SIGNING_KEY });
  assert.equal(run.failed, 0);
  assert.equal(run.sourceRebasedAndActivated, 3);
  assert.equal(run.activationAttempted, true);
  assert.equal(run.providerMutationAttempted, false);
  assert.equal(run.items.find((item) => item.appId === scheduler.appId)?.outcome,
    "SOURCE_REBASED_AND_ACTIVATED");
  assert.equal(run.items.find((item) => item.appId === paused.appId)?.outcome,
    "SOURCE_REBASED_AND_ACTIVATED");
  assert.equal(run.items.find((item) => item.appId === deprecated.appId)?.outcome,
    "SOURCE_REBASED_AND_ACTIVATED");
  assert.equal(run.items.some((item) => item.appId === nonProduct.appId), false);
  assert.equal(run.items.some((item) => item.appId === archived.appId), false);
  assert.equal((await prisma.configRevision.findFirstOrThrow({
    where: { appId: scheduler.appId, status: "ACTIVE" },
  })).revision, 2);
  for (const lifecycleApp of [paused, deprecated]) {
    const active = await prisma.configRevision.findFirstOrThrow({
      where: { appId: lifecycleApp.appId, status: "ACTIVE" },
      include: { sourceObservation: true },
    });
    assert.equal(active.revision, 2);
    assert.equal(active.sourceObservation?.sourceSha, SHA_B);
  }

  console.log(JSON.stringify({
    ok: true,
    sourceOnlyActivated: 3,
    duplicateRevisionCreated: 0,
    desiredPayloadChangeActivated: false,
    buildTargetChangeActivated: false,
    invalidSnapshotActivated: false,
    pausedAndDeprecatedProductCohort: true,
    providerMutationAttempted: false,
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
