import { Prisma } from "@prisma/client";

import {
  legacyConfigResolutionReasonCodeSchema,
  type LegacyConfigResolutionRequest,
} from "@/lib/control-plane/contracts";
import {
  missingLegacyResolutionEvidenceKinds,
  suggestedLegacyResolutionDispositions,
  type LegacyResolutionDisposition,
} from "@/lib/control-plane/legacy-config-resolution-selection";
import { prisma } from "@/lib/prisma";

type ReasonCode = LegacyConfigResolutionRequest["dispositions"][number]["reasonCode"];
export type EvidenceKind = LegacyConfigResolutionRequest["dispositions"][number]["targets"][number];

const LEGACY_RESOLUTION_QUERY_CHUNK_SIZE = 100;

type QueueSourceRow = {
  id: string;
  repoId: bigint | null;
  repoFullName: string;
  configRevisions: Array<{
    id: string;
    revision: number;
    marketLocalizations: Array<{ id: string }>;
    complianceProfiles: Array<{ id: string }>;
    storeAssets: Array<{ id: string }>;
  }>;
  buildTargets: Array<{ id: string }>;
  externalBindings: Array<{ id: string }>;
  providerObservations: Array<{ id: string }>;
  platformFleetBinding: { id: string } | null;
  credentialBindings: Array<{ id: string }>;
  automationDefinitions: Array<{ id: string }>;
  legacyConfigImports: Array<{
    id: string;
    sourceSha: string;
    transformVersion: string;
    reasonCodes: Prisma.JsonValue | null;
    status: string;
    parityObservations: Array<{
      status: string;
      legacyConfigResolutionId: string | null;
      observedAt: Date;
    }>;
  }>;
  legacyConfigResolutions: Array<{
    sourceSha: string;
    transformVersion: string;
    revision: number;
    createdAt: Date;
  }>;
};

export type FleetLegacyResolutionQueueItem = {
  appId: string;
  repoId: string;
  repoFullName: string;
  legacyImportId: string;
  sourceSha: string;
  importStatus: string;
  parityStatus: string | null;
  activeConfigRevision: number | null;
  expectedResolutionRevision: number;
  reasonCodes: ReasonCode[];
  rawReasonCodes: string[];
  availableEvidenceKinds: EvidenceKind[];
  suggestedDispositions: LegacyResolutionDisposition[];
  missingEvidenceKinds: EvidenceKind[];
  reviewable: boolean;
  approvalReady: boolean;
  awaitingParity: boolean;
  blockers: string[];
};

function resolutionKey(appId: string, sourceSha: string, transformVersion: string): string {
  return `${appId}\u0000${sourceSha}\u0000${transformVersion}`;
}

export function chunkFleetLegacyResolutionKeys<T>(keys: readonly T[]): T[][] {
  return Array.from(
    { length: Math.ceil(keys.length / LEGACY_RESOLUTION_QUERY_CHUNK_SIZE) },
    (_, index) => keys.slice(
      index * LEGACY_RESOLUTION_QUERY_CHUNK_SIZE,
      (index + 1) * LEGACY_RESOLUTION_QUERY_CHUNK_SIZE,
    ),
  );
}

function evidenceKinds(row: QueueSourceRow): EvidenceKind[] {
  const active = row.configRevisions[0];
  return [
    ...(active ? ["CONFIG_REVISION" as const] : []),
    ...(row.buildTargets.length > 0 ? ["BUILD_TARGET" as const] : []),
    ...(row.externalBindings.length > 0 ? ["EXTERNAL_BINDING" as const] : []),
    ...(active?.marketLocalizations.length ? ["MARKET_LOCALIZATION" as const] : []),
    ...(active?.complianceProfiles.length ? ["COMPLIANCE_PROFILE" as const] : []),
    ...(active?.storeAssets.length ? ["STORE_ASSET" as const] : []),
    ...(row.providerObservations.length > 0 ? ["PROVIDER_OBSERVATION" as const] : []),
    ...(row.platformFleetBinding ? ["PLATFORM_FLEET_BINDING" as const] : []),
    ...(row.credentialBindings.length > 0 ? ["CREDENTIAL_BINDING" as const] : []),
    ...(row.automationDefinitions.length > 0 ? ["AUTOMATION_DEFINITION" as const] : []),
  ];
}

export function projectFleetLegacyResolutionQueueItem(
  row: QueueSourceRow,
): FleetLegacyResolutionQueueItem | null {
  const legacyImport = row.legacyConfigImports[0];
  if (!row.repoId || !legacyImport) return null;
  const parity = legacyImport.parityObservations[0] ?? null;
  if (parity?.status === "MATCH" && parity.legacyConfigResolutionId) return null;

  const rawReasonCodes = Array.isArray(legacyImport.reasonCodes)
    ? [...new Set(legacyImport.reasonCodes.filter(
        (value): value is string => typeof value === "string",
      ))].sort()
    : [];
  const parsed = legacyConfigResolutionReasonCodeSchema.array().safeParse(rawReasonCodes);
  const active = row.configRevisions[0] ?? null;
  const blockers = [
    ...(legacyImport.status === "DRAFT_CREATED_WITH_INPUT" ? [] : ["IMPORT_NOT_REVIEWABLE"]),
    ...(active ? [] : ["ACTIVE_CONFIG_MISSING"]),
    ...(parsed.success && parsed.data.length > 0 ? [] : ["REASON_LEDGER_INVALID"]),
  ];
  const latestResolution = row.legacyConfigResolutions
    .filter((resolution) => (
      resolution.sourceSha === legacyImport.sourceSha
      && resolution.transformVersion === legacyImport.transformVersion
    ))
    .reduce<(typeof row.legacyConfigResolutions)[number] | null>((latest, resolution) => (
      !latest || resolution.revision > latest.revision ? resolution : latest
    ), null);
  const expectedResolutionRevision = latestResolution?.revision ?? 0;
  const awaitingParity = Boolean(
    latestResolution
    && (!parity || latestResolution.createdAt.getTime() > parity.observedAt.getTime()),
  );
  const availableEvidenceKinds = evidenceKinds(row);
  const suggestedDispositions = parsed.success
    ? suggestedLegacyResolutionDispositions({
        reasonCodes: parsed.data,
        availableEvidenceKinds,
      })
    : [];
  const missingEvidenceKinds = missingLegacyResolutionEvidenceKinds(suggestedDispositions);
  const reviewable = blockers.length === 0;

  return {
    appId: row.id,
    repoId: row.repoId.toString(),
    repoFullName: row.repoFullName,
    legacyImportId: legacyImport.id,
    sourceSha: legacyImport.sourceSha,
    importStatus: legacyImport.status,
    parityStatus: parity?.status ?? null,
    activeConfigRevision: active?.revision ?? null,
    expectedResolutionRevision,
    reasonCodes: parsed.success ? parsed.data : [],
    rawReasonCodes,
    availableEvidenceKinds,
    suggestedDispositions,
    missingEvidenceKinds,
    reviewable,
    approvalReady: reviewable
      && !awaitingParity
      && suggestedDispositions.length > 0
      && suggestedDispositions.every((disposition) => disposition.targets.length > 0),
    awaitingParity,
    blockers,
  };
}

/**
 * ACTIVE 앱별 화면을 순회하지 않아도 사람이 처리할 legacy gate를 한 곳에서 보는 read model이다.
 * 값과 field path는 읽지 않고 고정 reason code와 중앙 evidence 존재 여부만 반환한다.
 */
export async function getFleetLegacyResolutionQueue(): Promise<FleetLegacyResolutionQueueItem[]> {
  const rows = await prisma.app.findMany({
    where: {
      status: "ACTIVE",
      repoId: { not: null },
      legacyConfigImports: { some: {} },
    },
    orderBy: { repoFullName: "asc" },
    select: {
      id: true,
      repoId: true,
      repoFullName: true,
      configRevisions: {
        where: { status: "ACTIVE" },
        orderBy: { revision: "desc" },
        take: 1,
        select: {
          id: true,
          revision: true,
          marketLocalizations: { take: 1, select: { id: true } },
          complianceProfiles: { take: 1, select: { id: true } },
          storeAssets: { take: 1, select: { id: true } },
        },
      },
      buildTargets: { take: 1, select: { id: true } },
      externalBindings: { take: 1, select: { id: true } },
      providerObservations: { take: 1, select: { id: true } },
      platformFleetBinding: { select: { id: true } },
      credentialBindings: {
        where: { status: "ACTIVE" },
        take: 1,
        select: { id: true },
      },
      automationDefinitions: { take: 1, select: { id: true } },
      legacyConfigImports: {
        orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          id: true,
          sourceSha: true,
          transformVersion: true,
          reasonCodes: true,
          status: true,
          parityObservations: {
            orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
            take: 1,
            select: { status: true, legacyConfigResolutionId: true, observedAt: true },
          },
        },
      },
    },
  });

  const exactKeys = new Map(rows.flatMap((row) => {
    const legacyImport = row.legacyConfigImports[0];
    if (!legacyImport) return [];
    const key = resolutionKey(row.id, legacyImport.sourceSha, legacyImport.transformVersion);
    return [[key, {
      appId: row.id,
      sourceSha: legacyImport.sourceSha,
      transformVersion: legacyImport.transformVersion,
    }] as const];
  }));
  const latestResolutionByKey = new Map<string, { revision: number; createdAt: Date }>();
  for (const exactKeyChunk of chunkFleetLegacyResolutionKeys([...exactKeys.values()])) {
    const maxRevisions = await prisma.legacyConfigResolution.groupBy({
      by: ["appId", "sourceSha", "transformVersion"],
      where: { OR: exactKeyChunk },
      _max: { revision: true },
    });
    const exactLatestRevisionKeys = maxRevisions.flatMap((resolution) => (
      resolution._max.revision
        ? [{
            appId: resolution.appId,
            sourceSha: resolution.sourceSha,
            transformVersion: resolution.transformVersion,
            revision: resolution._max.revision,
          }]
        : []
    ));
    if (exactLatestRevisionKeys.length === 0) continue;
    const latestResolutions = await prisma.legacyConfigResolution.findMany({
      where: { OR: exactLatestRevisionKeys },
      select: {
        appId: true,
        sourceSha: true,
        transformVersion: true,
        revision: true,
        createdAt: true,
      },
    });
    for (const resolution of latestResolutions) {
      latestResolutionByKey.set(
        resolutionKey(resolution.appId, resolution.sourceSha, resolution.transformVersion),
        { revision: resolution.revision, createdAt: resolution.createdAt },
      );
    }
  }

  return rows
    .map((row) => {
      const legacyImport = row.legacyConfigImports[0];
      const latestResolution = legacyImport
        ? latestResolutionByKey.get(resolutionKey(
            row.id,
            legacyImport.sourceSha,
            legacyImport.transformVersion,
          )) ?? null
        : null;
      return projectFleetLegacyResolutionQueueItem({
        ...row,
        legacyConfigResolutions: legacyImport && latestResolution
          ? [{
              sourceSha: legacyImport.sourceSha,
              transformVersion: legacyImport.transformVersion,
              revision: latestResolution.revision,
              createdAt: latestResolution.createdAt,
            }]
          : [],
      });
    })
    .filter((item): item is FleetLegacyResolutionQueueItem => item !== null);
}
