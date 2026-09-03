import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";

import { recordFleetParityImport } from "@/lib/control-plane/fleet-parity-import";
import { jsonDigest } from "@/lib/control-plane/json";
import { recordLegacyShadowImport } from "@/lib/control-plane/legacy-shadow-service";
import { LEGACY_SOURCE_DEFINITIONS } from "@/lib/control-plane/legacy-sources";
import { REPOSITORY_DISCOVERY_CONTRACT_VERSION } from "@/lib/control-plane/repository-discovery";
import {
  activateConfigRevision,
  ControlPlaneError,
  createConfigRevision,
  recordDiscoveryObservation,
} from "@/lib/control-plane/service";
import type { Octokit } from "@/lib/github/app";
import { prisma } from "@/lib/prisma";

const fixture = randomUUID();
const appId = `fleet-parity-import-${fixture}`;
const repoId = BigInt(8_100_000_000 + randomInt(1_000_000) * 2);
const platformRepoId = repoId + 1n;
const repoFullName = `seorilabs/fleet-parity-import-${fixture}`;
const sourceSha = "a".repeat(40);
const platformSha = "b".repeat(40);
const actor = "integration:fleet-parity";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)
  || !databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("fleet parity import fixture는 loopback _contract_test MySQL에서만 허용한다");
}

async function main() {
  const previousPlatformRepoId = process.env.PLATFORM_GITHUB_REPOSITORY_ID;
  process.env.PLATFORM_GITHUB_REPOSITORY_ID = platformRepoId.toString();
  let contentReads = 0;
  let denyGooglePlay = false;
  let observationTime = Date.parse("2026-09-02T00:00:00.000Z");
  const fakeOctokit = {
    rest: {
      repos: {
        async get(input: { owner: string; repo: string }) {
          const fullName = `${input.owner}/${input.repo}`;
          assert.ok(fullName === repoFullName || fullName === "seorilabs/platform");
          return { data: {
            id: Number(fullName === repoFullName ? repoId : platformRepoId),
            full_name: fullName,
            default_branch: "main",
          } };
        },
        async getCommit(input: { repo: string; ref: string }) {
          return { data: { sha: input.ref === "main"
            ? input.repo === "platform" ? platformSha : sourceSha
            : input.ref } };
        },
        async getContent(input: { path: string }) {
          contentReads += 1;
          const denied = denyGooglePlay && input.path === "play-store/google-play.config.json";
          throw Object.assign(new Error("fixture source response"), { status: denied ? 403 : 404 });
        },
      },
    },
  } as unknown as Octokit;
  const dependencies = {
    recordImport: (input: Parameters<typeof recordLegacyShadowImport>[0]) => recordLegacyShadowImport(input, {
      client: prisma,
      getOctokit: async () => fakeOctokit,
      now: () => new Date(observationTime += 1_000),
    }),
  };
  const input = (name: string) => ({
    repoId,
    sourceSha,
    observedBy: actor,
    idempotencyKey: `fleet-parity-integration:${fixture}:${name}`,
  });
  async function activateFixture(occurrence: number) {
    return prisma.$transaction(async (tx) => {
      const latest = await tx.configRevision.findFirst({
        where: { appId },
        orderBy: { revision: "desc" },
        select: { revision: true },
      });
      const revision = (latest?.revision ?? 0) + 1;
      await tx.configRevision.updateMany({
        where: { appId, status: "ACTIVE" },
        data: { status: "SUPERSEDED", activeSlot: null },
      });
      const payload = { schemaVersion: 1, markets: [] };
      return tx.configRevision.create({
        data: {
          appId,
          revision,
          status: "ACTIVE",
          activeSlot: appId,
          payload,
          payloadHash: jsonDigest(payload),
          createdBy: "integration-human",
          idempotencyKey: `fleet-parity-config:${fixture}:${occurrence}`,
        },
      });
    });
  }

  try {
    await prisma.app.create({
      data: {
        id: appId,
        slug: `fleet-parity-import-${fixture}`,
        displayName: "Fleet Parity Import Integration",
        repoFullName,
        repoId,
        type: "APP",
        engine: "RN",
        marketTargets: [],
      },
    });
    await prisma.repositoryRegistration.create({
      data: {
        repoId,
        repoFullName,
        defaultBranch: "main",
        status: "MANAGED",
        managementKind: "APP",
        classification: "PRODUCT_APP",
        discoveryContractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
        lastDefaultPushSha: sourceSha,
        lastReconciledSha: sourceSha,
      },
    });
    await recordDiscoveryObservation({
      repoId,
      sourceSha,
      sourceRef: "refs/heads/main",
      observedAt: new Date(observationTime),
      observedBy: actor,
      idempotencyKey: `fleet-parity-discovery:${fixture}`,
      workflowCaller: { profile: "react-native", packageManager: "pnpm", workingDirectory: "." },
      payload: {
        schemaVersion: 2,
        contractVersion: REPOSITORY_DISCOVERY_CONTRACT_VERSION,
        repository: {
          id: Number(repoId),
          fullName: repoFullName,
          sourceSha,
          sourceRef: "refs/heads/main",
        },
        status: "ACTIVE",
        classification: "PRODUCT_APP",
      },
      buildTargets: [],
    });
    await prisma.platformFleetBinding.create({
      data: { appId, state: "MANAGED", sourceSha: platformSha },
    });
    const firstConfig = await activateFixture(1);
    const first = await recordFleetParityImport(input("first"), dependencies);
    assert.equal(first.parity?.status, "MATCH");
    assert.equal(first.parity?.configRevisionId, firstConfig.id);
    assert.equal(first.sourceCount, LEGACY_SOURCE_DEFINITIONS.length);
    assert.equal(contentReads, LEGACY_SOURCE_DEFINITIONS.length * 2);
    assert.ok(first.import.sources.every((source) => (
      source.status === "ABSENT" && source.errorCode === "PATH_NOT_FOUND"
    )));
    assert.doesNotThrow(() => JSON.stringify(first));
    let resolutions = await prisma.legacyConfigResolution.findMany({ where: { appId }, orderBy: { revision: "asc" } });
    assert.equal(resolutions.length, 1);
    assert.equal(resolutions[0].approvalKind, "AUTOMATION");
    assert.equal(resolutions[0].justification, "NO_LEGACY_DESIRED_STATE");
    assert.equal(first.parity?.legacyConfigResolutionId, resolutions[0].id);
    const configRevisionCountAfterFirst = await prisma.configRevision.count({ where: { appId } });
    const initialObservation = await prisma.legacyConfigImport.findUniqueOrThrow({
      where: { id: resolutions[0].sourceImportId },
      include: { parityObservations: true },
    });
    assert.notEqual(initialObservation.id, first.import.id);
    assert.equal(initialObservation.parityObservations[0]?.status, "NEEDS_INPUT");
    assert.equal(await prisma.legacyConfigImport.count({ where: { appId } }), 2);

    const readsBeforeReplay = contentReads;
    const replay = await recordFleetParityImport(input("first"), dependencies);
    assert.equal(replay.import.id, first.import.id);
    assert.equal(replay.parity?.id, first.parity?.id);
    assert.equal(contentReads, readsBeforeReplay);
    assert.equal(await prisma.legacyConfigResolution.count({ where: { appId } }), 1);

    const next = await recordFleetParityImport(input("next-wave"), dependencies);
    assert.equal(next.parity?.status, "MATCH");
    assert.notEqual(next.import.id, first.import.id);
    assert.equal(await prisma.legacyConfigImport.count({ where: { appId } }), 3);
    assert.equal(await prisma.legacyConfigResolution.count({ where: { appId } }), 1);
    assert.equal(
      await prisma.configRevision.count({ where: { appId } }),
      configRevisionCountAfterFirst,
      "exact resolution이 있으면 후속 shadow 관측이 legacy DRAFT를 추가하지 않아야 한다",
    );

    // 실제 반복 작업 원인: source는 같아도 ACTIVE 설정 revision이 바뀌면 다시 exact 결합한다.
    const secondConfig = await activateFixture(2);
    const changedConfig = await recordFleetParityImport(input("changed-config"), dependencies);
    assert.equal(changedConfig.parity?.status, "MATCH");
    assert.equal(changedConfig.parity?.configRevisionId, secondConfig.id);
    resolutions = await prisma.legacyConfigResolution.findMany({ where: { appId }, orderBy: { revision: "asc" } });
    assert.equal(resolutions.length, 2);
    assert.equal(resolutions[1].revision, 2);
    assert.equal(resolutions[1].configRevisionId, secondConfig.id);
    assert.notEqual(changedConfig.parity?.legacyConfigResolutionId, first.parity?.legacyConfigResolutionId);

    denyGooglePlay = true;
    const inaccessible = await recordFleetParityImport(input("access-denied"), dependencies);
    assert.equal(inaccessible.parity?.status, "NEEDS_INPUT");
    assert.ok(inaccessible.import.sources.some((source) => source.status === "ACCESS_DENIED"));
    assert.equal(await prisma.legacyConfigResolution.count({ where: { appId } }), 2);
    denyGooglePlay = false;

    const latestRevision = await prisma.configRevision.aggregate({
      where: { appId },
      _max: { revision: true },
    });
    const nextRevision = latestRevision._max.revision ?? 0;
    const payload = { schemaVersion: 1, markets: [] };
    const legacyDraft = await prisma.configRevision.create({
      data: {
        appId,
        revision: nextRevision + 1,
        status: "DRAFT",
        payload,
        payloadHash: jsonDigest(payload),
        createdBy: actor,
        idempotencyKey: `legacy-shadow-draft:${fixture}:cleanup-contract`,
      },
    });
    const complianceCreateKey = `ui-compliance-batch-create:${fixture}`;
    const complianceDraft = (await createConfigRevision({
      repoId,
      expectedLatestRevision: legacyDraft.revision,
      expectedSourceSha: sourceSha,
      payload,
      actor,
      idempotencyKey: complianceCreateKey,
      draftIsolationAfterRevision: secondConfig.revision,
    })).revision;
    const humanDraft = await prisma.configRevision.create({
      data: {
        appId,
        revision: nextRevision + 3,
        status: "DRAFT",
        payload,
        payloadHash: jsonDigest(payload),
        createdBy: actor,
        idempotencyKey: `human-draft:${fixture}:preserve`,
      },
    });
    const laterLegacyDraft = await prisma.configRevision.create({
      data: {
        appId,
        revision: nextRevision + 4,
        status: "DRAFT",
        payload,
        payloadHash: jsonDigest(payload),
        createdBy: actor,
        idempotencyKey: `legacy-shadow-draft:${fixture}:after-activation-failure`,
      },
    });
    const legacyDraftCountBeforeActivation = await prisma.configRevision.count({
      where: {
        appId,
        status: "DRAFT",
        idempotencyKey: { startsWith: "legacy-shadow-draft:" },
      },
    });
    const activationInput = {
      repoId,
      revision: complianceDraft.revision,
      expectedActiveRevision: secondConfig.revision,
      actor,
      idempotencyKey: `ui-compliance-batch-activate:${fixture}`,
      signingKey: "integration-signing-key",
      complianceDraftGuard: {
        createIdempotencyKey: complianceCreateKey,
        afterRevision: secondConfig.revision,
      },
    };
    await assert.rejects(activateConfigRevision(activationInput), (error: unknown) => (
      error instanceof ControlPlaneError && error.code === "LATEST_DRAFT_EXISTS"
    ));
    assert.equal((await prisma.configRevision.findUniqueOrThrow({
      where: { id: humanDraft.id },
      select: { status: true },
    })).status, "DRAFT");
    await prisma.configRevision.update({
      where: { id: humanDraft.id },
      data: { status: "SUPERSEDED", supersededAt: new Date() },
    });
    const activatedCompliance = await activateConfigRevision(activationInput);
    assert.equal(activatedCompliance.revision.status, "ACTIVE");
    const draftStates = await prisma.configRevision.findMany({
      where: { id: { in: [legacyDraft.id, humanDraft.id, complianceDraft.id, laterLegacyDraft.id] } },
      orderBy: { revision: "asc" },
      select: { id: true, status: true },
    });
    assert.deepEqual(draftStates, [
      { id: legacyDraft.id, status: "SUPERSEDED" },
      { id: humanDraft.id, status: "SUPERSEDED" },
      { id: complianceDraft.id, status: "ACTIVE" },
      { id: laterLegacyDraft.id, status: "SUPERSEDED" },
    ]);
    assert.equal(await prisma.configRevision.count({
      where: {
        appId,
        status: "DRAFT",
        idempotencyKey: { startsWith: "legacy-shadow-draft:" },
      },
    }), 0);
    const activationAudit = await prisma.auditLog.findFirstOrThrow({
      where: {
        entityType: "ConfigRevision",
        entityId: complianceDraft.id,
        action: "control-plane.config.activate",
      },
      select: { payload: true },
    });
    assert.equal(
      (activationAudit.payload as { supersededLegacyDraftCount?: number }).supersededLegacyDraftCount,
      legacyDraftCountBeforeActivation,
    );

    const spoofLegacyDraft = await prisma.configRevision.create({
      data: {
        appId,
        revision: laterLegacyDraft.revision + 1,
        status: "DRAFT",
        payload,
        payloadHash: jsonDigest(payload),
        createdBy: actor,
        idempotencyKey: `legacy-shadow-draft:${fixture}:spoof-prefix-control`,
      },
    });
    const spoofedPrefixDraft = await prisma.configRevision.create({
      data: {
        appId,
        revision: laterLegacyDraft.revision + 2,
        status: "DRAFT",
        payload,
        payloadHash: jsonDigest(payload),
        createdBy: actor,
        idempotencyKey: `ui-compliance-batch-create:spoof-${fixture}`,
      },
    });
    await activateConfigRevision({
      repoId,
      revision: spoofedPrefixDraft.revision,
      expectedActiveRevision: complianceDraft.revision,
      actor,
      idempotencyKey: `ordinary-prefix-activation:${fixture}`,
      signingKey: "integration-signing-key",
    });
    assert.equal((await prisma.configRevision.findUniqueOrThrow({
      where: { id: spoofLegacyDraft.id },
      select: { status: true },
    })).status, "DRAFT");
    await prisma.configRevision.update({
      where: { id: spoofLegacyDraft.id },
      data: { status: "SUPERSEDED", supersededAt: new Date() },
    });

    await activateFixture(3);
    await prisma.repositoryRegistration.update({
      where: { repoId },
      data: { lastDefaultPushSha: "c".repeat(40) },
    });
    await assert.rejects(recordFleetParityImport(input("source-drift"), dependencies), (error: unknown) => (
      error instanceof ControlPlaneError && error.code === "SOURCE_VECTOR_CHANGED"
    ));
    assert.equal(await prisma.legacyConfigResolution.count({ where: { appId } }), 2);
    assert.equal(await prisma.auditLog.count({
      where: { entityType: "LegacyConfigResolution", entityId: { in: resolutions.map((row) => row.id) } },
    }), 2);
    console.log("fleet parity import integration: exact absence, replay, config rebind, access denial, source drift 통과");
  } finally {
    // append-only 원장은 그대로 두고 후속 계약의 ACTIVE cohort에서만 제외한다.
    await prisma.configRevision.updateMany({
      where: { appId, status: "ACTIVE" },
      data: { status: "SUPERSEDED", activeSlot: null },
    });
    await prisma.app.updateMany({ where: { id: appId }, data: { status: "PAUSED" } });
    await prisma.repositoryRegistration.updateMany({
      where: { repoId },
      data: { status: "ARCHIVED", archived: true },
    });
    if (previousPlatformRepoId === undefined) delete process.env.PLATFORM_GITHUB_REPOSITORY_ID;
    else process.env.PLATFORM_GITHUB_REPOSITORY_ID = previousPlatformRepoId;
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("fleet parity import integration 실패:", error instanceof Error ? error.message : "unknown");
  process.exitCode = 1;
});
