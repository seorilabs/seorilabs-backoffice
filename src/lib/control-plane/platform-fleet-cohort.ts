import type { Prisma } from "@prisma/client";

import { latestDiscoveryObservationOrder } from "@/lib/control-plane/discovery-order";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { repositorySourceIsCurrent } from "@/lib/control-plane/repository-registration";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

type PlatformFleetCohortClient = Pick<
  Prisma.TransactionClient,
  "app" | "repositoryRegistration"
>;

type PlatformFleetCohortRegistration = {
  repoId: bigint;
  repoFullName: string;
  archived: boolean;
  status: string;
  managementKind: string | null;
  classification: string | null;
  lastDefaultPushSha: string | null;
  lastReconciledSha: string | null;
  lastDiscoveryReason: string | null;
};

type PlatformFleetCohortDiscovery = {
  id: string;
  appId: string;
  sourceSha: string;
  payload: Prisma.JsonValue;
  payloadHash: string;
  observedAt: Date;
};

type PlatformFleetCohortApp = {
  id: string;
  repoId: bigint | null;
  repoFullName: string;
  status: "ACTIVE" | "PAUSED" | "DEPRECATED";
  engine: "RN" | "GODOT";
  discoveryObservations: PlatformFleetCohortDiscovery[];
};

export type ExactManagedPlatformConsumer = {
  app: {
    id: string;
    repoId: bigint;
    repoFullName: string;
    status: "ACTIVE";
    engine: "RN" | "GODOT";
  };
  registration: PlatformFleetCohortRegistration;
  discovery: PlatformFleetCohortDiscovery;
};

export type PlatformFleetCohortBlockerReason =
  | "APP_BINDING_INCOMPLETE"
  | "REGISTRATION_NEEDS_INPUT"
  | "REGISTRATION_NOT_MANAGED"
  | "DISCOVERY_MISSING"
  | "DISCOVERY_STALE"
  | "DISCOVERY_IDENTITY_MISMATCH"
  | "DISCOVERY_TAMPERED";

export type PlatformFleetCohortBlocker = {
  repoId: string;
  repoFullName: string;
  reason: PlatformFleetCohortBlockerReason;
  registrationStatus: string;
  discoveryReason: string | null;
};

export type PlatformFleetCohortCoverage = {
  denominator: number;
  ready: number;
  blocked: number;
  reasonCounts: Record<PlatformFleetCohortBlockerReason, number>;
  blockers: PlatformFleetCohortBlocker[];
  consumers: ExactManagedPlatformConsumer[];
};

const BLOCKER_REASONS: PlatformFleetCohortBlockerReason[] = [
  "APP_BINDING_INCOMPLETE",
  "REGISTRATION_NEEDS_INPUT",
  "REGISTRATION_NOT_MANAGED",
  "DISCOVERY_MISSING",
  "DISCOVERY_STALE",
  "DISCOVERY_IDENTITY_MISMATCH",
  "DISCOVERY_TAMPERED",
];

function emptyReasonCounts(): Record<PlatformFleetCohortBlockerReason, number> {
  return Object.fromEntries(BLOCKER_REASONS.map((reason) => [reason, 0])) as Record<
    PlatformFleetCohortBlockerReason,
    number
  >;
}

/**
 * Platform Fleet의 reconcile-time selector를 공개 coverage로 계산한다.
 *
 * 분모는 ACTIVE App에 exact numeric repository binding이 있고, 그 repository가
 * non-archived PRODUCT_APP으로 분류된 경우뿐이다. 등록 readiness가 NEEDS_INPUT인
 * 앱과 discovery가 없는 앱은 분모에서 숨기지 않고 서로 다른 blocker로 남긴다.
 */
export function resolvePlatformFleetConsumerCoverage(input: {
  apps: PlatformFleetCohortApp[];
  registrations: PlatformFleetCohortRegistration[];
}): PlatformFleetCohortCoverage {
  const registrationByRepo = new Map(
    input.registrations.map((registration) => [registration.repoId.toString(), registration] as const),
  );
  const reasonCounts = emptyReasonCounts();
  const blockers: PlatformFleetCohortBlocker[] = [];
  const consumers: ExactManagedPlatformConsumer[] = [];
  let denominator = 0;

  const block = (
    app: PlatformFleetCohortApp,
    registration: PlatformFleetCohortRegistration,
    reason: PlatformFleetCohortBlockerReason,
  ) => {
    reasonCounts[reason] += 1;
    blockers.push({
      repoId: registration.repoId.toString(),
      repoFullName: app.repoFullName,
      reason,
      registrationStatus: registration.status,
      discoveryReason: registration.lastDiscoveryReason,
    });
  };

  for (const app of [...input.apps].sort((left, right) => (
    (left.repoId ?? 0n) < (right.repoId ?? 0n) ? -1 : (left.repoId ?? 0n) > (right.repoId ?? 0n) ? 1 : 0
  ))) {
    if (app.status !== "ACTIVE" || app.repoId === null) continue;
    const registration = registrationByRepo.get(app.repoId.toString());
    if (
      !registration
      || registration.archived
      || registration.classification !== "PRODUCT_APP"
    ) continue;

    denominator += 1;
    if (registration.repoFullName.toLowerCase() !== app.repoFullName.toLowerCase()) {
      block(app, registration, "APP_BINDING_INCOMPLETE");
      continue;
    }
    if (registration.status === "NEEDS_INPUT") {
      block(app, registration, "REGISTRATION_NEEDS_INPUT");
      continue;
    }
    if (registration.status !== "MANAGED") {
      block(app, registration, "REGISTRATION_NOT_MANAGED");
      continue;
    }

    const discovery = app.discoveryObservations[0];
    if (!discovery) {
      block(app, registration, "DISCOVERY_MISSING");
      continue;
    }
    if (discovery.appId !== app.id) {
      block(app, registration, "DISCOVERY_IDENTITY_MISMATCH");
      continue;
    }
    if (jsonDigest(discovery.payload as JsonValue) !== discovery.payloadHash) {
      block(app, registration, "DISCOVERY_TAMPERED");
      continue;
    }
    if (!repositorySourceIsCurrent(registration, discovery.sourceSha)) {
      block(app, registration, "DISCOVERY_STALE");
      continue;
    }

    consumers.push({
      app: {
        id: app.id,
        repoId: app.repoId,
        repoFullName: app.repoFullName,
        status: "ACTIVE",
        engine: app.engine,
      },
      registration,
      discovery,
    });
  }

  return {
    denominator,
    ready: consumers.length,
    blocked: blockers.length,
    reasonCounts,
    blockers,
    consumers,
  };
}

/**
 * Platform Fleet의 단일 consumer cohort 정본이다. 실제 fanout에는 coverage가 완전한
 * ACTIVE PRODUCT_APP만 넘기며, blocker가 하나라도 있으면 부분 fanout을 금지한다.
 */
export async function loadPlatformFleetConsumerCoverage(
  client: PlatformFleetCohortClient = prisma,
): Promise<PlatformFleetCohortCoverage> {
  const apps = await client.app.findMany({
    where: { status: "ACTIVE", repoId: { not: null } },
    orderBy: [{ repoId: "asc" }, { id: "asc" }],
    select: {
      id: true,
      repoId: true,
      repoFullName: true,
      status: true,
      engine: true,
      discoveryObservations: {
        orderBy: latestDiscoveryObservationOrder(),
        take: 1,
        select: {
          id: true,
          appId: true,
          sourceSha: true,
          payload: true,
          payloadHash: true,
          observedAt: true,
        },
      },
    },
  });
  const registrations = await client.repositoryRegistration.findMany({
    where: { repoId: { in: apps.flatMap(({ repoId }) => repoId === null ? [] : [repoId]) } },
    orderBy: [{ repoId: "asc" }],
    select: {
      repoId: true,
      repoFullName: true,
      archived: true,
      status: true,
      managementKind: true,
      classification: true,
      lastDefaultPushSha: true,
      lastReconciledSha: true,
      lastDiscoveryReason: true,
    },
  });
  return resolvePlatformFleetConsumerCoverage({ apps, registrations });
}

export async function loadExactManagedPlatformConsumers(
  client: PlatformFleetCohortClient = prisma,
): Promise<ExactManagedPlatformConsumer[]> {
  const coverage = await loadPlatformFleetConsumerCoverage(client);
  if (coverage.blocked > 0) {
    const reasons = BLOCKER_REASONS
      .filter((reason) => coverage.reasonCounts[reason] > 0)
      .map((reason) => `${reason}=${coverage.reasonCounts[reason]}`)
      .join(",");
    throw new ControlPlaneError(
      `Platform Fleet ACTIVE PRODUCT_APP coverage가 완전하지 않습니다: denominator=${coverage.denominator},ready=${coverage.ready},blocked=${coverage.blocked};${reasons}`,
      409,
      "PLATFORM_DISCOVERY_COHORT_INCOMPLETE",
    );
  }
  return coverage.consumers;
}
