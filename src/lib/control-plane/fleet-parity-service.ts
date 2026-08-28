import { Prisma, type FleetParityResultStatus } from "@prisma/client";

import {
  evaluateFleetParityWave,
  FLEET_PARITY_CONTRACT_VERSION,
  FLEET_PARITY_EXPECTED_SOURCE_COUNT,
  FLEET_PARITY_SCOPE,
  fleetParityCohortDigest,
  type FleetParityVectorItem,
} from "@/lib/control-plane/fleet-parity";
import { latestDiscoveryObservationOrder } from "@/lib/control-plane/discovery-order";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { recordLegacyShadowImport } from "@/lib/control-plane/legacy-shadow-service";
import { repositorySourceIsCurrent } from "@/lib/control-plane/repository-registration";
import { assertIdempotentRequestHash, ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

type ImportResult = Awaited<ReturnType<typeof recordLegacyShadowImport>>;
export type FleetParityImportResult = ImportResult;

export type FleetParityServiceDependencies = {
  client: typeof prisma;
  recordImport: (input: {
    repoId: bigint;
    sourceSha: string;
    observedBy: string;
    idempotencyKey: string;
  }) => Promise<ImportResult>;
  now: () => Date;
};

const defaultDependencies: FleetParityServiceDependencies = {
  client: prisma,
  recordImport: (input) => recordLegacyShadowImport(input),
  now: () => new Date(),
};

const waveSelect = {
  id: true,
  occurrenceKey: true,
  requestHash: true,
  scope: true,
  contractVersion: true,
  cohortDigest: true,
  vectorDigest: true,
  evidenceDigest: true,
  status: true,
  resultCount: true,
  matchCount: true,
  consecutiveMatchCount: true,
  cleanupAllowed: true,
  observedBy: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  results: {
    orderBy: [{ repoId: "asc" as const }, { appId: "asc" as const }],
    select: {
      id: true,
      appId: true,
      repoId: true,
      repoFullName: true,
      sourceSha: true,
      configRevisionId: true,
      legacyImportId: true,
      parityObservationId: true,
      scope: true,
      contractVersion: true,
      status: true,
      reasonCode: true,
      legacyDigest: true,
      centralDigest: true,
      sourceCount: true,
      observedAt: true,
      createdAt: true,
    },
  },
} satisfies Prisma.FleetParityWaveSelect;

type SelectedWave = Prisma.FleetParityWaveGetPayload<{ select: typeof waveSelect }>;

function publicWave(wave: SelectedWave) {
  const { requestHash, ...publicValue } = wave;
  void requestHash;
  return {
    ...publicValue,
    results: wave.results.map((result) => ({
      ...result,
      repoId: result.repoId.toString(),
    })),
  };
}

function occurrenceKey(idempotencyKey: string): string {
  return jsonDigest({ scope: "fleet-parity-wave", idempotencyKey } as JsonValue);
}

function requestHash(input: { observedBy: string; idempotencyKey: string }): string {
  return jsonDigest({
    scope: FLEET_PARITY_SCOPE,
    contractVersion: FLEET_PARITY_CONTRACT_VERSION,
    observedBy: input.observedBy,
    idempotencyKey: input.idempotencyKey,
  } as JsonValue);
}

function vectorItem(result: SelectedWave["results"][number]): FleetParityVectorItem {
  return {
    appId: result.appId,
    repoId: result.repoId,
    repoFullName: result.repoFullName,
    sourceSha: result.sourceSha,
    configRevisionId: result.configRevisionId,
    scope: result.scope,
    contractVersion: result.contractVersion,
    status: result.status,
    legacyDigest: result.legacyDigest,
    centralDigest: result.centralDigest,
    sourceCount: result.sourceCount,
    reasonCode: result.reasonCode,
  };
}

function safeFailureCode(error: unknown): string {
  const code = error instanceof ControlPlaneError ? error.code : "SOURCE_READ_UNAVAILABLE";
  const allowed = new Set([
    "APP_NOT_FOUND",
    "REPOSITORY_IDENTITY_INVALID",
    "SOURCE_SHA_NOT_DEFAULT_HEAD",
    "SOURCE_REF_CHANGED_DURING_READ",
    "SOURCE_SHA_CHANGED_DURING_READ",
    "SOURCE_SHA_NOT_CURRENT",
    "SOURCE_VECTOR_CHANGED",
    "SOURCE_READ_UNAVAILABLE",
  ]);
  return allowed.has(code) ? code : "SOURCE_READ_UNAVAILABLE";
}

async function findWave(
  client: typeof prisma,
  key: string,
): Promise<SelectedWave | null> {
  return client.fleetParityWave.findUnique({
    where: { occurrenceKey: key },
    select: waveSelect,
  });
}

async function createWave(input: {
  observedBy: string;
  idempotencyKey: string;
  now: Date;
}, dependencies: FleetParityServiceDependencies): Promise<{ wave: SelectedWave; duplicate: boolean }> {
  const client = dependencies.client;
  const key = occurrenceKey(input.idempotencyKey);
  const hash = requestHash(input);
  const replay = await findWave(client, key);
  if (replay) {
    assertIdempotentRequestHash(replay.requestHash, hash);
    return { wave: replay, duplicate: true };
  }

  const activeApps = await client.app.findMany({
    where: { status: "ACTIVE", repoId: { not: null } },
    orderBy: [{ repoId: "asc" }, { id: "asc" }],
    select: {
      id: true,
      repoId: true,
      repoFullName: true,
      discoveryObservations: {
        orderBy: latestDiscoveryObservationOrder(),
        take: 1,
        select: { sourceSha: true },
      },
      configRevisions: {
        where: { status: "ACTIVE" },
        orderBy: { revision: "desc" },
        take: 1,
        select: { id: true },
      },
    },
  });
  const repoIds = activeApps.flatMap((app) => app.repoId === null ? [] : [app.repoId]);
  const registrations = repoIds.length === 0
    ? []
    : await client.repositoryRegistration.findMany({
        where: { repoId: { in: repoIds } },
        select: {
          repoId: true,
          repoFullName: true,
          status: true,
          archived: true,
          managementKind: true,
          classification: true,
          lastDefaultPushSha: true,
          lastReconciledSha: true,
        },
      });
  const managed = new Map(registrations.map((row) => [row.repoId.toString(), row]));
  const cohort = activeApps.flatMap((app) => {
    if (app.repoId === null) return [];
    const registration = managed.get(app.repoId.toString());
    if (!registration) return [];
    // 명시적으로 non-product로 분류된 저장소는 앱별 legacy JSON consumer가 아니다.
    // 오래된 App seed row가 남아 있어도 parity cohort에 섞지 않는다. 분류가 아직
    // null인 row는 조용히 제외하지 않고 아래 source gate에서 오류로 남긴다.
    if (
      (registration.classification && registration.classification !== "PRODUCT_APP")
      || (!registration.classification && registration.managementKind === "PLATFORM_PRODUCER")
    ) return [];
    const identityMatches = registration.repoFullName.toLowerCase() === app.repoFullName.toLowerCase();
    const sourceSha = app.discoveryObservations[0]?.sourceSha.toLowerCase() ?? null;
    const sourceIsCurrent = repositorySourceIsCurrent(registration, sourceSha);
    const reasonCode = !identityMatches
      ? "COHORT_IDENTITY_MISMATCH"
      : registration.status !== "MANAGED" || registration.archived
        ? "REPOSITORY_NOT_MANAGED"
        : !sourceIsCurrent
          ? "SOURCE_NOT_RECONCILED"
          : null;
    return [{
      appId: app.id,
      repoId: app.repoId,
      repoFullName: app.repoFullName,
      sourceSha,
      configRevisionId: app.configRevisions[0]?.id ?? null,
      scope: FLEET_PARITY_SCOPE,
      contractVersion: FLEET_PARITY_CONTRACT_VERSION,
      status: (reasonCode ? "ERROR" : "PENDING") as FleetParityResultStatus,
      reasonCode,
      legacyDigest: null,
      centralDigest: null,
      sourceCount: 0,
    }];
  }).map((item) => ({
    ...item,
    status: item.reasonCode ? "ERROR" as const : item.status,
  }));
  const digest = fleetParityCohortDigest(cohort);

  try {
    const wave = await client.$transaction(async (tx) => {
      const created = await tx.fleetParityWave.create({
        data: {
          occurrenceKey: key,
          requestHash: hash,
          scope: FLEET_PARITY_SCOPE,
          contractVersion: FLEET_PARITY_CONTRACT_VERSION,
          cohortDigest: digest,
          observedBy: input.observedBy,
          startedAt: input.now,
          results: {
            create: cohort.map((item) => ({
              appId: item.appId,
              repoId: item.repoId,
              repoFullName: item.repoFullName,
              sourceSha: item.sourceSha,
              configRevisionId: item.configRevisionId,
              scope: item.scope,
              contractVersion: item.contractVersion,
              status: item.status,
              reasonCode: item.reasonCode,
              observedAt: item.status === "ERROR" ? input.now : null,
            })),
          },
        },
        select: waveSelect,
      });
      await tx.auditLog.create({
        data: {
          actorLogin: input.observedBy,
          action: "control-plane.fleet-parity.start",
          entityType: "FleetParityWave",
          entityId: created.id,
          payload: {
            scope: FLEET_PARITY_SCOPE,
            contractVersion: FLEET_PARITY_CONTRACT_VERSION,
            cohortDigest: digest,
            resultCount: cohort.length,
          },
        },
      });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { wave, duplicate: false };
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "P2002") {
      const raced = await findWave(client, key);
      if (raced) {
        assertIdempotentRequestHash(raced.requestHash, hash);
        return { wave: raced, duplicate: true };
      }
    }
    throw error;
  }
}

async function frozenVectorStillCurrent(
  result: SelectedWave["results"][number],
  client: Pick<typeof prisma, "app" | "repositoryRegistration">,
): Promise<boolean> {
  const [app, registration] = await Promise.all([
    client.app.findUnique({
      where: { id: result.appId },
      select: {
        status: true,
        repoId: true,
        repoFullName: true,
        discoveryObservations: {
          orderBy: latestDiscoveryObservationOrder(),
          take: 1,
          select: { sourceSha: true },
        },
        configRevisions: {
          where: { status: "ACTIVE" },
          orderBy: { revision: "desc" },
          take: 1,
          select: { id: true },
        },
      },
    }),
    client.repositoryRegistration.findUnique({
      where: { repoId: result.repoId },
      select: {
        status: true,
        archived: true,
        repoFullName: true,
        managementKind: true,
        classification: true,
        lastDefaultPushSha: true,
        lastReconciledSha: true,
      },
    }),
  ]);
  return app?.status === "ACTIVE"
    && app.repoId === result.repoId
    && app.repoFullName.toLowerCase() === result.repoFullName.toLowerCase()
    && app.discoveryObservations[0]?.sourceSha.toLowerCase() === result.sourceSha
    && (app.configRevisions[0]?.id ?? null) === result.configRevisionId
    && registration !== null
    && repositorySourceIsCurrent(registration, result.sourceSha)
    && registration.repoFullName.toLowerCase() === result.repoFullName.toLowerCase();
}

async function processResult(
  wave: SelectedWave,
  result: SelectedWave["results"][number],
  dependencies: FleetParityServiceDependencies,
): Promise<void> {
  if (result.status !== "PENDING") return;
  const client = dependencies.client;
  const observedAt = dependencies.now();
  if (!result.sourceSha) {
    await client.fleetParityWaveResult.updateMany({
      where: { id: result.id, status: "PENDING" },
      data: {
        status: "ERROR",
        reasonCode: "NO_CURRENT_DISCOVERY",
        observedAt,
      },
    });
    return;
  }
  if (!await frozenVectorStillCurrent(result, client)) {
    await client.fleetParityWaveResult.updateMany({
      where: { id: result.id, status: "PENDING" },
      data: { status: "ERROR", reasonCode: "SOURCE_VECTOR_CHANGED", observedAt },
    });
    return;
  }

  try {
    const imported = await dependencies.recordImport({
      repoId: result.repoId,
      sourceSha: result.sourceSha,
      observedBy: wave.observedBy,
      idempotencyKey: `fleet-parity:${wave.id}:${result.id}`,
    });
    const parity = imported.parity;
    if (!parity) {
      throw new ControlPlaneError("parity observation이 없습니다.", 409, "PARITY_OBSERVATION_MISSING");
    }
    const vectorMatches = imported.import.appId === result.appId
      && imported.import.sourceSha === result.sourceSha
      && parity.sourceSha === result.sourceSha
      && parity.configRevisionId === result.configRevisionId
      && parity.scope === FLEET_PARITY_SCOPE
      && parity.contractVersion === FLEET_PARITY_CONTRACT_VERSION;
    const sourceCountMatches = imported.sourceCount === FLEET_PARITY_EXPECTED_SOURCE_COUNT;
    const status = !vectorMatches || !sourceCountMatches
      ? "ERROR"
      : parity.status === "NEEDS_INPUT"
        ? "NEEDS_INPUT"
        : !result.configRevisionId
          ? "ERROR"
          : parity.status as FleetParityResultStatus;
    const reasonCode = !vectorMatches
      ? "SOURCE_VECTOR_CHANGED"
      : !sourceCountMatches
        ? "PARTIAL_SOURCE_VECTOR"
        : parity.status === "NEEDS_INPUT"
          ? "TRANSFORM_NEEDS_INPUT"
          : !result.configRevisionId
            ? "NO_ACTIVE_CONFIG"
            : parity.status === "MISMATCH"
              ? "PARITY_MISMATCH"
              : null;
    await client.fleetParityWaveResult.updateMany({
      where: { id: result.id, status: "PENDING" },
      data: {
        status,
        reasonCode,
        legacyImportId: imported.import.id,
        parityObservationId: parity.id,
        legacyDigest: parity.legacyDigest,
        centralDigest: parity.centralDigest,
        sourceCount: imported.sourceCount,
        observedAt,
      },
    });
  } catch (error) {
    await client.fleetParityWaveResult.updateMany({
      where: { id: result.id, status: "PENDING" },
      data: { status: "ERROR", reasonCode: safeFailureCode(error), observedAt },
    });
  }
}

async function finalizeWave(
  waveId: string,
  dependencies: FleetParityServiceDependencies,
): Promise<SelectedWave> {
  const client = dependencies.client;
  return client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM control_plane_fleet_parity_wave WHERE id = ${waveId} FOR UPDATE`;
    let current = await tx.fleetParityWave.findUniqueOrThrow({
      where: { id: waveId },
      select: waveSelect,
    });
    if (current.status !== "RUNNING") return current;
    if (current.results.some((result) => result.status === "PENDING")) {
      throw new ControlPlaneError(
        "Fleet parity 결과가 아직 완료되지 않았습니다.",
        409,
        "FLEET_PARITY_INCOMPLETE",
      );
    }
    for (const result of [...current.results].sort((left, right) => (
      left.repoId < right.repoId ? -1 : left.repoId > right.repoId ? 1 : left.appId.localeCompare(right.appId)
    ))) {
      await tx.$queryRaw`SELECT repoId FROM repository_registration WHERE repoId = ${result.repoId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM app WHERE id = ${result.appId} FOR UPDATE`;
    }
    let vectorChanged = false;
    for (const result of current.results) {
      if (result.status !== "MATCH") continue;
      if (await frozenVectorStillCurrent(result, tx)) continue;
      const changed = await tx.fleetParityWaveResult.updateMany({
        where: { id: result.id, status: "MATCH" },
        data: {
          status: "ERROR",
          reasonCode: "SOURCE_VECTOR_CHANGED",
          observedAt: dependencies.now(),
        },
      });
      vectorChanged ||= changed.count === 1;
    }
    if (vectorChanged) {
      current = await tx.fleetParityWave.findUniqueOrThrow({
        where: { id: waveId },
        select: waveSelect,
      });
    }
    const previous = await tx.fleetParityWave.findFirst({
      where: { id: { not: current.id }, status: { in: ["PASSED", "BLOCKED"] } },
      orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        cohortDigest: true,
        vectorDigest: true,
        consecutiveMatchCount: true,
      },
    });
    const evaluated = evaluateFleetParityWave({
      waveId: current.id,
      cohortDigest: current.cohortDigest,
      results: current.results.map(vectorItem),
      previous,
    });
    const completedAt = dependencies.now();
    const evidenceDigest = jsonDigest({
      schemaVersion: 1,
      occurrenceKey: current.occurrenceKey,
      scope: current.scope,
      contractVersion: current.contractVersion,
      cohortDigest: current.cohortDigest,
      vectorDigest: evaluated.vectorDigest,
      status: evaluated.status,
      resultCount: current.results.length,
      matchCount: evaluated.matchCount,
      consecutiveMatchCount: evaluated.consecutiveMatchCount,
      cleanupAllowed: evaluated.cleanupAllowed,
      completedAt: completedAt.toISOString(),
    } as JsonValue);
    await tx.fleetParityWave.update({
      where: { id: current.id },
      data: {
        status: evaluated.status,
        vectorDigest: evaluated.vectorDigest,
        evidenceDigest,
        resultCount: current.results.length,
        matchCount: evaluated.matchCount,
        consecutiveMatchCount: evaluated.consecutiveMatchCount,
        cleanupAllowed: evaluated.cleanupAllowed,
        completedAt,
      },
    });
    await tx.auditLog.create({
      data: {
        actorLogin: current.observedBy,
        action: "control-plane.fleet-parity.complete",
        entityType: "FleetParityWave",
        entityId: current.id,
        payload: {
          scope: current.scope,
          contractVersion: current.contractVersion,
          cohortDigest: current.cohortDigest,
          vectorDigest: evaluated.vectorDigest,
          evidenceDigest,
          status: evaluated.status,
          resultCount: current.results.length,
          matchCount: evaluated.matchCount,
          consecutiveMatchCount: evaluated.consecutiveMatchCount,
          cleanupAllowed: evaluated.cleanupAllowed,
          reasonCodes: [...new Set(current.results.flatMap((result) => result.reasonCode ? [result.reasonCode] : []))].sort(),
        },
      },
    });
    return tx.fleetParityWave.findUniqueOrThrow({ where: { id: current.id }, select: waveSelect });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function runFleetParityWave(input: {
  observedBy: string;
  idempotencyKey: string;
}, dependencies: FleetParityServiceDependencies = defaultDependencies) {
  const created = await createWave({
    ...input,
    now: dependencies.now(),
  }, dependencies);
  if (created.wave.status !== "RUNNING") {
    return { wave: publicWave(created.wave), duplicate: true };
  }
  for (const result of created.wave.results) {
    await processResult(created.wave, result, dependencies);
  }
  const finalized = await finalizeWave(created.wave.id, dependencies);
  return { wave: publicWave(finalized), duplicate: created.duplicate };
}

export async function listFleetParityWaves(input: { take?: number } = {}) {
  const take = Math.min(Math.max(input.take ?? 20, 1), 100);
  const waves = await prisma.fleetParityWave.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: waveSelect,
  });
  return { waves: waves.map(publicWave) };
}
