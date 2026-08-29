import {
  Prisma,
  type RepositoryClassification,
  type RepositoryDiscoveryRunStatus,
} from "@prisma/client";

import {
  repositoryClassificationDecisionSchema,
  type RepositoryClassificationDecisionRequest,
} from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { registerRepositoryWebhookInTransaction } from "@/lib/control-plane/repository-registration";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

const ACTOR = /^[A-Za-z0-9_.:@/-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:/-]{8,191}$/;

export interface RepositoryClassificationQueueCandidate {
  profile: "react-native" | "capacitor" | "ait-web" | "godot";
  workingDirectory: string;
  markerPath: string;
}

export interface RepositoryClassificationQueueItem {
  repoId: string;
  repoFullName: string;
  mode: "DECIDE" | "RATIFY_CURRENT" | "CORRECT_POLICY";
  generation: number;
  decisionRevision: number;
  currentClassification: RepositoryClassification | null;
  currentCandidateMarkerPath: string | null;
  currentProductIdentity: {
    displayName: string;
    type: "APP" | "GAME";
    engine: "RN" | "GODOT";
  } | null;
  reasonCode: string | null;
  fork: boolean | null;
  candidates: RepositoryClassificationQueueCandidate[];
  updatedAt: string;
}

function safeMarkerPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function repositoryClassificationCandidates(
  value: unknown,
): RepositoryClassificationQueueCandidate[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const candidates = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return [];
  const parsed: RepositoryClassificationQueueCandidate[] = candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    const profile = item.profile;
    if (
      typeof profile !== "string"
      || !["react-native", "capacitor", "ait-web", "godot"].includes(profile)
      || typeof item.workingDirectory !== "string"
      || !safeMarkerPath(item.markerPath)
    ) return [];
    return [{
      profile: profile as RepositoryClassificationQueueCandidate["profile"],
      workingDirectory: item.workingDirectory,
      markerPath: item.markerPath,
    }];
  });
  return [...new Map(parsed.map((candidate) => [candidate.markerPath, candidate])).values()]
    .sort((left, right) => left.markerPath.localeCompare(right.markerPath));
}

interface RepositoryClassificationRatificationEvidence {
  expectedGeneration: number;
  expectedDecisionRevision: number;
  classification: RepositoryClassification;
  candidateMarkerPath: string | null;
  registration: {
    classification: RepositoryClassification | null;
    discoveryContractVersion: string | null;
    discoveryCandidates: unknown;
    lastDefaultPushSha: string | null;
    lastReconciledSha: string | null;
    reconcileGeneration: number | null;
  };
  latestDecision: { revision: number } | null;
  terminalRun: {
    id: string;
    generation: number;
    sourceSha: string | null;
    status: RepositoryDiscoveryRunStatus;
    classification: RepositoryClassification | null;
    contractVersion: string | null;
    candidateDigest: string | null;
    observationId: string | null;
    completedAt: Date | null;
  } | null;
}

function publicCandidateState(value: unknown): {
  contractVersion: string;
  sourceSha: string;
  classification: RepositoryClassification;
  candidates: RepositoryClassificationQueueCandidate[];
  candidateDigest: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (
    typeof state.contractVersion !== "string"
    || typeof state.sourceSha !== "string"
    || !["PRODUCT_APP", "INFRA_REPO", "PLATFORM_PRODUCER", "EXCLUDED"].includes(
      String(state.classification),
    )
    || !Array.isArray(state.candidates)
  ) return null;
  const candidates = repositoryClassificationCandidates(value);
  if (candidates.length !== state.candidates.length) return null;
  const exactCandidates = state.candidates.every((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const item = candidate as Record<string, unknown>;
    const keys = Object.keys(item).sort();
    const parsed = candidates[index];
    return keys.join(",") === "markerPath,profile,workingDirectory"
      && parsed?.profile === item.profile
      && parsed.workingDirectory === item.workingDirectory
      && parsed.markerPath === item.markerPath;
  });
  if (!exactCandidates) return null;
  return {
    contractVersion: state.contractVersion,
    sourceSha: state.sourceSha,
    classification: state.classification as RepositoryClassification,
    candidates,
    candidateDigest: jsonDigest(candidates as unknown as JsonValue),
  };
}

/**
 * 이미 terminal discovery로 관리 중인 repository에는 관측값과 같은 revision 1만
 * 추가할 수 있다. source, contract, candidate digest 중 하나라도 움직였으면 새
 * discovery가 먼저 끝나야 하며 ratification으로 상태를 덮어쓰지 않는다.
 */
export function validateCurrentRepositoryClassificationRatification(
  evidence: RepositoryClassificationRatificationEvidence,
): { terminalRunId: string; candidateDigest: string } {
  if (evidence.expectedDecisionRevision !== 0 || evidence.latestDecision !== null) {
    throw new ControlPlaneError(
      "이미 repository 분류 결정이 존재합니다.",
      409,
      "REPOSITORY_CLASSIFICATION_RATIFICATION_DECISION_EXISTS",
    );
  }
  if (evidence.registration.classification !== evidence.classification) {
    throw new ControlPlaneError(
      "현재 repository 분류와 ratification 요청이 다릅니다.",
      409,
      "REPOSITORY_CLASSIFICATION_RATIFICATION_MISMATCH",
    );
  }
  const state = publicCandidateState(evidence.registration.discoveryCandidates);
  const run = evidence.terminalRun;
  const sourceSha = evidence.registration.lastReconciledSha;
  if (
    !state
    || !run
    || run.completedAt === null
    || run.generation !== evidence.expectedGeneration
    || evidence.registration.reconcileGeneration !== evidence.expectedGeneration
    || sourceSha === null
    || evidence.registration.lastDefaultPushSha !== sourceSha
    || run.sourceSha !== sourceSha
    || state.sourceSha !== sourceSha
    || evidence.registration.discoveryContractVersion === null
    || run.contractVersion !== evidence.registration.discoveryContractVersion
    || state.contractVersion !== evidence.registration.discoveryContractVersion
    || run.classification !== evidence.classification
    || state.classification !== evidence.classification
    || run.candidateDigest !== state.candidateDigest
  ) {
    throw new ControlPlaneError(
      "현재 terminal discovery 근거가 registration과 정확히 일치하지 않습니다.",
      409,
      "REPOSITORY_CLASSIFICATION_RATIFICATION_EVIDENCE_STALE",
    );
  }
  if (evidence.classification === "PRODUCT_APP") {
    if (
      run.status !== "MANAGED"
      || run.observationId === null
      || state.candidates.length !== 1
      || evidence.candidateMarkerPath !== state.candidates[0]?.markerPath
    ) {
      throw new ControlPlaneError(
        "PRODUCT_APP ratification에는 exact observation의 단일 candidate marker가 필요합니다.",
        409,
        "REPOSITORY_CLASSIFICATION_RATIFICATION_CANDIDATE_INVALID",
      );
    }
  } else if (
    run.status !== "EXCLUDED"
    || run.observationId !== null
    || evidence.candidateMarkerPath !== null
  ) {
    throw new ControlPlaneError(
      "비제품 repository ratification 근거가 terminal exclusion과 일치하지 않습니다.",
      409,
      "REPOSITORY_CLASSIFICATION_RATIFICATION_TERMINAL_INVALID",
    );
  }
  return { terminalRunId: run.id, candidateDigest: state.candidateDigest };
}

function classificationRequestHash(input: RepositoryClassificationDecisionRequest): string {
  return jsonDigest({
    schemaVersion: input.schemaVersion,
    repoId: input.repoId.toString(),
    expectedGeneration: input.expectedGeneration,
    expectedDecisionRevision: input.expectedDecisionRevision,
    classification: input.classification,
    candidateMarkerPath: input.candidateMarkerPath,
    productIdentity: input.productIdentity,
    justification: input.justification,
  } as JsonValue);
}

function deliveryId(repoId: bigint, revision: number, requestHash: string): string {
  return `repository-classification:${repoId.toString()}:${revision}:${requestHash}`;
}

export async function getRepositoryClassificationQueue(): Promise<RepositoryClassificationQueueItem[]> {
  const registrations = await prisma.repositoryRegistration.findMany({
    where: { archived: false, status: { in: ["NEEDS_INPUT", "MANAGED"] } },
    orderBy: [{ updatedAt: "asc" }, { repoFullName: "asc" }],
    select: {
      repoId: true,
      repoFullName: true,
      status: true,
      classification: true,
      reconcileGeneration: true,
      classificationDecisionVersion: true,
      lastDiscoveryReason: true,
      fork: true,
      discoveryCandidates: true,
      classificationDecisions: {
        orderBy: { revision: "desc" as const },
        take: 1,
        select: {
          classification: true,
          candidateMarkerPath: true,
          productDisplayName: true,
          productType: true,
          productEngine: true,
        },
      },
      updatedAt: true,
    },
  });
  const apps = await prisma.app.findMany({
    where: { repoId: { in: registrations.map(({ repoId }) => repoId) } },
    select: { repoId: true, displayName: true, type: true, engine: true },
  });
  const appsByRepoId = new Map(apps.flatMap((app) => (
    app.repoId === null ? [] : [[app.repoId.toString(), app] as const]
  )));
  return registrations.filter((registration) => (
    registration.status === "NEEDS_INPUT"
    || (
      registration.status === "MANAGED"
      && (registration.classificationDecisionVersion ?? 0) === 0
      && registration.classification !== null
    )
  )).map((registration) => {
    const decisionRevision = registration.classificationDecisionVersion ?? 0;
    const latestDecision = registration.classificationDecisions[0] ?? null;
    const app = appsByRepoId.get(registration.repoId.toString()) ?? null;
    const decisionIdentity = latestDecision?.productDisplayName
      && latestDecision.productType
      && latestDecision.productEngine
      ? {
          displayName: latestDecision.productDisplayName,
          type: latestDecision.productType,
          engine: latestDecision.productEngine,
        }
      : null;
    return {
      repoId: registration.repoId.toString(),
      repoFullName: registration.repoFullName,
      mode: registration.status === "MANAGED"
        ? "RATIFY_CURRENT" as const
        : decisionRevision > 0
          ? "CORRECT_POLICY" as const
          : "DECIDE" as const,
      generation: registration.reconcileGeneration ?? 0,
      decisionRevision,
      currentClassification: registration.classification ?? latestDecision?.classification ?? null,
      currentCandidateMarkerPath: latestDecision?.candidateMarkerPath ?? null,
      currentProductIdentity: decisionIdentity ?? (app ? {
        displayName: app.displayName,
        type: app.type,
        engine: app.engine,
      } : null),
      reasonCode: registration.lastDiscoveryReason,
      fork: registration.fork,
      candidates: repositoryClassificationCandidates(registration.discoveryCandidates),
      updatedAt: registration.updatedAt.toISOString(),
    };
  });
}

function productIdentityMatches(
  left: { productDisplayName: string | null; productType: string | null; productEngine: string | null },
  right: RepositoryClassificationDecisionRequest["productIdentity"],
): boolean {
  return right === null
    ? left.productDisplayName === null && left.productType === null && left.productEngine === null
    : left.productDisplayName === right.displayName
      && left.productType === right.type
      && left.productEngine === right.engine;
}

function managementKindFor(classification: RepositoryClassification) {
  if (classification === "PRODUCT_APP") return "APP" as const;
  if (classification === "PLATFORM_PRODUCER") return "PLATFORM_PRODUCER" as const;
  return "UNCLASSIFIED" as const;
}

async function enrollProductApp(
  tx: Prisma.TransactionClient,
  input: {
    repoId: bigint;
    repoFullName: string;
    productIdentity: NonNullable<RepositoryClassificationDecisionRequest["productIdentity"]>;
  },
) {
  const slug = input.repoFullName.split("/").at(-1);
  if (!slug) {
    throw new ControlPlaneError(
      "repository 이름에서 product slug를 확정할 수 없습니다.",
      409,
      "APP_IDENTITY_CONFLICT",
    );
  }
  const [byRepoId, byFullName, bySlug] = await Promise.all([
    tx.app.findUnique({ where: { repoId: input.repoId } }),
    tx.app.findUnique({ where: { repoFullName: input.repoFullName } }),
    tx.app.findUnique({ where: { slug } }),
  ]);
  const adopted = byRepoId ?? (byFullName?.repoId === null ? byFullName : null);
  if (
    (byFullName && byFullName.id !== adopted?.id)
    || (bySlug && bySlug.id !== adopted?.id)
  ) {
    throw new ControlPlaneError(
      "중앙 App identity가 다른 repository binding과 충돌합니다.",
      409,
      "APP_IDENTITY_CONFLICT",
    );
  }
  if (adopted) {
    return {
      app: await tx.app.update({
        where: { id: adopted.id },
        data: {
          slug,
          repoId: input.repoId,
          repoFullName: input.repoFullName,
          displayName: input.productIdentity.displayName,
          type: input.productIdentity.type,
          engine: input.productIdentity.engine,
        },
      }),
      created: false,
    };
  }
  return {
    app: await tx.app.create({
      data: {
        slug,
        repoId: input.repoId,
        repoFullName: input.repoFullName,
        displayName: input.productIdentity.displayName,
        type: input.productIdentity.type,
        engine: input.productIdentity.engine,
        marketTargets: [],
      },
    }),
    created: true,
  };
}

export async function recordRepositoryClassificationDecision(input: {
  request: RepositoryClassificationDecisionRequest;
  actor: string;
  idempotencyKey: string;
}): Promise<{
  duplicate: boolean;
  decision: {
    id: string;
    repoId: string;
    revision: number;
    classification: RepositoryClassification;
    candidateMarkerPath: string | null;
    productIdentity: {
      displayName: string;
      type: "APP" | "GAME";
      engine: "RN" | "GODOT";
    } | null;
    createdBy: string;
    createdAt: Date;
  };
  runId: string | null;
  generation: number | null;
}> {
  const request = repositoryClassificationDecisionSchema.parse(input.request);
  if (!ACTOR.test(input.actor)) {
    throw new ControlPlaneError("actor가 유효하지 않습니다.", 400, "ACTOR_INVALID");
  }
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw new ControlPlaneError("idempotency key가 유효하지 않습니다.", 400, "IDEMPOTENCY_KEY_INVALID");
  }
  const requestHash = classificationRequestHash(request);
  try {
    return await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT repoId FROM repository_registration WHERE repoId = ${request.repoId} FOR UPDATE`;
    const replay = await tx.repositoryClassificationDecision.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (replay) {
      if (replay.requestHash !== requestHash || replay.createdBy !== input.actor) {
        throw new ControlPlaneError(
          "같은 idempotency key가 다른 repository 분류 요청에 사용되었습니다.",
          409,
          "IDEMPOTENCY_CONFLICT",
        );
      }
      const run = await tx.repositoryDiscoveryRun.findUnique({
        where: { triggerDeliveryId: deliveryId(replay.repoId, replay.revision, replay.requestHash) },
        select: { id: true, generation: true },
      });
      return {
        duplicate: true,
        decision: {
          id: replay.id,
          repoId: replay.repoId.toString(),
          revision: replay.revision,
          classification: replay.classification,
          candidateMarkerPath: replay.candidateMarkerPath,
          productIdentity: replay.productDisplayName && replay.productType && replay.productEngine
            ? {
                displayName: replay.productDisplayName,
                type: replay.productType,
                engine: replay.productEngine,
              }
            : null,
          createdBy: replay.createdBy,
          createdAt: replay.createdAt,
        },
        runId: run?.id ?? null,
        generation: run?.generation ?? null,
      };
    }

    const registration = await tx.repositoryRegistration.findUnique({
      where: { repoId: request.repoId },
      select: {
        repoId: true,
        repoFullName: true,
        defaultBranch: true,
        archived: true,
        fork: true,
        status: true,
        classification: true,
        discoveryContractVersion: true,
        reconcileGeneration: true,
        classificationDecisionVersion: true,
        discoveryCandidates: true,
        lastDefaultPushSha: true,
        lastReconciledSha: true,
        lastDiscoveryReason: true,
      },
    });
    if (!registration) {
      throw new ControlPlaneError("repository 등록을 찾을 수 없습니다.", 404, "REPOSITORY_NOT_FOUND");
    }
    const generation = registration.reconcileGeneration ?? 0;
    const currentDecisionRevision = registration.classificationDecisionVersion ?? 0;
    const [latestDecision, terminalRun] = await Promise.all([
      tx.repositoryClassificationDecision.findFirst({
        where: { repoId: registration.repoId },
        orderBy: { revision: "desc" },
        select: {
          revision: true,
          classification: true,
          candidateMarkerPath: true,
          productDisplayName: true,
          productType: true,
          productEngine: true,
        },
      }),
      tx.repositoryDiscoveryRun.findUnique({
        where: {
          repoId_generation: {
            repoId: registration.repoId,
            generation,
          },
        },
        select: {
          id: true,
          generation: true,
          sourceSha: true,
          status: true,
          classification: true,
          contractVersion: true,
          candidateDigest: true,
          observationId: true,
          completedAt: true,
        },
      }),
    ]);
    if (
      generation !== request.expectedGeneration
      || currentDecisionRevision !== request.expectedDecisionRevision
    ) {
      throw new ControlPlaneError(
        "repository 상태가 갱신되었습니다. 최신 입력 큐를 다시 확인해 주세요.",
        409,
        "REPOSITORY_CLASSIFICATION_CONFLICT",
      );
    }
    if (
      registration.archived
      || (registration.status !== "NEEDS_INPUT" && registration.status !== "MANAGED")
    ) {
      throw new ControlPlaneError(
        "현재 NEEDS_INPUT 또는 MANAGED repository만 분류할 수 있습니다.",
        409,
        "REPOSITORY_CLASSIFICATION_STATE_CONFLICT",
      );
    }
    const ratifyingCurrent = request.justification === "CURRENT_OBSERVATION_RATIFIED";
    const correctingPolicy = request.justification === "CENTRAL_POLICY_CORRECTION";
    if (ratifyingCurrent && registration.status !== "MANAGED") {
      throw new ControlPlaneError(
        "현재 관측 ratification은 MANAGED repository에만 허용됩니다.",
        409,
        "REPOSITORY_CLASSIFICATION_RATIFICATION_STATE_CONFLICT",
      );
    }
    if (!ratifyingCurrent && registration.status === "MANAGED" && !correctingPolicy) {
      throw new ControlPlaneError(
        "MANAGED repository는 현재 관측 ratification 또는 중앙 정책 교정만 허용됩니다.",
        409,
        "REPOSITORY_CLASSIFICATION_STATE_CONFLICT",
      );
    }
    if (currentDecisionRevision === 0 && latestDecision !== null) {
      throw new ControlPlaneError(
        "repository 분류 decision ledger가 registration revision과 일치하지 않습니다.",
        409,
        "REPOSITORY_CLASSIFICATION_LEDGER_CONFLICT",
      );
    }
    if (
      currentDecisionRevision > 0
      && latestDecision?.revision !== currentDecisionRevision
    ) {
      throw new ControlPlaneError(
        "repository 분류 decision ledger가 registration revision과 일치하지 않습니다.",
        409,
        "REPOSITORY_CLASSIFICATION_LEDGER_CONFLICT",
      );
    }
    if (correctingPolicy) {
      if (currentDecisionRevision === 0 || latestDecision === null) {
        throw new ControlPlaneError(
          "중앙 정책 교정에는 기존 분류 decision revision이 필요합니다.",
          409,
          "REPOSITORY_CLASSIFICATION_CORRECTION_BASE_MISSING",
        );
      }
      if (
        latestDecision.classification === request.classification
        && latestDecision.candidateMarkerPath === request.candidateMarkerPath
        && productIdentityMatches(latestDecision, request.productIdentity)
      ) {
        throw new ControlPlaneError(
          "현재 분류와 같은 중앙 정책 교정은 새 revision으로 기록하지 않습니다.",
          409,
          "REPOSITORY_CLASSIFICATION_CORRECTION_NOOP",
        );
      }
    } else if (!ratifyingCurrent && currentDecisionRevision > 0) {
      throw new ControlPlaneError(
        "기존 분류를 바꾸려면 중앙 정책 교정 justification이 필요합니다.",
        409,
        "REPOSITORY_CLASSIFICATION_CORRECTION_REQUIRED",
      );
    }
    if (
      registration.fork === true
      && request.classification !== "EXCLUDED"
    ) {
      throw new ControlPlaneError(
        "fork repository는 EXCLUDED로만 확인할 수 있습니다.",
        409,
        "FORK_CLASSIFICATION_FORBIDDEN",
      );
    }
    const candidates = repositoryClassificationCandidates(registration.discoveryCandidates);
    if (
      request.classification === "PRODUCT_APP"
      && request.candidateMarkerPath !== null
      && !candidates.some((candidate) => candidate.markerPath === request.candidateMarkerPath)
    ) {
      throw new ControlPlaneError(
        "선택한 candidate marker가 최신 discovery observation에 없습니다.",
        409,
        "CLASSIFICATION_CANDIDATE_INVALID",
      );
    }
    if (
      request.classification === "PRODUCT_APP"
      && candidates.length > 1
      && request.candidateMarkerPath === null
    ) {
      throw new ControlPlaneError(
        "여러 앱 후보 중 하나를 선택해야 합니다.",
        400,
        "CLASSIFICATION_CANDIDATE_REQUIRED",
      );
    }

    const ratificationEvidence = ratifyingCurrent
      ? validateCurrentRepositoryClassificationRatification({
          expectedGeneration: request.expectedGeneration,
          expectedDecisionRevision: request.expectedDecisionRevision,
          classification: request.classification,
          candidateMarkerPath: request.candidateMarkerPath,
          registration: {
            classification: registration.classification,
            discoveryContractVersion: registration.discoveryContractVersion,
            discoveryCandidates: registration.discoveryCandidates,
            lastDefaultPushSha: registration.lastDefaultPushSha,
            lastReconciledSha: registration.lastReconciledSha,
            reconcileGeneration: registration.reconcileGeneration,
          },
          latestDecision,
          terminalRun,
        })
      : null;

    const revision = currentDecisionRevision + 1;
    const enrollment = request.classification === "PRODUCT_APP"
      ? await enrollProductApp(tx, {
          repoId: registration.repoId,
          repoFullName: registration.repoFullName,
          productIdentity: request.productIdentity!,
        })
      : null;
    const enrolledApp = enrollment?.app ?? null;
    const decision = await tx.repositoryClassificationDecision.create({
      data: {
        repoId: registration.repoId,
        revision,
        classification: request.classification,
        candidateMarkerPath: request.candidateMarkerPath,
        productDisplayName: request.productIdentity?.displayName ?? null,
        productType: request.productIdentity?.type ?? null,
        productEngine: request.productIdentity?.engine ?? null,
        justification: request.justification,
        requestHash,
        idempotencyKey: input.idempotencyKey,
        createdBy: input.actor,
      },
    });
    if (enrollment?.created) {
      await tx.fleetLifecycleState.create({
        data: { appId: enrolledApp!.id, stage: "PLANNING", generation: 1 },
      });
      await tx.fleetLifecycleEvent.create({
        data: {
          appId: enrolledApp!.id,
          fromStage: "IDEA",
          toStage: "PLANNING",
          actor: input.actor,
          idempotencyKey: `repository-product-enrollment:${registration.repoId.toString()}:${revision}:${requestHash}`,
          evidence: {
            transitionSource: "REPOSITORY_PRODUCT_ENROLLMENT",
            classificationDecisionId: decision.id,
            classificationDecisionRevision: revision,
          },
        },
      });
    }
    const changed = await tx.repositoryRegistration.updateMany({
      where: {
        repoId: registration.repoId,
        status: registration.status,
        archived: false,
        reconcileGeneration: request.expectedGeneration,
        ...(ratificationEvidence
          ? {
              classification: request.classification,
              discoveryContractVersion: registration.discoveryContractVersion,
              lastDefaultPushSha: registration.lastDefaultPushSha,
              lastReconciledSha: registration.lastReconciledSha,
            }
          : {}),
        OR: request.expectedDecisionRevision === 0
          ? [
              { classificationDecisionVersion: null },
              { classificationDecisionVersion: 0 },
            ]
          : [{ classificationDecisionVersion: request.expectedDecisionRevision }],
      },
      data: {
        classificationDecisionVersion: revision,
        classification: request.classification,
        managementKind: managementKindFor(request.classification),
      },
    });
    if (changed.count !== 1) {
      throw new ControlPlaneError(
        "repository 분류 optimistic concurrency 검사에 실패했습니다.",
        409,
        "REPOSITORY_CLASSIFICATION_CONFLICT",
      );
    }

    if (ratificationEvidence) {
      await tx.auditLog.create({
        data: {
          actorLogin: input.actor,
          action: "control-plane.repository-classification.ratified",
          entityType: "RepositoryClassificationDecision",
          entityId: decision.id,
          payload: {
            repoId: registration.repoId.toString(),
            repoFullName: registration.repoFullName,
            generation,
            sourceSha: registration.lastReconciledSha,
            contractVersion: registration.discoveryContractVersion,
            terminalRunId: ratificationEvidence.terminalRunId,
            candidateDigest: ratificationEvidence.candidateDigest,
            revision,
            classification: request.classification,
            candidateMarkerPath: request.candidateMarkerPath,
            productIdentity: request.productIdentity,
            appId: enrolledApp?.id ?? null,
            justification: request.justification,
            requestHash,
            discoveryEnqueued: false,
          },
        },
      });
      return {
        duplicate: false,
        decision: {
          id: decision.id,
          repoId: decision.repoId.toString(),
          revision: decision.revision,
          classification: decision.classification,
          candidateMarkerPath: decision.candidateMarkerPath,
          productIdentity: decision.productDisplayName && decision.productType && decision.productEngine
            ? {
                displayName: decision.productDisplayName,
                type: decision.productType,
                engine: decision.productEngine,
              }
            : null,
          createdBy: decision.createdBy,
          createdAt: decision.createdAt,
        },
        runId: null,
        generation: null,
      };
    }

    const trigger = await registerRepositoryWebhookInTransaction({
      event: "reconcile",
      action: "classification-decision",
      repository: {
        id: Number(registration.repoId),
        full_name: registration.repoFullName,
        name: registration.repoFullName.split("/").at(-1),
        default_branch: registration.defaultBranch,
        archived: false,
        ...(registration.fork === null ? {} : { fork: registration.fork }),
      },
      after: registration.lastDefaultPushSha ?? undefined,
      deliveryId: deliveryId(registration.repoId, revision, requestHash),
      organization: registration.repoFullName.split("/")[0],
      classificationDecisionRevision: revision,
    }, tx, new Date());
    if (!trigger.enqueued || !trigger.runId || trigger.generation === null) {
      throw new ControlPlaneError(
        "repository 분류 후 discovery 재실행을 예약하지 못했습니다.",
        409,
        "REPOSITORY_CLASSIFICATION_ENQUEUE_FAILED",
      );
    }
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.repository-classification.decided",
        entityType: "RepositoryClassificationDecision",
        entityId: decision.id,
        payload: {
          repoId: registration.repoId.toString(),
          repoFullName: registration.repoFullName,
          previousGeneration: generation,
          previousReasonCode: registration.lastDiscoveryReason,
          revision,
          classification: request.classification,
          candidateMarkerPath: request.candidateMarkerPath,
          productIdentity: request.productIdentity,
          appId: enrolledApp?.id ?? null,
          justification: request.justification,
          requestHash,
          runId: trigger.runId,
          generation: trigger.generation,
        },
      },
    });
    return {
      duplicate: false,
      decision: {
        id: decision.id,
        repoId: decision.repoId.toString(),
        revision: decision.revision,
        classification: decision.classification,
        candidateMarkerPath: decision.candidateMarkerPath,
        productIdentity: decision.productDisplayName && decision.productType && decision.productEngine
          ? {
              displayName: decision.productDisplayName,
              type: decision.productType,
              engine: decision.productEngine,
            }
          : null,
        createdBy: decision.createdBy,
        createdAt: decision.createdAt,
      },
      runId: trigger.runId,
      generation: trigger.generation,
    };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    // 서로 다른 repo row를 잠근 두 요청이 같은 key를 동시에 쓰면 사전 replay
    // 조회만으로는 unique race를 막지 못한다. winner를 readback해 같은 요청은
    // replay로, 다른 요청은 409로 수렴시킨다.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    const replay = await prisma.repositoryClassificationDecision.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (!replay) throw error;
    if (replay.requestHash !== requestHash || replay.createdBy !== input.actor) {
      throw new ControlPlaneError(
        "같은 idempotency key가 다른 repository 분류 요청에 사용되었습니다.",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    }
    const run = await prisma.repositoryDiscoveryRun.findUnique({
      where: { triggerDeliveryId: deliveryId(replay.repoId, replay.revision, replay.requestHash) },
      select: { id: true, generation: true },
    });
    return {
      duplicate: true,
      decision: {
        id: replay.id,
        repoId: replay.repoId.toString(),
        revision: replay.revision,
        classification: replay.classification,
        candidateMarkerPath: replay.candidateMarkerPath,
        productIdentity: replay.productDisplayName && replay.productType && replay.productEngine
          ? {
              displayName: replay.productDisplayName,
              type: replay.productType,
              engine: replay.productEngine,
            }
          : null,
        createdBy: replay.createdBy,
        createdAt: replay.createdAt,
      },
      runId: run?.id ?? null,
      generation: run?.generation ?? null,
    };
  }
}
