import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
import { latestDiscoveryObservationOrder } from "@/lib/control-plane/discovery-order";
import {
  getFleetLegacyResolutionQueue,
  type FleetLegacyResolutionQueueItem,
} from "@/lib/control-plane/fleet-legacy-resolution-queue";
import { prisma } from "@/lib/prisma";

export type FleetComplianceDraftBlocker =
  | "APP_IDENTITY_CHANGED"
  | "ACTIVE_CONFIG_MISSING"
  | "ACTIVE_PAYLOAD_INVALID"
  | "ACTIVE_COMPLIANCE_PROJECTION_DRIFT"
  | "ACTIVE_REVISION_CHANGED"
  | "CURRENT_DISCOVERY_MISSING"
  | "SOURCE_SHA_CHANGED"
  | "ENABLED_MARKET_MISSING"
  | "LATEST_DRAFT_EXISTS";

export type FleetComplianceDraftQueueItem = {
  appId: string;
  repoId: string;
  repoFullName: string;
  sourceSha: string;
  activeConfigRevision: number;
  latestConfigRevision: number;
  enabledMarkets: string[];
  reasonCodes: string[];
  credentialBindingRequired: boolean;
  eligible: boolean;
  blockers: FleetComplianceDraftBlocker[];
};

export type FleetComplianceDraftQueueState = FleetComplianceDraftQueueItem & {
  appSlug: string;
  activePayload: Record<string, unknown>;
  latestRevisionState: {
    revision: number;
    status: string;
    idempotencyKey: string;
    payloadHash: string;
  } | null;
};

type ComplianceQueueAppRow = {
  id: string;
  slug: string;
  repoId: bigint | null;
  repoFullName: string;
  configRevisions: Array<{
    revision: number;
    payload: unknown;
    complianceProfiles: Array<{ id: string }>;
  }>;
  discoveryObservations: Array<{ sourceSha: string }>;
};

type LatestRevisionRow = {
  appId: string;
  revision: number;
  status: string;
  idempotencyKey: string;
  payloadHash: string;
};

export function projectFleetComplianceDraftQueueItem(input: {
  legacy: FleetLegacyResolutionQueueItem;
  app: ComplianceQueueAppRow | null;
  latestRevision: LatestRevisionRow | null;
}): FleetComplianceDraftQueueState {
  const active = input.app?.configRevisions[0] ?? null;
  const parsedPayload = configRevisionPayloadSchema.safeParse(active?.payload);
  const activePayload = parsedPayload.success ? parsedPayload.data : { schemaVersion: 1, markets: [] };
  const enabledMarkets = parsedPayload.success
    ? parsedPayload.data.markets
        .filter((market) => market.enabled)
        .map((market) => market.market)
        .sort()
    : [];
  const currentSourceSha = input.app?.discoveryObservations[0]?.sourceSha ?? null;
  const blockers: FleetComplianceDraftBlocker[] = [
    ...(
      input.app?.repoId?.toString() !== input.legacy.repoId
      || input.app?.repoFullName !== input.legacy.repoFullName
      || !input.app?.slug
        ? ["APP_IDENTITY_CHANGED" as const]
        : []
    ),
    ...(!active ? ["ACTIVE_CONFIG_MISSING" as const] : []),
    ...(active && !parsedPayload.success ? ["ACTIVE_PAYLOAD_INVALID" as const] : []),
    ...(parsedPayload.success
      && (parsedPayload.data.complianceDrafts?.length ?? 0) > 0
      && (active?.complianceProfiles.length ?? 0) === 0
      ? ["ACTIVE_COMPLIANCE_PROJECTION_DRIFT" as const]
      : []),
    ...(active && active.revision !== input.legacy.activeConfigRevision
      ? ["ACTIVE_REVISION_CHANGED" as const]
      : []),
    ...(!currentSourceSha ? ["CURRENT_DISCOVERY_MISSING" as const] : []),
    ...(currentSourceSha && currentSourceSha !== input.legacy.sourceSha
      ? ["SOURCE_SHA_CHANGED" as const]
      : []),
    ...(enabledMarkets.length === 0 ? ["ENABLED_MARKET_MISSING" as const] : []),
    ...(active && input.latestRevision?.revision !== active.revision
      ? ["LATEST_DRAFT_EXISTS" as const]
      : []),
  ];

  return {
    appId: input.legacy.appId,
    appSlug: input.app?.slug ?? "",
    repoId: input.legacy.repoId,
    repoFullName: input.legacy.repoFullName,
    sourceSha: input.legacy.sourceSha,
    activeConfigRevision: input.legacy.activeConfigRevision ?? 0,
    latestConfigRevision: input.latestRevision?.revision ?? 0,
    enabledMarkets,
    reasonCodes: input.legacy.reasonCodes,
    credentialBindingRequired: input.legacy.missingEvidenceKinds.includes("CREDENTIAL_BINDING"),
    eligible: blockers.length === 0,
    blockers,
    activePayload,
    latestRevisionState: input.latestRevision,
  };
}

export async function getFleetComplianceDraftQueueState(): Promise<FleetComplianceDraftQueueState[]> {
  const legacyQueue = (await getFleetLegacyResolutionQueue()).filter((item) => (
    item.missingEvidenceKinds.includes("COMPLIANCE_PROFILE")
  ));
  if (legacyQueue.length === 0) return [];
  const appIds = legacyQueue.map((item) => item.appId);
  const [apps, maxRevisions] = await Promise.all([
    prisma.app.findMany({
      where: { id: { in: appIds } },
      select: {
        id: true,
        slug: true,
        repoId: true,
        repoFullName: true,
        configRevisions: {
          where: { status: "ACTIVE" },
          orderBy: { revision: "desc" },
          take: 1,
          select: {
            revision: true,
            payload: true,
            complianceProfiles: { take: 1, select: { id: true } },
          },
        },
        discoveryObservations: {
          orderBy: latestDiscoveryObservationOrder(),
          take: 1,
          select: { sourceSha: true },
        },
      },
    }),
    prisma.configRevision.groupBy({
      by: ["appId"],
      where: { appId: { in: appIds } },
      _max: { revision: true },
    }),
  ]);
  const latestKeys = maxRevisions.flatMap((row) => (
    row._max.revision === null ? [] : [{ appId: row.appId, revision: row._max.revision }]
  ));
  const latestRevisions = latestKeys.length === 0
    ? []
    : await prisma.configRevision.findMany({
        where: { OR: latestKeys },
        select: {
          appId: true,
          revision: true,
          status: true,
          idempotencyKey: true,
          payloadHash: true,
        },
      });
  const appById = new Map(apps.map((app) => [app.id, app]));
  const latestByAppId = new Map(latestRevisions.map((revision) => [revision.appId, revision]));

  return legacyQueue.map((legacy) => projectFleetComplianceDraftQueueItem({
    legacy,
    app: appById.get(legacy.appId) ?? null,
    latestRevision: latestByAppId.get(legacy.appId) ?? null,
  }));
}

export async function getFleetComplianceDraftQueue(): Promise<FleetComplianceDraftQueueItem[]> {
  return (await getFleetComplianceDraftQueueState()).map(publicFleetComplianceDraftQueueItem);
}

export function publicFleetComplianceDraftQueueItem(
  item: FleetComplianceDraftQueueState,
): FleetComplianceDraftQueueItem {
  return {
    appId: item.appId,
    repoId: item.repoId,
    repoFullName: item.repoFullName,
    sourceSha: item.sourceSha,
    activeConfigRevision: item.activeConfigRevision,
    latestConfigRevision: item.latestConfigRevision,
    enabledMarkets: item.enabledMarkets,
    reasonCodes: item.reasonCodes,
    credentialBindingRequired: item.credentialBindingRequired,
    eligible: item.eligible,
    blockers: item.blockers,
  };
}
