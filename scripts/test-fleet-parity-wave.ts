import assert from "node:assert/strict";

import { PrismaClient } from "@prisma/client";

import {
  runFleetParityWave,
  type FleetParityImportResult,
  type FleetParityServiceDependencies,
} from "@/lib/control-plane/fleet-parity-service";
import { FLEET_PARITY_CONTRACT_VERSION, FLEET_PARITY_EXPECTED_SOURCE_COUNT } from "@/lib/control-plane/fleet-parity";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

const APP_ID = "fleet-parity-integration-app";
const UNMANAGED_APP_ID = "fleet-parity-unmanaged-app";
const CONFIG_ID = "fleet-parity-integration-config";
const REPO_ID = 9_999_981n;
const APP_SHA = "7".repeat(40);
const NEXT_SHA = "8".repeat(40);
const DIGEST = "9".repeat(64);

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("fleet parity integration fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("fleet parity integration fixture DB 이름은 _contract_test로 끝나야 한다");
}

async function main(): Promise<void> {
  const client = new PrismaClient();
  let clock = Date.parse("2026-08-28T02:00:00.000Z");
  let parityStatus: "MATCH" | "NEEDS_INPUT" = "MATCH";
  let importCalls = 0;
  let mutateSourceDuringImport = false;

  async function recordImport(input: {
    repoId: bigint;
    sourceSha: string;
    observedBy: string;
    idempotencyKey: string;
  }): Promise<FleetParityImportResult> {
    importCalls += 1;
    const suffix = jsonDigest({ key: input.idempotencyKey } as JsonValue).slice(0, 20);
    const importId = `fleet-import-${suffix}`;
    const parityId = `fleet-parity-${suffix}`;
    const existing = await client.legacyConfigImport.findUnique({ where: { id: importId } });
    if (!existing) {
      await client.legacyConfigImport.create({
        data: {
          id: importId,
          appId: APP_ID,
          sourceSha: input.sourceSha,
          transformVersion: FLEET_PARITY_CONTRACT_VERSION,
          requestHash: jsonDigest({ input: suffix } as JsonValue),
          inputDigest: DIGEST,
          status: parityStatus === "MATCH" ? "DRAFT_CREATED" : "NEEDS_INPUT",
          idempotencyKey: jsonDigest({ importId } as JsonValue),
          observedBy: input.observedBy,
          observedAt: new Date(clock += 1_000),
        },
      });
      await client.shadowParityObservation.create({
        data: {
          id: parityId,
          appId: APP_ID,
          legacyImportId: importId,
          configRevisionId: CONFIG_ID,
          sourceSha: input.sourceSha,
          scope: "FULL",
          contractVersion: FLEET_PARITY_CONTRACT_VERSION,
          status: parityStatus,
          legacyDigest: parityStatus === "MATCH" ? DIGEST : null,
          centralDigest: parityStatus === "MATCH" ? DIGEST : null,
          diff: parityStatus === "MATCH" ? [] : [{ path: "$", code: "TRANSFORM_NEEDS_INPUT" }],
          dedupeKey: jsonDigest({ parityId } as JsonValue),
          observedBy: input.observedBy,
          observedAt: new Date(clock += 1_000),
        },
      });
    }
    if (mutateSourceDuringImport) {
      mutateSourceDuringImport = false;
      await client.repositoryRegistration.update({
        where: { repoId: REPO_ID },
        data: {
          status: "REGISTERED",
          lastDefaultPushSha: "6".repeat(40),
          lastReconciledSha: input.sourceSha,
        },
      });
    }
    const legacyImport = await client.legacyConfigImport.findUniqueOrThrow({
      where: { id: importId },
      include: {
        configRevision: true,
        sources: true,
        parityObservations: { where: { id: parityId } },
      },
    });
    const parity = legacyImport.parityObservations[0];
    return {
      import: {
        ...legacyImport,
        repoId: undefined,
        sources: [],
      },
      configRevision: legacyImport.configRevision,
      parity,
      sourceCount: FLEET_PARITY_EXPECTED_SOURCE_COUNT,
      duplicate: Boolean(existing),
    } as unknown as FleetParityImportResult;
  }

  const dependencies: FleetParityServiceDependencies = {
    client: client as typeof import("@/lib/prisma").prisma,
    recordImport,
    now: () => new Date(clock += 1_000),
  };

  async function discovery(sourceSha: string, suffix: string): Promise<void> {
    await client.discoveryObservation.create({
      data: {
        appId: APP_ID,
        sourceSha,
        payload: {},
        payloadHash: jsonDigest({}),
        requestHash: jsonDigest({ suffix } as JsonValue),
        idempotencyKey: `fleet-parity-discovery-${suffix}`,
        observedBy: "integration-worker",
        observedAt: new Date(clock += 1_000),
      },
    });
    await client.repositoryRegistration.update({
      where: { repoId: REPO_ID },
      data: {
        status: "MANAGED",
        managementKind: "APP",
        lastDefaultPushSha: sourceSha,
        lastReconciledSha: sourceSha,
      },
    });
  }

  async function cleanup(): Promise<void> {
    const fixtureWaves = await client.fleetParityWave.findMany({
      where: { observedBy: "integration-worker" },
      select: { id: true },
    });
    await client.fleetParityWaveResult.deleteMany({
      where: { waveId: { in: fixtureWaves.map((wave) => wave.id) } },
    });
    await client.fleetParityWave.deleteMany({
      where: { observedBy: "integration-worker" },
    });
    await client.shadowParityObservation.deleteMany({ where: { appId: APP_ID } });
    await client.legacyConfigImport.deleteMany({ where: { appId: APP_ID } });
    await client.repositoryRegistration.deleteMany({ where: { repoId: REPO_ID } });
    await client.app.deleteMany({ where: { id: { in: [APP_ID, UNMANAGED_APP_ID] } } });
    await client.auditLog.deleteMany({
      where: { entityType: "FleetParityWave", actorLogin: "integration-worker" },
    });
  }

  await cleanup();
  try {
    const payload = { schemaVersion: 1, markets: [] };
    await client.app.create({
      data: {
        id: APP_ID,
        slug: "fleet-parity-integration",
        displayName: "Fleet Parity Integration",
        repoFullName: "seorilabs/fleet-parity-integration",
        repoId: REPO_ID,
        type: "APP",
        engine: "RN",
        status: "ACTIVE",
        marketTargets: [],
      },
    });
    await client.app.create({
      data: {
        id: UNMANAGED_APP_ID,
        slug: "fleet-parity-unmanaged",
        displayName: "Fleet Parity Unmanaged",
        repoFullName: "seorilabs/fleet-parity-unmanaged",
        repoId: REPO_ID + 1n,
        type: "APP",
        engine: "RN",
        status: "ACTIVE",
        marketTargets: [],
      },
    });
    await client.repositoryRegistration.create({
      data: {
        repoId: REPO_ID,
        repoFullName: "seorilabs/fleet-parity-integration",
        defaultBranch: "main",
        status: "MANAGED",
        managementKind: "APP",
      },
    });
    await discovery(APP_SHA, "first");
    await client.configRevision.create({
      data: {
        id: CONFIG_ID,
        appId: APP_ID,
        revision: 1,
        status: "ACTIVE",
        activeSlot: APP_ID,
        payload,
        payloadHash: jsonDigest(payload as JsonValue),
        createdBy: "integration-human",
        idempotencyKey: "fleet-parity-integration-config",
      },
    });

    const first = await runFleetParityWave({
      observedBy: "integration-worker",
      idempotencyKey: "fleet-parity-wave-first",
    }, dependencies);
    assert.equal(first.duplicate, false);
    assert.equal(first.wave.status, "PASSED");
    assert.equal(first.wave.resultCount, 1);
    assert.equal(first.wave.matchCount, 1);
    assert.equal(first.wave.consecutiveMatchCount, 1);
    assert.equal(first.wave.cleanupAllowed, false);

    const callsBeforeReplay = importCalls;
    const replay = await runFleetParityWave({
      observedBy: "integration-worker",
      idempotencyKey: "fleet-parity-wave-first",
    }, dependencies);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.wave.id, first.wave.id);
    assert.equal(replay.wave.consecutiveMatchCount, 1);
    assert.equal(importCalls, callsBeforeReplay);

    const second = await runFleetParityWave({
      observedBy: "integration-worker",
      idempotencyKey: "fleet-parity-wave-second",
    }, dependencies);
    assert.equal(second.wave.status, "PASSED");
    assert.equal(second.wave.consecutiveMatchCount, 2);
    assert.equal(second.wave.cleanupAllowed, true);

    await client.repositoryRegistration.update({
      where: { repoId: REPO_ID },
      data: {
        status: "REGISTERED",
        lastDefaultPushSha: NEXT_SHA,
        lastReconciledSha: APP_SHA,
      },
    });
    const pendingDiscovery = await runFleetParityWave({
      observedBy: "integration-worker",
      idempotencyKey: "fleet-parity-wave-pending-discovery",
    }, dependencies);
    assert.equal(pendingDiscovery.wave.status, "BLOCKED");
    assert.equal(pendingDiscovery.wave.results[0].status, "ERROR");
    assert.equal(pendingDiscovery.wave.results[0].reasonCode, "REPOSITORY_NOT_MANAGED");
    assert.equal(pendingDiscovery.wave.consecutiveMatchCount, 0);
    assert.equal(pendingDiscovery.wave.cleanupAllowed, false);

    await discovery(NEXT_SHA, "next");
    const changedVector = await runFleetParityWave({
      observedBy: "integration-worker",
      idempotencyKey: "fleet-parity-wave-changed-vector",
    }, dependencies);
    assert.equal(changedVector.wave.status, "PASSED");
    assert.equal(changedVector.wave.consecutiveMatchCount, 1);
    assert.equal(changedVector.wave.cleanupAllowed, false);

    mutateSourceDuringImport = true;
    const racedSource = await runFleetParityWave({
      observedBy: "integration-worker",
      idempotencyKey: "fleet-parity-wave-source-race",
    }, dependencies);
    assert.equal(racedSource.wave.status, "BLOCKED");
    assert.equal(racedSource.wave.results[0].status, "ERROR");
    assert.equal(racedSource.wave.results[0].reasonCode, "SOURCE_VECTOR_CHANGED");
    assert.equal(racedSource.wave.cleanupAllowed, false);
    await discovery(NEXT_SHA, "source-race-restored");

    parityStatus = "NEEDS_INPUT";
    const blocked = await runFleetParityWave({
      observedBy: "integration-worker",
      idempotencyKey: "fleet-parity-wave-needs-input",
    }, dependencies);
    assert.equal(blocked.wave.status, "BLOCKED");
    assert.equal(blocked.wave.results[0].status, "NEEDS_INPUT");
    assert.equal(blocked.wave.results[0].reasonCode, "TRANSFORM_NEEDS_INPUT");
    assert.equal(blocked.wave.consecutiveMatchCount, 0);
    assert.equal(blocked.wave.cleanupAllowed, false);
    assert.doesNotThrow(() => JSON.stringify(blocked));
    assert.equal("requestHash" in blocked.wave, false);
  } finally {
    await cleanup();
    await client.$disconnect();
  }
  console.log("fleet parity wave integration 계약 통과");
}

main().catch((error: unknown) => {
  console.error("fleet parity wave integration 실패:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
