import type { Prisma } from "@prisma/client";

import { visibleAppWhere } from "@/lib/domain/app-visibility";
import {
  reauthPublicReason,
  redactCredentialCandidates,
} from "@/lib/control-plane/contracts";
import { latestDiscoveryObservationOrder } from "@/lib/control-plane/discovery-order";
import { repositorySourceIsCurrent } from "@/lib/control-plane/repository-registration";
import { prisma } from "@/lib/prisma";

const fleetConfigRevisionSelect = {
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
} satisfies Prisma.ConfigRevisionSelect;

export function visibleFleetConfigRevisions<T extends { revision: number }>(
  drafts: T[],
  active: T | null,
): T[] {
  return [...drafts, ...(active ? [active] : [])]
    .sort((left, right) => right.revision - left.revision);
}

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
      buildTargets: {
        orderBy: { targetKey: "asc" },
        select: { id: true, targetKey: true },
      },
      externalBindings: {
        orderBy: [{ provider: "asc" }, { bindingType: "asc" }],
        select: { id: true, provider: true, bindingType: true },
      },
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
        where: { status: "DRAFT" },
        orderBy: { revision: "desc" },
        take: 12,
        select: fleetConfigRevisionSelect,
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
          reasonCodes: true,
          reasonCodesDigest: true,
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
              legacyConfigResolutionId: true,
              observedBy: true,
              observedAt: true,
            },
          },
        },
      },
      legacyConfigResolutions: {
        orderBy: [{ createdAt: "desc" }, { revision: "desc" }],
        take: 30,
        select: {
          id: true,
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
          resolutionDigest: true,
          createdBy: true,
          createdAt: true,
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
        orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
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
      providerExecutions: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
        select: {
          id: true,
          repoId: true,
          sourceSha: true,
          configRevisionNumber: true,
          releaseCandidateId: true,
          kind: true,
          operation: true,
          actionClass: true,
          provider: true,
          resourceType: true,
          resourceId: true,
          desiredHash: true,
          expectedPublicIdentity: true,
          publicAccountId: true,
          credentialPublicIdentity: true,
          logicalCredentialId: true,
          credentialGeneration: true,
          policyGeneration: true,
          capability: true,
          adapterId: true,
          origin: true,
          readbackCredentialPublicIdentity: true,
          readbackLogicalCredentialId: true,
          readbackCredentialGeneration: true,
          readbackPolicyGeneration: true,
          readbackCapability: true,
          bindingHash: true,
          status: true,
          attempts: true,
          readbackAttempts: true,
          maxAttempts: true,
          leaseGeneration: true,
          workerId: true,
          leaseExpiresAt: true,
          readbackRequiredAt: true,
          approvedBy: true,
          approvalExpiresAt: true,
          lastErrorCode: true,
          lastObservationId: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      platformFleetBinding: {
        select: {
          platformReleaseId: true,
          observedVersion: true,
          observedDigest: true,
          approvedVersion: true,
          approvedDigest: true,
          manifestDigest: true,
          contractRevision: true,
          state: true,
          sourceSha: true,
          latestPlanKind: true,
          pullRequestNumber: true,
          pullRequestUrl: true,
          issueNumber: true,
          issueUrl: true,
          exceptionExpiresAt: true,
          updatedAt: true,
        },
      },
      platformFleetPlans: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
        select: {
          id: true,
          sourceSha: true,
          kind: true,
          status: true,
          desiredHash: true,
          discoveryObservationId: true,
          providerObservationId: true,
          agentRunId: true,
          githubNumber: true,
          githubUrl: true,
          attempts: true,
          lastError: true,
          readbackRequestedAt: true,
          appliedAt: true,
          createdAt: true,
          updatedAt: true,
          platformRelease: {
            select: {
              version: true,
              classification: true,
              approval: true,
              contractRevision: true,
              manifestDigest: true,
              publishedAt: true,
            },
          },
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
          credentialGeneration: true,
          policyGeneration: true,
          adapterId: true,
          origin: true,
          authFactors: true,
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
          workflowBundleDigest: true,
          platformVersion: true,
          status: true,
          createdBy: true,
          createdAt: true,
          configRevision: { select: { revision: true } },
          gateObservations: {
            orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
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

  const [recentRuns, deadLetters, repositoryRegistration, activeConfigRevision] = await Promise.all([
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
    app.repoId === null
      ? Promise.resolve(null)
      : prisma.repositoryRegistration.findUnique({
          where: { repoId: app.repoId },
          select: {
            status: true,
            archived: true,
            managementKind: true,
            classification: true,
            discoveryContractVersion: true,
            lastDefaultPushSha: true,
            lastReconciledSha: true,
            lastDiscoveryReason: true,
          },
        }),
    prisma.configRevision.findFirst({
      where: { appId: app.id, status: "ACTIVE" },
      orderBy: { revision: "desc" },
      select: fleetConfigRevisionSelect,
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
    repositoryRegistration,
    discoveryCurrent: Boolean(
      repositoryRegistration
      && repositorySourceIsCurrent(repositoryRegistration, app.discoveryObservations[0]?.sourceSha ?? null),
    ),
    discoveryObservations: app.discoveryObservations.map((observation) => ({
      ...observation,
      payload: redactFleetJson(observation.payload),
    })),
    configRevisions: visibleFleetConfigRevisions(app.configRevisions, activeConfigRevision).map((revision) => ({
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
    providerExecutions: app.providerExecutions.map((execution) => ({
      ...execution,
      repoId: execution.repoId.toString(),
    })),
    platformFleetPlans: app.platformFleetPlans.map((plan) => ({
      ...plan,
      lastError: redactFleetError(plan.lastError),
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
