import { Prisma } from "@prisma/client";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

/**
 * 사람이 만든 DRAFT와 shadow import DRAFT가 같은 revision allocation 경로를 쓴다.
 * 호출자는 app row를 FOR UPDATE로 잠그고 payload를 공용 validator로 검증해야 한다.
 */
export async function createDraftRevisionInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    appId: string;
    payload: Record<string, unknown>;
    payloadHash: string;
    createdBy: string;
    idempotencyKey: string;
  },
) {
  const latest = await tx.configRevision.aggregate({
    where: { appId: input.appId },
    _max: { revision: true },
  });
  const payload = configRevisionPayloadSchema.parse(input.payload);
  const revision = await tx.configRevision.create({
    data: {
      appId: input.appId,
      revision: (latest._max.revision ?? 0) + 1,
      status: "DRAFT",
      payload: input.payload as Prisma.InputJsonValue,
      payloadHash: input.payloadHash,
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey,
    },
  });

  if (payload.projectBlueprint) {
    const blueprint = payload.projectBlueprint;
    await tx.projectBlueprint.create({
      data: {
        appId: input.appId,
        configRevisionId: revision.id,
        schemaVersion: blueprint.schemaVersion,
        organizationId: blueprint.organizationId,
        folderId: blueprint.folderId,
        billingAccountId: blueprint.billingAccountId,
        projectId: blueprint.project.projectId,
        projectNumber: blueprint.project.projectNumber,
        region: blueprint.project.region,
        payload: blueprint as Prisma.InputJsonValue,
        payloadHash: jsonDigest(blueprint as JsonValue),
      },
    });
  }
  if (payload.markets.length > 0) {
    await tx.marketProfile.createMany({
      data: payload.markets.map((profile) => ({
        appId: input.appId,
        configRevisionId: revision.id,
        market: profile.market,
        enabled: profile.enabled,
        releaseChannel: profile.releaseChannel,
        locales: profile.locales,
      })),
    });
  }
  if (payload.localizations?.length) {
    await tx.marketLocalization.createMany({
      data: payload.localizations.map((localization) => ({
        appId: input.appId,
        configRevisionId: revision.id,
        market: localization.market,
        scopeKey: localization.market ?? "all",
        locale: localization.locale,
        payload: localization as Prisma.InputJsonValue,
        payloadHash: jsonDigest(localization as JsonValue),
      })),
    });
  }
  if (payload.complianceDrafts?.length) {
    await tx.complianceProfile.createMany({
      data: payload.complianceDrafts.map((profile) => ({
        appId: input.appId,
        configRevisionId: revision.id,
        market: profile.market,
        declaration: profile.declaration,
        state: profile.state,
        payload: profile as Prisma.InputJsonValue,
        payloadHash: jsonDigest(profile as JsonValue),
      })),
    });
  }
  if (payload.assets?.length) {
    await tx.storeAsset.createMany({
      data: payload.assets.map((asset) => ({
        appId: input.appId,
        configRevisionId: revision.id,
        market: asset.market,
        scopeKey: `${asset.market ?? "all"}:${asset.locale ?? "all"}`,
        kind: asset.kind,
        locale: asset.locale,
        objectKey: asset.objectKey,
        checksum: asset.checksum.toLowerCase(),
      })),
    });
  }

  return revision;
}
