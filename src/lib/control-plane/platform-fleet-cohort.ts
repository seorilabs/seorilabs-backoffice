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

export type ExactManagedPlatformConsumer = {
  app: {
    id: string;
    repoId: bigint;
    repoFullName: string;
    status: "ACTIVE" | "PAUSED" | "DEPRECATED";
    engine: "RN" | "GODOT";
  };
  registration: {
    repoId: bigint;
    repoFullName: string;
    archived: boolean;
    status: string;
    managementKind: string | null;
    classification: string | null;
    lastDefaultPushSha: string | null;
    lastReconciledSha: string | null;
  };
  discovery: {
    id: string;
    appId: string;
    sourceSha: string;
    payload: Prisma.JsonValue;
    payloadHash: string;
    observedAt: Date;
  };
};

/**
 * Platform Fleet의 단일 consumer cohort 정본이다.
 *
 * App lifecycle 상태는 배포/운영 상태일 뿐 Platform 탑재 의무를 해제하지 않는다.
 * 따라서 PRODUCT_APP으로 분류되고 exact MANAGED discovery가 있는 비보관 repository를
 * 기준으로 삼으며, legacy App row만 존재하는 repository는 포함하지 않는다.
 */
export async function loadExactManagedPlatformConsumers(
  client: PlatformFleetCohortClient = prisma,
): Promise<ExactManagedPlatformConsumer[]> {
  const registrations = await client.repositoryRegistration.findMany({
    where: {
      archived: false,
      status: "MANAGED",
      classification: "PRODUCT_APP",
    },
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
    },
  });
  const apps = await client.app.findMany({
    where: { repoId: { in: registrations.map(({ repoId }) => repoId) } },
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
  const appByRepo = new Map(apps.flatMap((app) => (
    app.repoId === null ? [] : [[app.repoId.toString(), app] as const]
  )));

  return registrations.map((registration) => {
    const app = appByRepo.get(registration.repoId.toString());
    const discovery = app?.discoveryObservations[0];
    if (
      !app
      || app.repoId === null
      || app.repoFullName.toLowerCase() !== registration.repoFullName.toLowerCase()
    ) {
      throw new ControlPlaneError(
        `PRODUCT_APP ${registration.repoFullName}의 App binding이 완료되지 않았습니다.`,
        409,
        "PLATFORM_PRODUCT_APP_BINDING_INCOMPLETE",
      );
    }
    if (
      !discovery
      || !repositorySourceIsCurrent(registration, discovery.sourceSha)
      || discovery.appId !== app.id
      || jsonDigest(discovery.payload as JsonValue) !== discovery.payloadHash
    ) {
      throw new ControlPlaneError(
        `PRODUCT_APP ${registration.repoFullName}의 exact discovery가 완료되지 않았습니다.`,
        409,
        "PLATFORM_DISCOVERY_COHORT_INCOMPLETE",
      );
    }
    return {
      app: {
        id: app.id,
        repoId: app.repoId,
        repoFullName: app.repoFullName,
        status: app.status,
        engine: app.engine,
      },
      registration,
      discovery,
    };
  });
}
