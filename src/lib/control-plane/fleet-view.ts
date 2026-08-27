import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { reauthPublicReason } from "@/lib/control-plane/contracts";
import { latestDiscoveryObservationOrder } from "@/lib/control-plane/discovery-order";
import { prisma } from "@/lib/prisma";

export function redactFleetError(value: string | null): string | null {
  if (!value) return value;
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/((?:password|totp|cookie|secret|api[_-]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[REDACTED]")
    .slice(0, 1_000);
}

export function redactFleetJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFleetJson);
  if (typeof value === "string") return redactFleetError(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (/(password|totp|cookie|secret|credential|privatekey|apikey|recoverycode)/.test(normalized)) {
      return [key, "[REDACTED]"];
    }
    return [key, redactFleetJson(child)];
  }));
}

/** Fleet 운영 화면 전용 read model. 모든 credential 조회는 공개 metadata select로 제한한다. */
export async function getFleetOperationsView(appId: string) {
  const app = await prisma.app.findFirst({
    where: { id: appId, ...visibleAppWhere },
    select: {
      id: true,
      repoId: true,
      repoFullName: true,
      discoveryObservations: {
        orderBy: latestDiscoveryObservationOrder(),
        take: 8,
        select: {
          id: true,
          sourceSha: true,
          sourceRef: true,
          workflowProfile: true,
          workflowPackageManager: true,
          workflowWorkingDirectory: true,
          payload: true,
          payloadHash: true,
          observedBy: true,
          observedAt: true,
        },
      },
      configRevisions: {
        where: { status: { in: ["ACTIVE", "DRAFT"] } },
        orderBy: { revision: "desc" },
        take: 12,
        select: {
          id: true,
          revision: true,
          status: true,
          payload: true,
          payloadHash: true,
          createdBy: true,
          createdAt: true,
          activatedAt: true,
          snapshotDigest: true,
          legacyConfigImport: {
            select: {
              id: true,
              status: true,
            },
          },
        },
      },
      legacyConfigImports: {
        orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        take: 8,
        select: {
          id: true,
          sourceSha: true,
          sourceRef: true,
          transformVersion: true,
          inputDigest: true,
          status: true,
          observedBy: true,
          observedAt: true,
          createdAt: true,
          configRevision: {
            select: {
              id: true,
              revision: true,
              status: true,
            },
          },
          sources: {
            orderBy: [{ sourceKind: "asc" }, { path: "asc" }],
            select: {
              id: true,
              repoId: true,
              repoFullName: true,
              sourceSha: true,
              sourceRef: true,
              sourceKind: true,
              path: true,
              blobSha: true,
              contentSha256: true,
              status: true,
              transformVersion: true,
              parsedPayloadHash: true,
              errorCode: true,
              observedAt: true,
            },
          },
          parityObservations: {
            orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
            take: 4,
            select: {
              id: true,
              appId: true,
              legacyImportId: true,
              configRevisionId: true,
              sourceSha: true,
              scope: true,
              contractVersion: true,
              status: true,
              legacyDigest: true,
              centralDigest: true,
              diff: true,
              observedBy: true,
              observedAt: true,
            },
          },
        },
      },
      providerObservations: {
        orderBy: { observedAt: "desc" },
        take: 100,
        select: {
          id: true,
          provider: true,
          resourceType: true,
          resourceId: true,
          payload: true,
          payloadHash: true,
          observedBy: true,
          observedAt: true,
        },
      },
      platformFleetBinding: {
        select: {
          observedVersion: true,
          approvedVersion: true,
          contractRevision: true,
          state: true,
          sourceSha: true,
          exceptionExpiresAt: true,
          updatedAt: true,
        },
      },
      credentialBindings: {
        orderBy: [{ provider: "asc" }, { capability: "asc" }],
        select: {
          id: true,
          logicalCredentialId: true,
          provider: true,
          capability: true,
          environment: true,
          publicIdentity: true,
          fingerprint: true,
          consumer: true,
          scope: true,
          status: true,
          observedAt: true,
        },
      },
      automationDefinitions: {
        orderBy: { key: "asc" },
        select: {
          id: true,
          key: true,
          template: true,
          schedule: true,
          enabled: true,
          maxAttempts: true,
          updatedAt: true,
        },
      },
      reauthRequests: {
        orderBy: { createdAt: "desc" },
        take: 30,
        select: {
          id: true,
          runId: true,
          provider: true,
          origin: true,
          publicAccountId: true,
          capability: true,
          gate: true,
          status: true,
          generation: true,
          requestedBy: true,
          trustedLocalRequestedBy: true,
          trustedLocalRequestedAt: true,
          createdAt: true,
        },
      },
    },
  });
  if (!app) return null;

  const [recentRuns, deadLetters] = await Promise.all([
    prisma.agentRun.findMany({
      where: { appId: app.id },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        repoFullName: true,
        issueNumber: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        leaseGeneration: true,
        error: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
        occurrence: {
          select: {
            scheduledFor: true,
            definition: { select: { key: true, template: true } },
          },
        },
        leases: {
          orderBy: { generation: "desc" },
          take: 1,
          select: {
            generation: true,
            workerId: true,
            expiresAt: true,
            heartbeatAt: true,
            revokedAt: true,
          },
        },
      },
    }),
    prisma.agentRun.findMany({
      where: { appId: app.id, status: "DEAD_LETTER" },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        id: true,
        issueNumber: true,
        attempts: true,
        maxAttempts: true,
        error: true,
        updatedAt: true,
        occurrence: { select: { definition: { select: { key: true } } } },
      },
    }),
  ]);

  const seenProviderResources = new Set<string>();
  const providerObservations = app.providerObservations.filter((observation) => {
    const key = `${observation.provider}:${observation.resourceType}:${observation.resourceId}`;
    if (seenProviderResources.has(key)) return false;
    seenProviderResources.add(key);
    return true;
  }).slice(0, 30);

  return {
    ...app,
    discoveryObservations: app.discoveryObservations.map((observation) => ({
      ...observation,
      payload: redactFleetJson(observation.payload),
    })),
    configRevisions: app.configRevisions.map((revision) => ({
      ...revision,
      payload: redactFleetJson(revision.payload),
    })),
    legacyConfigImports: app.legacyConfigImports.map((legacyImport) => ({
        ...legacyImport,
        sources: legacyImport.sources.map((source) => ({
          ...source,
          repoId: source.repoId?.toString() ?? null,
        })),
        parityObservations: legacyImport.parityObservations.map((observation) => ({
          ...observation,
          diff: redactFleetJson(observation.diff),
        })),
      })),
    providerObservations: providerObservations.map((observation) => ({
      ...observation,
      payload: redactFleetJson(observation.payload),
    })),
    reauthRequests: app.reauthRequests.map((request) => ({
      ...request,
      reason: reauthPublicReason(request.gate),
    })),
    recentRuns: recentRuns.map((run) => ({ ...run, error: redactFleetError(run.error) })),
    deadLetters: deadLetters.map((run) => ({ ...run, error: redactFleetError(run.error) })),
  };
}

export type FleetOperationsView = NonNullable<Awaited<ReturnType<typeof getFleetOperationsView>>>;
