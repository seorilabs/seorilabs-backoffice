import { Prisma } from "@prisma/client";

import {
  legacyConfigResolutionReasonCodeSchema,
  legacyConfigResolutionRequestSchema,
  legacyConfigResolutionTargetSchema,
  type LegacyConfigResolutionRequest,
} from "@/lib/control-plane/contracts";
import {
  legacyResolutionReasonCodesDigest,
  validateLegacyResolutionDispositions,
  type LegacyResolutionApprovalKind,
  type LegacyResolutionBinding,
  type LegacyResolutionDisposition,
} from "@/lib/control-plane/legacy-config-resolution";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  assertIdempotentRequestHash,
  ControlPlaneError,
} from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

const ACTOR = /^[A-Za-z0-9._:/-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:/-]{8,191}$/;

type EvidenceKind = LegacyResolutionDisposition["targets"][number];

type CentralStateSnapshot = {
  digest: string;
  evidenceKinds: EvidenceKind[];
};

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function jsonValueDigest(value: Prisma.JsonValue | null): string | null {
  return value === null ? null : jsonDigest(value as JsonValue);
}

function sortedStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export async function legacyCentralStateSnapshot(
  tx: Prisma.TransactionClient,
  input: {
    appId: string;
    configRevisionId: string;
    includedKinds?: readonly EvidenceKind[];
  },
): Promise<CentralStateSnapshot> {
  const [
    config,
    buildTargets,
    externalBindings,
    marketLocalizations,
    complianceProfiles,
    storeAssets,
    providerObservations,
    platformFleetBinding,
    credentialBindings,
    automationDefinitions,
  ] = await Promise.all([
    tx.configRevision.findFirst({
      where: { id: input.configRevisionId, appId: input.appId, status: "ACTIVE" },
      select: {
        id: true,
        revision: true,
        payloadHash: true,
        snapshotDigest: true,
        sourceObservationId: true,
      },
    }),
    tx.buildTarget.findMany({
      where: { appId: input.appId },
      orderBy: [{ targetKey: "asc" }, { id: "asc" }],
      select: {
        id: true,
        targetKey: true,
        stack: true,
        market: true,
        packageId: true,
        bundleId: true,
        observedSha: true,
        configuration: true,
      },
    }),
    tx.externalBinding.findMany({
      where: { appId: input.appId },
      orderBy: [{ provider: "asc" }, { bindingType: "asc" }, { externalId: "asc" }],
      select: {
        id: true,
        provider: true,
        bindingType: true,
        externalId: true,
        publicIdentity: true,
        metadata: true,
      },
    }),
    tx.marketLocalization.findMany({
      where: { appId: input.appId, configRevisionId: input.configRevisionId },
      orderBy: [{ scopeKey: "asc" }, { locale: "asc" }, { id: "asc" }],
      select: { id: true, market: true, scopeKey: true, locale: true, payloadHash: true },
    }),
    tx.complianceProfile.findMany({
      where: { appId: input.appId, configRevisionId: input.configRevisionId },
      orderBy: [{ market: "asc" }, { declaration: "asc" }, { id: "asc" }],
      select: { id: true, market: true, declaration: true, state: true, payloadHash: true },
    }),
    tx.storeAsset.findMany({
      where: { appId: input.appId, configRevisionId: input.configRevisionId },
      orderBy: [{ scopeKey: "asc" }, { kind: "asc" }, { objectKey: "asc" }, { id: "asc" }],
      select: {
        id: true,
        market: true,
        scopeKey: true,
        kind: true,
        locale: true,
        objectKey: true,
        checksum: true,
      },
    }),
    tx.providerObservation.findMany({
      where: { appId: input.appId },
      orderBy: [{ provider: "asc" }, { resourceType: "asc" }, { resourceId: "asc" }, { observedAt: "desc" }],
      select: {
        id: true,
        provider: true,
        resourceType: true,
        resourceId: true,
        payloadHash: true,
        observedAt: true,
      },
    }),
    tx.platformFleetBinding.findUnique({
      where: { appId: input.appId },
      select: {
        id: true,
        platformReleaseId: true,
        observedVersion: true,
        observedDigest: true,
        approvedVersion: true,
        approvedDigest: true,
        manifestDigest: true,
        contractRevision: true,
        state: true,
        sourceSha: true,
      },
    }),
    tx.credentialBinding.findMany({
      where: { appId: input.appId, status: "ACTIVE" },
      orderBy: [{ logicalCredentialId: "asc" }, { capability: "asc" }, { id: "asc" }],
      select: {
        id: true,
        logicalCredentialId: true,
        provider: true,
        capability: true,
        environment: true,
        publicIdentity: true,
        fingerprint: true,
        consumer: true,
        credentialGeneration: true,
        policyGeneration: true,
        catalogEntryDigest: true,
        catalogSnapshotDigest: true,
        catalogContractVersion: true,
      },
    }),
    tx.automationDefinition.findMany({
      where: { appId: input.appId },
      orderBy: [{ key: "asc" }, { id: "asc" }],
      select: {
        id: true,
        key: true,
        template: true,
        schedule: true,
        agentKind: true,
        model: true,
        configuration: true,
        enabled: true,
      },
    }),
  ]);
  if (!config) {
    throw new ControlPlaneError(
      "선택한 ACTIVE ConfigRevision을 찾을 수 없습니다.",
      409,
      "LEGACY_RESOLUTION_ACTIVE_CONFIG_CHANGED",
    );
  }
  const evidenceKinds = new Set<EvidenceKind>(["CONFIG_REVISION"]);
  if (buildTargets.length > 0) evidenceKinds.add("BUILD_TARGET");
  if (externalBindings.length > 0) evidenceKinds.add("EXTERNAL_BINDING");
  if (marketLocalizations.length > 0) evidenceKinds.add("MARKET_LOCALIZATION");
  if (complianceProfiles.length > 0) evidenceKinds.add("COMPLIANCE_PROFILE");
  if (storeAssets.length > 0) evidenceKinds.add("STORE_ASSET");
  if (providerObservations.length > 0) evidenceKinds.add("PROVIDER_OBSERVATION");
  if (platformFleetBinding) evidenceKinds.add("PLATFORM_FLEET_BINDING");
  if (credentialBindings.length > 0) evidenceKinds.add("CREDENTIAL_BINDING");
  if (automationDefinitions.length > 0) evidenceKinds.add("AUTOMATION_DEFINITION");

  const seenProviderResources = new Set<string>();
  const providerReadbacks = providerObservations.flatMap((row) => {
    const key = `${row.provider}\u0000${row.resourceType}\u0000${row.resourceId}`;
    if (seenProviderResources.has(key)) return [];
    seenProviderResources.add(key);
    return [{
      provider: row.provider,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      payloadHash: row.payloadHash,
    }];
  });

  const includedKinds = new Set<EvidenceKind>(input.includedKinds ?? evidenceKinds);
  includedKinds.add("CONFIG_REVISION");
  const snapshot = {
    schemaVersion: 1,
    appId: input.appId,
    config,
    ...(includedKinds.has("BUILD_TARGET") ? {
      buildTargets: buildTargets.map(({ configuration, ...row }) => ({
        ...row,
        configurationDigest: jsonValueDigest(configuration),
      })),
    } : {}),
    ...(includedKinds.has("EXTERNAL_BINDING") ? {
      externalBindings: externalBindings.map(({ metadata, ...row }) => ({
        ...row,
        metadataDigest: jsonValueDigest(metadata),
      })),
    } : {}),
    ...(includedKinds.has("MARKET_LOCALIZATION") ? { marketLocalizations } : {}),
    ...(includedKinds.has("COMPLIANCE_PROFILE") ? { complianceProfiles } : {}),
    ...(includedKinds.has("STORE_ASSET") ? { storeAssets } : {}),
    // 동일 공개 resource의 같은 payload를 다시 읽은 시간/row ID는 승인 의미를
    // 바꾸지 않는다. 최신 semantic readback만 digest에 포함한다.
    ...(includedKinds.has("PROVIDER_OBSERVATION") ? { providerObservations: providerReadbacks } : {}),
    ...(includedKinds.has("PLATFORM_FLEET_BINDING") ? { platformFleetBinding } : {}),
    ...(includedKinds.has("CREDENTIAL_BINDING") ? { credentialBindings } : {}),
    ...(includedKinds.has("AUTOMATION_DEFINITION") ? {
      automationDefinitions: automationDefinitions.map(({ configuration, ...row }) => ({
        ...row,
        configurationDigest: jsonValueDigest(configuration),
      })),
    } : {}),
    evidenceKinds: sortedStrings(includedKinds),
  };
  return {
    digest: jsonDigest(snapshot as unknown as JsonValue),
    evidenceKinds: sortedStrings(evidenceKinds) as EvidenceKind[],
  };
}

function publicResolution<T extends { requestHash: string }>(resolution: T) {
  const { requestHash, ...publicValue } = resolution;
  void requestHash;
  return publicValue;
}

const resolutionSelect = {
  id: true,
  appId: true,
  sourceImportId: true,
  configRevisionId: true,
  sourceSha: true,
  transformVersion: true,
  inputDigest: true,
  reasonCodes: true,
  reasonCodesDigest: true,
  centralStateDigest: true,
  centralEvidenceKinds: true,
  dispositions: true,
  dispositionDigest: true,
  revision: true,
  approvalKind: true,
  justification: true,
  requestHash: true,
  resolutionDigest: true,
  idempotencyKey: true,
  createdBy: true,
  createdAt: true,
} satisfies Prisma.LegacyConfigResolutionSelect;

function resolutionRequestHash(input: {
  request: LegacyConfigResolutionRequest;
  approvalKind: LegacyResolutionApprovalKind;
}): string {
  return jsonDigest({
    scope: "legacy-config-resolution/v1",
    request: {
      ...input.request,
      repoId: input.request.repoId.toString(),
      dispositions: [...input.request.dispositions]
        .map((item) => ({ ...item, targets: [...item.targets].sort() }))
        .sort((left, right) => left.reasonCode.localeCompare(right.reasonCode)),
    },
    approvalKind: input.approvalKind,
  } as JsonValue);
}

function parsedReasonCodes(value: Prisma.JsonValue | null, digest: string | null) {
  const parsed = legacyConfigResolutionReasonCodeSchema.array().safeParse(value);
  if (!parsed.success || parsed.data.length === 0 || !digest) {
    throw new ControlPlaneError(
      "새 reason ledger가 있는 legacy import를 먼저 실행해야 합니다.",
      409,
      "LEGACY_RESOLUTION_REASON_LEDGER_MISSING",
    );
  }
  const reasonCodes = [...new Set(parsed.data)].sort();
  if (legacyResolutionReasonCodesDigest(reasonCodes) !== digest) {
    throw new ControlPlaneError(
      "legacy reason ledger digest가 일치하지 않습니다.",
      409,
      "LEGACY_RESOLUTION_REASON_LEDGER_INVALID",
    );
  }
  return reasonCodes;
}

export async function recordLegacyConfigResolution(input: {
  request: LegacyConfigResolutionRequest;
  actor: string;
  approvalKind: LegacyResolutionApprovalKind;
  idempotencyKey: string;
}) {
  const request = legacyConfigResolutionRequestSchema.parse(input.request);
  if (!ACTOR.test(input.actor)) {
    throw new ControlPlaneError("actor가 유효하지 않습니다.", 400, "ACTOR_INVALID");
  }
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw new ControlPlaneError("idempotency key가 유효하지 않습니다.", 400, "IDEMPOTENCY_KEY_INVALID");
  }
  const requestHash = resolutionRequestHash({ request, approvalKind: input.approvalKind });
  const replay = await prisma.legacyConfigResolution.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: resolutionSelect,
  });
  if (replay) {
    assertIdempotentRequestHash(replay.requestHash, requestHash);
    return { duplicate: true, resolution: publicResolution(replay) };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM app WHERE repoId = ${request.repoId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM control_plane_legacy_config_import WHERE id = ${request.legacyImportId} FOR UPDATE`;
      const afterLockReplay = await tx.legacyConfigResolution.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: resolutionSelect,
      });
      if (afterLockReplay) {
        assertIdempotentRequestHash(afterLockReplay.requestHash, requestHash);
        return { duplicate: true, resolution: publicResolution(afterLockReplay) };
      }
      const app = await tx.app.findUnique({
        where: { repoId: request.repoId },
        select: {
          id: true,
          configRevisions: {
            where: { status: "ACTIVE" },
            orderBy: { revision: "desc" },
            take: 1,
            select: { id: true, revision: true },
          },
        },
      });
      const legacyImport = await tx.legacyConfigImport.findFirst({
        where: { id: request.legacyImportId, appId: app?.id ?? "__missing_app__" },
        select: {
          id: true,
          appId: true,
          sourceSha: true,
          transformVersion: true,
          inputDigest: true,
          reasonCodes: true,
          reasonCodesDigest: true,
          status: true,
        },
      });
      if (!app || !legacyImport) {
        throw new ControlPlaneError("legacy import를 찾을 수 없습니다.", 404, "LEGACY_IMPORT_NOT_FOUND");
      }
      if (legacyImport.status !== "DRAFT_CREATED_WITH_INPUT") {
        throw new ControlPlaneError(
          "사람 검토로 해소할 수 있는 legacy import 상태가 아닙니다.",
          409,
          "LEGACY_RESOLUTION_IMPORT_NOT_REVIEWABLE",
        );
      }
      const active = app.configRevisions[0];
      if (!active || active.revision !== request.expectedActiveConfigRevision) {
        throw new ControlPlaneError(
          "ACTIVE ConfigRevision이 변경되었습니다.",
          409,
          "LEGACY_RESOLUTION_ACTIVE_CONFIG_CHANGED",
        );
      }
      const latestResolution = await tx.legacyConfigResolution.findFirst({
        where: {
          appId: app.id,
          sourceSha: legacyImport.sourceSha,
          transformVersion: legacyImport.transformVersion,
        },
        orderBy: { revision: "desc" },
        select: { revision: true },
      });
      if ((latestResolution?.revision ?? 0) !== request.expectedResolutionRevision) {
        throw new ControlPlaneError(
          "legacy resolution revision이 변경되었습니다.",
          409,
          "LEGACY_RESOLUTION_REVISION_CONFLICT",
        );
      }
      const reasonCodes = parsedReasonCodes(legacyImport.reasonCodes, legacyImport.reasonCodesDigest);
      const reasonCodesDigest = legacyImport.reasonCodesDigest!;
      const bindingEvidenceKinds = sortedStrings([
        "CONFIG_REVISION",
        ...request.dispositions.flatMap((item) => item.targets).filter((target) => target !== "IGNORED_NON_OPERATIONAL"),
      ]) as EvidenceKind[];
      const central = await legacyCentralStateSnapshot(tx, {
        appId: app.id,
        configRevisionId: active.id,
        includedKinds: bindingEvidenceKinds,
      });
      const validation = validateLegacyResolutionDispositions({
        reasonCodes,
        dispositions: request.dispositions,
        evidenceKinds: new Set(central.evidenceKinds),
        approvalKind: input.approvalKind,
      });
      if (!validation.ok) {
        throw new ControlPlaneError(
          "legacy reason을 해소할 중앙 증거 또는 사람 승인이 부족합니다.",
          409,
          validation.code,
        );
      }
      if (
        input.approvalKind === "AUTOMATION"
        && request.justification !== "NO_LEGACY_DESIRED_STATE"
      ) {
        throw new ControlPlaneError(
          "이 legacy resolution은 사람 검토가 필요합니다.",
          403,
          "LEGACY_RESOLUTION_HUMAN_APPROVAL_REQUIRED",
        );
      }
      const dispositions = [...request.dispositions]
        .map((item) => ({ ...item, targets: [...item.targets].sort() }))
        .sort((left, right) => left.reasonCode.localeCompare(right.reasonCode));
      const dispositionDigest = jsonDigest(dispositions as unknown as JsonValue);
      const revision = request.expectedResolutionRevision + 1;
      const resolutionDigest = jsonDigest({
        scope: "legacy-config-resolution-record/v1",
        appId: app.id,
        sourceImportId: legacyImport.id,
        configRevisionId: active.id,
        sourceSha: legacyImport.sourceSha,
        transformVersion: legacyImport.transformVersion,
        inputDigest: legacyImport.inputDigest,
        reasonCodesDigest,
        centralStateDigest: central.digest,
        centralEvidenceKinds: bindingEvidenceKinds,
        dispositionDigest,
        revision,
        approvalKind: input.approvalKind,
        justification: request.justification,
        createdBy: input.actor,
      } as JsonValue);
      const created = await tx.legacyConfigResolution.create({
        data: {
          appId: app.id,
          sourceImportId: legacyImport.id,
          configRevisionId: active.id,
          sourceSha: legacyImport.sourceSha,
          transformVersion: legacyImport.transformVersion,
          inputDigest: legacyImport.inputDigest,
          reasonCodes: inputJson(reasonCodes),
          reasonCodesDigest,
          centralStateDigest: central.digest,
          centralEvidenceKinds: inputJson(bindingEvidenceKinds),
          dispositions: inputJson(dispositions),
          dispositionDigest,
          revision,
          approvalKind: input.approvalKind,
          justification: request.justification,
          requestHash,
          resolutionDigest,
          idempotencyKey: input.idempotencyKey,
          createdBy: input.actor,
        },
        select: resolutionSelect,
      });
      await tx.auditLog.create({
        data: {
          actorLogin: input.actor,
          action: "control-plane.legacy-config-resolution.recorded",
          entityType: "LegacyConfigResolution",
          entityId: created.id,
          payload: {
            appId: app.id,
            sourceImportId: legacyImport.id,
            configRevisionId: active.id,
            sourceSha: legacyImport.sourceSha,
            transformVersion: legacyImport.transformVersion,
            inputDigest: legacyImport.inputDigest,
            reasonCodes,
            reasonCodesDigest,
            centralStateDigest: central.digest,
            centralEvidenceKinds: bindingEvidenceKinds,
            dispositionDigest,
            revision,
            approvalKind: input.approvalKind,
            justification: request.justification,
            requestHash,
            resolutionDigest,
          },
        },
      });
      return { duplicate: false, resolution: publicResolution(created) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const winner = await prisma.legacyConfigResolution.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: resolutionSelect,
    });
    if (!winner) throw error;
    assertIdempotentRequestHash(winner.requestHash, requestHash);
    return { duplicate: true, resolution: publicResolution(winner) };
  }
}

export async function findApplicableLegacyConfigResolution(
  tx: Prisma.TransactionClient,
  input: {
    appId: string;
    sourceSha: string;
    transformVersion: string;
    inputDigest: string;
    reasonCodesDigest: string;
    configRevisionId: string;
  },
): Promise<{ resolution: LegacyResolutionBinding | null; centralStateDigest: string }> {
  const candidate = await tx.legacyConfigResolution.findFirst({
    where: {
      appId: input.appId,
      sourceSha: input.sourceSha,
      transformVersion: input.transformVersion,
      inputDigest: input.inputDigest,
      reasonCodesDigest: input.reasonCodesDigest,
      configRevisionId: input.configRevisionId,
    },
    orderBy: { revision: "desc" },
    select: {
      id: true,
      appId: true,
      sourceSha: true,
      transformVersion: true,
      inputDigest: true,
      reasonCodesDigest: true,
      configRevisionId: true,
      centralStateDigest: true,
      resolutionDigest: true,
      centralEvidenceKinds: true,
    },
  });
  if (!candidate) return { resolution: null, centralStateDigest: "" };
  const parsedEvidenceKinds = legacyConfigResolutionTargetSchema.array().safeParse(candidate.centralEvidenceKinds);
  if (!parsedEvidenceKinds.success) return { resolution: null, centralStateDigest: "" };
  const central = await legacyCentralStateSnapshot(tx, {
    appId: input.appId,
    configRevisionId: input.configRevisionId,
    includedKinds: parsedEvidenceKinds.data.filter((kind) => kind !== "IGNORED_NON_OPERATIONAL"),
  });
  const { centralEvidenceKinds, ...resolution } = candidate;
  void centralEvidenceKinds;
  return {
    resolution: resolution.centralStateDigest === central.digest ? resolution : null,
    centralStateDigest: central.digest,
  };
}

export async function listLegacyConfigResolutions(input: { repoId: bigint }) {
  const app = await prisma.app.findUnique({ where: { repoId: input.repoId }, select: { id: true } });
  if (!app) throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
  const resolutions = await prisma.legacyConfigResolution.findMany({
    where: { appId: app.id },
    orderBy: [{ createdAt: "desc" }, { revision: "desc" }],
    take: 100,
    select: resolutionSelect,
  });
  return { resolutions: resolutions.map(publicResolution) };
}
