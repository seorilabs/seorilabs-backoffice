import { jsonDigest, verifySnapshot, type JsonValue } from "@/lib/control-plane/json";
import {
  assertFullOrganizationInstallation,
  listInstallationRepositorySeeds,
  readInstalledRepositoryVector,
  type RepositoryInventoryClient,
  type RepositoryInventorySeed,
  type RepositoryReadbackVector,
} from "@/lib/control-plane/repository-discovery-backfill";
import { prisma } from "@/lib/prisma";

export const FLEET_MIGRATION_SHADOW_READINESS_CONTRACT_VERSION =
  "fleet-migration-shadow-readiness/v1" as const;

const ORGANIZATION = "seorilabs";
const SHA_40 = /^[0-9a-f]{40}$/;
const DIGEST_64 = /^[0-9a-f]{64}$/;
const CLASSIFICATION_DECISION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

type RepositoryClassification =
  | "PRODUCT_APP"
  | "INFRA_REPO"
  | "PLATFORM_PRODUCER"
  | "EXCLUDED";

export type FleetMigrationShadowReasonCode =
  | "ACTIVE_CONFIG_MISSING"
  | "ACTIVE_CONFIG_SOURCE_MISMATCH"
  | "ACTIVE_SNAPSHOT_INVALID"
  | "ACTIVE_SNAPSHOT_MISSING"
  | "APP_BINDING_MISMATCH"
  | "APP_BINDING_MISSING"
  | "CLASSIFICATION_DECISION_DRIFT"
  | "CLASSIFICATION_DECISION_INVALID"
  | "CLASSIFICATION_DECISION_MISSING"
  | "CLASSIFICATION_MISSING"
  | "DISCOVERY_SOURCE_MISMATCH"
  | "FORK_CLASSIFICATION_INVALID"
  | "NON_PRODUCT_APP_BINDING_PRESENT"
  | "PLATFORM_FLEET_BINDING_MISSING"
  | "PLATFORM_FLEET_BINDING_NOT_COMPLIANT"
  | "PLATFORM_FLEET_BINDING_SOURCE_MISMATCH"
  | "REPOSITORY_IDENTITY_MISMATCH"
  | "REPOSITORY_NOT_MANAGED"
  | "REPOSITORY_REGISTRATION_MISSING"
  | "SOURCE_HEAD_MISSING";

export interface FleetMigrationClassificationDecisionReadback {
  id: string;
  revision: number;
  classification: RepositoryClassification;
}

export interface FleetMigrationRepositoryRegistrationReadback {
  repoId: string;
  repoFullName: string;
  status: "REGISTERED" | "NEEDS_INPUT" | "MANAGED" | "ARCHIVED";
  classification: RepositoryClassification | null;
  classificationDecisionVersion: number;
  decision: FleetMigrationClassificationDecisionReadback | null;
}

export interface FleetMigrationAppReadback {
  id: string;
  repoId: string;
  repoFullName: string;
  latestDiscovery: { id: string; sourceSha: string } | null;
  activeConfigs: Array<{
    id: string;
    sourceObservationId: string | null;
    activatedSnapshot: JsonValue | null;
    snapshotDigest: string | null;
    snapshotSignature: string | null;
    activatedAt: string | null;
  }>;
  platformFleetBinding: {
    id: string;
    sourceSha: string | null;
    state: string;
  } | null;
  activeCredentialBindingCount: number;
}

export interface FleetMigrationBackofficeReadback {
  registrations: FleetMigrationRepositoryRegistrationReadback[];
  apps: FleetMigrationAppReadback[];
}

interface InstallationPublicIdentity {
  appId: string;
  installationId: string;
  targetId: string;
  accountLogin: string;
  targetType: string;
  repositorySelection: string;
  suspended: boolean;
}

export interface FleetMigrationShadowReadinessDependencies {
  getInstallationContext: () => Promise<{
    client: RepositoryInventoryClient;
    publicIdentity: InstallationPublicIdentity;
  }>;
  listRepositories: (
    client: RepositoryInventoryClient,
  ) => Promise<RepositoryInventorySeed[]>;
  readRepository: (
    client: RepositoryInventoryClient,
    organization: string,
    seed: RepositoryInventorySeed,
  ) => Promise<RepositoryReadbackVector>;
  readBackoffice: (repositoryIds: bigint[]) => Promise<FleetMigrationBackofficeReadback>;
  verifyConfigSnapshot: (
    snapshot: JsonValue,
    digest: string,
    signature: string,
  ) => boolean;
  now: () => Date;
}

async function readBackoffice(repositoryIds: bigint[]): Promise<FleetMigrationBackofficeReadback> {
  const [registrations, apps] = await Promise.all([
    prisma.repositoryRegistration.findMany({
      where: { repoId: { in: repositoryIds } },
      orderBy: { repoId: "asc" },
      select: {
        repoId: true,
        repoFullName: true,
        status: true,
        classification: true,
        classificationDecisionVersion: true,
        classificationDecisions: {
          orderBy: { revision: "desc" },
          take: 1,
          select: { id: true, revision: true, classification: true },
        },
      },
    }),
    prisma.app.findMany({
      where: { status: "ACTIVE", repoId: { in: repositoryIds } },
      orderBy: { repoId: "asc" },
      select: {
        id: true,
        repoId: true,
        repoFullName: true,
        discoveryObservations: {
          orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }],
          take: 1,
          select: { id: true, sourceSha: true },
        },
        configRevisions: {
          where: { status: "ACTIVE" },
          orderBy: { revision: "desc" },
          take: 2,
          select: {
            id: true,
            sourceObservationId: true,
            activatedSnapshot: true,
            snapshotDigest: true,
            snapshotSignature: true,
            activatedAt: true,
          },
        },
        platformFleetBinding: {
          select: { id: true, sourceSha: true, state: true },
        },
        _count: {
          select: {
            credentialBindings: { where: { status: "ACTIVE" } },
          },
        },
      },
    }),
  ]);
  return {
    registrations: registrations.map((registration) => ({
      repoId: registration.repoId.toString(),
      repoFullName: registration.repoFullName,
      status: registration.status,
      classification: registration.classification,
      classificationDecisionVersion:
        registration.classificationDecisionVersion ?? 0,
      decision: registration.classificationDecisions[0] ?? null,
    })),
    apps: apps.flatMap((app) => app.repoId === null ? [] : [{
      id: app.id,
      repoId: app.repoId.toString(),
      repoFullName: app.repoFullName,
      latestDiscovery: app.discoveryObservations[0] ?? null,
      activeConfigs: app.configRevisions.map((revision) => ({
        id: revision.id,
        sourceObservationId: revision.sourceObservationId,
        activatedSnapshot: revision.activatedSnapshot as JsonValue | null,
        snapshotDigest: revision.snapshotDigest,
        snapshotSignature: revision.snapshotSignature,
        activatedAt: revision.activatedAt?.toISOString() ?? null,
      })),
      platformFleetBinding: app.platformFleetBinding,
      activeCredentialBindingCount: app._count.credentialBindings,
    }]),
  };
}

const defaultDependencies: FleetMigrationShadowReadinessDependencies = {
  getInstallationContext: async () => {
    const { getInstallationContext } = await import("@/lib/github/app");
    const context = await getInstallationContext();
    return {
      client: context.octokit as unknown as RepositoryInventoryClient,
      publicIdentity: {
        appId: context.publicState.appId,
        installationId: context.publicState.installationId,
        targetId: context.publicState.targetId,
        accountLogin: context.publicState.accountLogin,
        targetType: context.publicState.targetType,
        repositorySelection: context.publicState.repositorySelection,
        suspended: context.publicState.suspended,
      },
    };
  },
  listRepositories: (client) => listInstallationRepositorySeeds(client),
  readRepository: readInstalledRepositoryVector,
  readBackoffice,
  verifyConfigSnapshot: (snapshot, digest, signature) => verifySnapshot(
    snapshot,
    process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "",
    digest,
    signature,
  ),
  now: () => new Date(),
};

function canonicalRepositoryVector(vector: RepositoryReadbackVector): JsonValue {
  return {
    repoId: String(vector.repoId),
    repoFullName: vector.repoFullName,
    defaultBranch: vector.defaultBranch,
    archived: vector.archived,
    private: vector.private,
    fork: vector.fork,
    sourceSha: vector.headSha,
  };
}

function repositoryReasons(
  vector: RepositoryReadbackVector,
  registration: FleetMigrationRepositoryRegistrationReadback | undefined,
  app: FleetMigrationAppReadback | undefined,
  verifyConfigSnapshot: FleetMigrationShadowReadinessDependencies["verifyConfigSnapshot"],
): FleetMigrationShadowReasonCode[] {
  const reasons: FleetMigrationShadowReasonCode[] = [];
  if (!vector.headSha || !SHA_40.test(vector.headSha)) {
    reasons.push("SOURCE_HEAD_MISSING");
  }
  if (!registration) {
    reasons.push("REPOSITORY_REGISTRATION_MISSING");
    return reasons;
  }
  if (registration.repoFullName !== vector.repoFullName) {
    reasons.push("REPOSITORY_IDENTITY_MISMATCH");
  }
  if (registration.status !== "MANAGED") {
    reasons.push("REPOSITORY_NOT_MANAGED");
  }
  if (!registration.classification) {
    reasons.push("CLASSIFICATION_MISSING");
  }
  if (!registration.decision) {
    reasons.push("CLASSIFICATION_DECISION_MISSING");
  } else if (
    !Number.isSafeInteger(registration.classificationDecisionVersion)
    || registration.classificationDecisionVersion < 1
    || !Number.isSafeInteger(registration.decision.revision)
    || registration.decision.revision < 1
    || !CLASSIFICATION_DECISION_ID.test(registration.decision.id)
  ) {
    reasons.push("CLASSIFICATION_DECISION_INVALID");
  } else if (
    registration.decision.revision !== registration.classificationDecisionVersion
    || registration.decision.classification !== registration.classification
  ) {
    reasons.push("CLASSIFICATION_DECISION_DRIFT");
  }
  if (vector.fork && registration.classification !== "EXCLUDED") {
    reasons.push("FORK_CLASSIFICATION_INVALID");
  }
  if (registration.classification !== "PRODUCT_APP") {
    if (app) reasons.push("NON_PRODUCT_APP_BINDING_PRESENT");
    return reasons;
  }
  if (!app) {
    reasons.push("APP_BINDING_MISSING");
    return reasons;
  }
  if (app.repoFullName !== vector.repoFullName) {
    reasons.push("APP_BINDING_MISMATCH");
  }
  if (!app.latestDiscovery || app.latestDiscovery.sourceSha !== vector.headSha) {
    reasons.push("DISCOVERY_SOURCE_MISMATCH");
  }
  if (app.activeConfigs.length !== 1) {
    reasons.push("ACTIVE_CONFIG_MISSING");
  } else {
    const activeConfig = app.activeConfigs[0];
    if (
      !app.latestDiscovery
      || activeConfig.sourceObservationId !== app.latestDiscovery.id
    ) {
      reasons.push("ACTIVE_CONFIG_SOURCE_MISMATCH");
    }
    const snapshotMissing =
      activeConfig.activatedSnapshot === null
      || !DIGEST_64.test(activeConfig.snapshotDigest ?? "")
      || !DIGEST_64.test(activeConfig.snapshotSignature ?? "")
      || activeConfig.activatedAt === null;
    if (snapshotMissing) {
      reasons.push("ACTIVE_SNAPSHOT_MISSING");
    } else {
      let valid = false;
      try {
        valid = verifyConfigSnapshot(
          activeConfig.activatedSnapshot!,
          activeConfig.snapshotDigest!,
          activeConfig.snapshotSignature!,
        );
      } catch {
        valid = false;
      }
      if (!valid) reasons.push("ACTIVE_SNAPSHOT_INVALID");
    }
  }
  if (!app.platformFleetBinding) {
    reasons.push("PLATFORM_FLEET_BINDING_MISSING");
  } else {
    if (app.platformFleetBinding.sourceSha !== vector.headSha) {
      reasons.push("PLATFORM_FLEET_BINDING_SOURCE_MISMATCH");
    }
    if (app.platformFleetBinding.state !== "COMPLIANT") {
      reasons.push("PLATFORM_FLEET_BINDING_NOT_COMPLIANT");
    }
  }
  return reasons;
}

function exactSeedVector(seeds: RepositoryInventorySeed[]): string {
  return seeds.map(({ repoId }) => String(repoId)).join(",");
}

function exactRepositoryVector(vectors: RepositoryReadbackVector[]): string {
  return jsonDigest(vectors.map(canonicalRepositoryVector));
}

function exactBackofficeVector(readback: FleetMigrationBackofficeReadback): string {
  const compareRepoId = (left: { repoId: string }, right: { repoId: string }) => {
    const leftId = BigInt(left.repoId);
    const rightId = BigInt(right.repoId);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  };
  return jsonDigest({
    registrations: [...readback.registrations].sort(compareRepoId),
    apps: [...readback.apps].sort(compareRepoId),
  } as unknown as JsonValue);
}

export async function evaluateFleetMigrationShadowReadiness(
  dependencies: FleetMigrationShadowReadinessDependencies = defaultDependencies,
) {
  const { client, publicIdentity } = await dependencies.getInstallationContext();
  assertFullOrganizationInstallation({
    repositorySelection: publicIdentity.repositorySelection,
    targetType: publicIdentity.targetType,
    accountLogin: publicIdentity.accountLogin,
  }, ORGANIZATION);
  if (publicIdentity.suspended) {
    throw new Error("FLEET_MIGRATION_SHADOW_INSTALLATION_SUSPENDED");
  }

  const firstSeeds = await dependencies.listRepositories(client);
  const firstVectors: RepositoryReadbackVector[] = [];
  for (const seed of firstSeeds) {
    firstVectors.push(await dependencies.readRepository(client, ORGANIZATION, seed));
  }
  firstVectors.sort((left, right) => left.repoId - right.repoId);
  const activeVectors = firstVectors.filter((vector) => !vector.archived);
  const backoffice = await dependencies.readBackoffice(
    activeVectors.map(({ repoId }) => BigInt(repoId)),
  );

  const finalSeeds = await dependencies.listRepositories(client);
  if (exactSeedVector(firstSeeds) !== exactSeedVector(finalSeeds)) {
    throw new Error("FLEET_MIGRATION_SHADOW_PAGINATION_DRIFT");
  }
  const finalVectors: RepositoryReadbackVector[] = [];
  for (const seed of finalSeeds) {
    finalVectors.push(await dependencies.readRepository(client, ORGANIZATION, seed));
  }
  finalVectors.sort((left, right) => left.repoId - right.repoId);
  if (exactRepositoryVector(firstVectors) !== exactRepositoryVector(finalVectors)) {
    throw new Error("FLEET_MIGRATION_SHADOW_PROVIDER_VECTOR_DRIFT");
  }
  const finalBackoffice = await dependencies.readBackoffice(
    activeVectors.map(({ repoId }) => BigInt(repoId)),
  );
  if (exactBackofficeVector(backoffice) !== exactBackofficeVector(finalBackoffice)) {
    throw new Error("FLEET_MIGRATION_SHADOW_BACKOFFICE_VECTOR_DRIFT");
  }

  const registrations = new Map(
    backoffice.registrations.map((registration) => [registration.repoId, registration]),
  );
  const apps = new Map(backoffice.apps.map((app) => [app.repoId, app]));
  const repositories = activeVectors.map((vector) => {
    const repoId = String(vector.repoId);
    const registration = registrations.get(repoId);
    const app = apps.get(repoId);
    return {
      repoId,
      repoFullName: vector.repoFullName,
      sourceSha: vector.headSha,
      classification: registration?.classification ?? null,
      classificationDecisionRevision:
        registration?.classificationDecisionVersion ?? 0,
      activeCredentialBindingCount: app?.activeCredentialBindingCount ?? 0,
      reasonCodes: repositoryReasons(
        vector,
        registration,
        app,
        dependencies.verifyConfigSnapshot,
      ).sort(),
    };
  });
  const reasonCounts = Object.fromEntries(
    [...new Set(repositories.flatMap(({ reasonCodes }) => reasonCodes))]
      .sort()
      .map((reason) => [
        reason,
        repositories.filter(({ reasonCodes }) => reasonCodes.includes(reason)).length,
      ]),
  );
  const observedAt = dependencies.now();
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Error("FLEET_MIGRATION_SHADOW_TIME_INVALID");
  }
  const cohortDigest = jsonDigest({
    contractVersion: FLEET_MIGRATION_SHADOW_READINESS_CONTRACT_VERSION,
    organization: ORGANIZATION,
    installationId: publicIdentity.installationId,
    repositories: activeVectors.map(canonicalRepositoryVector),
  } as JsonValue);
  const evidenceDigest = jsonDigest({
    contractVersion: FLEET_MIGRATION_SHADOW_READINESS_CONTRACT_VERSION,
    cohortDigest,
    repositories,
  } as JsonValue);
  return {
    schemaVersion: 1 as const,
    contractVersion: FLEET_MIGRATION_SHADOW_READINESS_CONTRACT_VERSION,
    state: repositories.every(({ reasonCodes }) => reasonCodes.length === 0)
      ? "READY"
      : "BLOCKED",
    observedAt: observedAt.toISOString(),
    organization: {
      login: ORGANIZATION,
      targetId: publicIdentity.targetId,
    },
    githubApp: {
      appId: publicIdentity.appId,
      installationId: publicIdentity.installationId,
      repositorySelection: publicIdentity.repositorySelection,
    },
    providerRepositoryCount: firstSeeds.length,
    activeRepositoryCount: activeVectors.length,
    archivedRepositoryCount: firstSeeds.length - activeVectors.length,
    cohortDigest,
    evidenceDigest,
    reasonCounts,
    repositories,
  };
}
