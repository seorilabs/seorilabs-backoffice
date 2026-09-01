import { Prisma } from "@prisma/client";

import { latestDiscoveryObservationOrder } from "@/lib/control-plane/discovery-order";
import {
  FLEET_PARITY_CONTRACT_VERSION,
  FLEET_PARITY_EXPECTED_SOURCE_COUNT,
  FLEET_PARITY_SCOPE,
} from "@/lib/control-plane/fleet-parity";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { legacyResolutionReasonCodesDigest } from "@/lib/control-plane/legacy-config-resolution";
import {
  findApplicableLegacyConfigResolution,
  recordLegacyConfigResolution,
} from "@/lib/control-plane/legacy-config-resolution-service";
import { recordLegacyShadowImport } from "@/lib/control-plane/legacy-shadow-service";
import { LEGACY_SOURCE_DEFINITIONS } from "@/lib/control-plane/legacy-sources";
import { repositorySourceIsCurrent } from "@/lib/control-plane/repository-registration";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

type ImportInput = Parameters<typeof recordLegacyShadowImport>[0];
type ImportResult = Awaited<ReturnType<typeof recordLegacyShadowImport>>;
type ResolutionBinding = Parameters<typeof findApplicableLegacyConfigResolution>[1];
type ResolutionContext = {
  activeConfigRevision: number;
  latestResolutionRevision: number;
};

export type FleetParityImportDependencies = {
  recordImport: (input: ImportInput) => Promise<ImportResult>;
  readCurrentContext: (input: ResolutionBinding & { repoId: bigint }) => Promise<ResolutionContext | null>;
  hasApplicableResolution: (input: ResolutionBinding) => Promise<boolean>;
  recordResolution: (input: Parameters<typeof recordLegacyConfigResolution>[0]) => Promise<unknown>;
};

const defaultDependencies: FleetParityImportDependencies = {
  recordImport: (input) => recordLegacyShadowImport(input),
  readCurrentContext: async (input) => {
    const [app, registration, latestResolution] = await Promise.all([
      prisma.app.findUnique({
        where: { repoId: input.repoId },
        select: {
          id: true,
          status: true,
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
            select: { id: true, revision: true },
          },
        },
      }),
      prisma.repositoryRegistration.findUnique({
        where: { repoId: input.repoId },
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
      prisma.legacyConfigResolution.findFirst({
        where: {
          appId: input.appId,
          sourceSha: input.sourceSha,
          transformVersion: input.transformVersion,
        },
        orderBy: { revision: "desc" },
        select: { revision: true },
      }),
    ]);
    const active = app?.configRevisions[0];
    if (
      !app
      || app.id !== input.appId
      || app.status !== "ACTIVE"
      || active?.id !== input.configRevisionId
      || app.discoveryObservations[0]?.sourceSha.toLowerCase() !== input.sourceSha
      || !registration
      || !repositorySourceIsCurrent(registration, input.sourceSha)
      || registration.repoFullName.toLowerCase() !== app.repoFullName.toLowerCase()
    ) return null;
    return {
      activeConfigRevision: active.revision,
      latestResolutionRevision: latestResolution?.revision ?? 0,
    };
  },
  hasApplicableResolution: async (input) => prisma.$transaction(async (tx) => (
    (await findApplicableLegacyConfigResolution(tx, input)).resolution !== null
  ), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
  recordResolution: (input) => recordLegacyConfigResolution(input),
};

function completeLegacyAbsence(imported: ImportResult, sourceSha: string): boolean {
  const legacyImport = imported.import;
  const parity = imported.parity;
  const reasons = legacyImport.reasonCodes;
  const expectedKinds = new Set<string>(LEGACY_SOURCE_DEFINITIONS.map((source) => source.sourceKind));
  return legacyImport.status === "DRAFT_CREATED_WITH_INPUT"
    && legacyImport.sourceSha === sourceSha
    && legacyImport.transformVersion === FLEET_PARITY_CONTRACT_VERSION
    && Array.isArray(reasons)
    && reasons.length === 1
    && reasons[0] === "NO_REPRESENTABLE_SOURCE"
    && legacyImport.reasonCodesDigest === legacyResolutionReasonCodesDigest(["NO_REPRESENTABLE_SOURCE"])
    && parity?.status === "NEEDS_INPUT"
    && parity.sourceSha === sourceSha
    && parity.configRevisionId !== null
    && parity.scope === FLEET_PARITY_SCOPE
    && parity.contractVersion === FLEET_PARITY_CONTRACT_VERSION
    && imported.sourceCount === FLEET_PARITY_EXPECTED_SOURCE_COUNT
    && legacyImport.sources.length === FLEET_PARITY_EXPECTED_SOURCE_COUNT
    && new Set(legacyImport.sources.map((source) => source.sourceKind)).size === expectedKinds.size
    && legacyImport.sources.every((source) => (
      expectedKinds.has(source.sourceKind)
      && source.status === "ABSENT"
      && source.errorCode === "PATH_NOT_FOUND"
    ));
}

/**
 * 확인된 legacy 파일 부재만 자동 기록한다. 판정 후 별도 source 관측을 수행하므로
 * 승인 저장 성공을 MATCH로 간주하지 않으며 사람 검토 reason은 이 경로에 들어오지 않는다.
 */
export async function recordFleetParityImport(
  input: ImportInput,
  overrides: Partial<FleetParityImportDependencies> = {},
): Promise<ImportResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const normalized = { ...input, sourceSha: input.sourceSha.toLowerCase() };
  const imported = await dependencies.recordImport(normalized);
  if (!completeLegacyAbsence(imported, normalized.sourceSha)) return imported;

  const binding: ResolutionBinding = {
    appId: imported.import.appId,
    sourceSha: imported.import.sourceSha,
    transformVersion: imported.import.transformVersion,
    inputDigest: imported.import.inputDigest,
    reasonCodesDigest: imported.import.reasonCodesDigest!,
    configRevisionId: imported.parity!.configRevisionId!,
  };
  const context = await dependencies.readCurrentContext({ ...binding, repoId: input.repoId });
  if (!context) {
    throw new ControlPlaneError(
      "기존 설정 부재 관측 이후 앱 또는 적용 설정이 변경되었습니다.",
      409,
      "SOURCE_VECTOR_CHANGED",
    );
  }

  if (!await dependencies.hasApplicableResolution(binding)) {
    const resolutionKey = jsonDigest({
      scope: "fleet-parity-no-legacy-resolution/v1",
      importId: imported.import.id,
      configRevisionId: binding.configRevisionId,
      actor: input.observedBy,
    } as JsonValue);
    try {
      await dependencies.recordResolution({
        request: {
          schemaVersion: 1,
          repoId: input.repoId,
          legacyImportId: imported.import.id,
          expectedResolutionRevision: context.latestResolutionRevision,
          expectedActiveConfigRevision: context.activeConfigRevision,
          dispositions: [{
            reasonCode: "NO_REPRESENTABLE_SOURCE",
            targets: ["IGNORED_NON_OPERATIONAL"],
          }],
          justification: "NO_LEGACY_DESIRED_STATE",
        },
        actor: input.observedBy,
        approvalKind: "AUTOMATION",
        idempotencyKey: `fleet-no-legacy:${resolutionKey}`,
      });
    } catch (error) {
      const competingResolution = error instanceof ControlPlaneError && (
        error.code === "IDEMPOTENCY_CONFLICT"
        || error.code === "LEGACY_RESOLUTION_REVISION_CONFLICT"
      );
      // 동시에 기록한 실행이 있으면 새 mutation을 반복하지 않고 exact binding만 읽는다.
      if (!competingResolution || !await dependencies.hasApplicableResolution(binding)) throw error;
    }
  }

  const recheckKey = jsonDigest({
    scope: "fleet-parity-no-legacy-recheck/v1",
    idempotencyKey: input.idempotencyKey,
    importId: imported.import.id,
    configRevisionId: binding.configRevisionId,
  } as JsonValue);
  return dependencies.recordImport({
    ...normalized,
    idempotencyKey: `fleet-no-legacy-recheck:${recheckKey}`,
  });
}
