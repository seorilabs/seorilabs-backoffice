import { visibleAppWhere } from "@/lib/domain/app-visibility";
import {
  reauthPublicReason,
  redactCredentialCandidates,
} from "@/lib/control-plane/contracts";
import { latestDiscoveryObservationOrder } from "@/lib/control-plane/discovery-order";
import { prisma } from "@/lib/prisma";

export function redactFleetError(value: string | null): string | null {
  if (!value) return value;
  return redactCredentialCandidates(value).slice(0, 1_000);
}

export function redactFleetJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFleetJson);
  if (typeof value === "string") return redactFleetError(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (/^(?:password|passwd|pwd|totp|totpseed|otp|otpseed|cookie|secret|credential|privatekey|apikey|recoverycode|accesstoken|refreshtoken|sessiontoken|leasetoken|idtoken|authorization|clientsecret)$/.test(normalized)) {
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
          projectBlueprint: {
            select: {
              schemaVersion: true,
              organizationId: true,
              folderId: true,
              billingAccountId: true,
              projectId: true,
              projectNumber: true,
              region: true,
              payloadHash: true,
            },
          },
          marketProfiles: {
            orderBy: { market: "asc" },
            select: { market: true, enabled: true, releaseChannel: true, locales: true },
          },
          marketLocalizations: {
            orderBy: [{ scopeKey: "asc" }, { locale: "asc" }],
            select: { market: true, locale: true, payloadHash: true },
          },
          complianceProfiles: {
            orderBy: [{ market: "asc" }, { declaration: "asc" }],
            select: { market: true, declaration: true, state: true, payloadHash: true },
          },
          storeAssets: {
            orderBy: [{ scopeKey: "asc" }, { kind: "asc" }, { objectKey: "asc" }],
            select: { market: true, kind: true, locale: true, objectKey: true, checksum: true },
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
      fleetParityWaveResults: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 8,
        select: {
          id: true,
          repoId: true,
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
          wave: {
            select: {
              id: true,
              status: true,
              cohortDigest: true,
              vectorDigest: true,
              evidenceDigest: true,
              resultCount: true,
              matchCount: true,
              consecutiveMatchCount: true,
              cleanupAllowed: true,
              observedBy: true,
              startedAt: true,
              completedAt: true,
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
          agentKind: true,
          model: true,
          configuration: true,
          enabled: true,
          pausedAt: true,
          cancelledAt: true,
          maxAttempts: true,
          updatedAt: true,
        },
      },
      fleetProjectProjections: {
        orderBy: { updatedAt: "desc" },
        take: 30,
        select: {
          id: true,
          projectNodeId: true,
          issueNumber: true,
          desired: true,
          observed: true,
          status: true,
          attempts: true,
          lastError: true,
          appliedAt: true,
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
      releaseCandidates: {
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          sourceSha: true,
          artifactChecksum: true,
          market: true,
          targetKey: true,
          artifactType: true,
          workflowBundleSha: true,
          platformVersion: true,
          status: true,
          createdBy: true,
          createdAt: true,
          configRevision: { select: { revision: true } },
          gateObservations: {
            orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }],
            take: 100,
            select: {
              id: true,
              gate: true,
              status: true,
              evidence: true,
              observedBy: true,
              observedAt: true,
            },
          },
        },
      },
      fleetLifecycleState: {
        select: {
          stage: true,
          sourceSha: true,
          generation: true,
          updatedAt: true,
          configRevision: { select: { revision: true } },
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
        readbackRequestedAt: true,
        attempts: true,
        maxAttempts: true,
        spentMicros: true,
        leaseGeneration: true,
        error: true,
        outcome: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
        occurrence: {
          select: {
            scheduledFor: true,
            definition: { select: { id: true, key: true, template: true, agentKind: true, model: true } },
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
        repoFullName: true,
        issueNumber: true,
        status: true,
        readbackRequestedAt: true,
        attempts: true,
        maxAttempts: true,
        spentMicros: true,
        leaseGeneration: true,
        error: true,
        outcome: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
        occurrence: {
          select: {
            scheduledFor: true,
            definition: { select: { id: true, key: true, template: true, agentKind: true, model: true } },
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
    fleetParityWaveResults: app.fleetParityWaveResults.map((result) => ({
      ...result,
      repoId: result.repoId.toString(),
    })),
    providerObservations: providerObservations.map((observation) => ({
      ...observation,
      payload: redactFleetJson(observation.payload),
    })),
    releaseCandidates: app.releaseCandidates.map((candidate) => ({
      ...candidate,
      gateObservations: candidate.gateObservations.map((observation) => ({
        ...observation,
        evidence: redactFleetJson(observation.evidence),
      })),
    })),
    reauthRequests: app.reauthRequests.map((request) => ({
      ...request,
      reason: reauthPublicReason(request.gate),
    })),
    fleetProjectProjections: app.fleetProjectProjections.map((projection) => ({
      ...projection,
      desired: redactFleetJson(projection.desired),
      observed: redactFleetJson(projection.observed),
      lastError: redactFleetError(projection.lastError),
    })),
    recentRuns: recentRuns.map((run) => ({
      ...run,
      spentMicros: Number(run.spentMicros ?? 0n),
      status: run.status === "FAILED" && run.readbackRequestedAt ? "READBACK_REQUIRED" : run.status,
      error: redactFleetError(run.error),
      outcome: redactFleetJson(run.outcome),
    })),
    deadLetters: deadLetters.map((run) => ({
      ...run,
      spentMicros: Number(run.spentMicros ?? 0n),
      error: redactFleetError(run.error),
      outcome: redactFleetJson(run.outcome),
    })),
  };
}

export type FleetOperationsView = NonNullable<Awaited<ReturnType<typeof getFleetOperationsView>>>;
