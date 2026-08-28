import { Prisma, type RepositoryClassification } from "@prisma/client";

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
  profile: "react-native" | "godot";
  workingDirectory: string;
  markerPath: string;
}

export interface RepositoryClassificationQueueItem {
  repoId: string;
  repoFullName: string;
  generation: number;
  decisionRevision: number;
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
      (profile !== "react-native" && profile !== "godot")
      || typeof item.workingDirectory !== "string"
      || !safeMarkerPath(item.markerPath)
    ) return [];
    return [{
      profile,
      workingDirectory: item.workingDirectory,
      markerPath: item.markerPath,
    }];
  });
  return [...new Map(parsed.map((candidate) => [candidate.markerPath, candidate])).values()]
    .sort((left, right) => left.markerPath.localeCompare(right.markerPath));
}

function classificationRequestHash(input: RepositoryClassificationDecisionRequest): string {
  return jsonDigest({
    schemaVersion: input.schemaVersion,
    repoId: input.repoId.toString(),
    expectedGeneration: input.expectedGeneration,
    expectedDecisionRevision: input.expectedDecisionRevision,
    classification: input.classification,
    candidateMarkerPath: input.candidateMarkerPath,
    justification: input.justification,
  } as JsonValue);
}

function deliveryId(repoId: bigint, revision: number, requestHash: string): string {
  return `repository-classification:${repoId.toString()}:${revision}:${requestHash}`;
}

export async function getRepositoryClassificationQueue(): Promise<RepositoryClassificationQueueItem[]> {
  const registrations = await prisma.repositoryRegistration.findMany({
    where: { archived: false, status: "NEEDS_INPUT" },
    orderBy: [{ updatedAt: "asc" }, { repoFullName: "asc" }],
    select: {
      repoId: true,
      repoFullName: true,
      reconcileGeneration: true,
      classificationDecisionVersion: true,
      lastDiscoveryReason: true,
      fork: true,
      discoveryCandidates: true,
      updatedAt: true,
    },
  });
  return registrations.map((registration) => ({
    repoId: registration.repoId.toString(),
    repoFullName: registration.repoFullName,
    generation: registration.reconcileGeneration ?? 0,
    decisionRevision: registration.classificationDecisionVersion,
    reasonCode: registration.lastDiscoveryReason,
    fork: registration.fork,
    candidates: repositoryClassificationCandidates(registration.discoveryCandidates),
    updatedAt: registration.updatedAt.toISOString(),
  }));
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
        reconcileGeneration: true,
        classificationDecisionVersion: true,
        discoveryCandidates: true,
        lastDefaultPushSha: true,
        lastDiscoveryReason: true,
      },
    });
    if (!registration) {
      throw new ControlPlaneError("repository 등록을 찾을 수 없습니다.", 404, "REPOSITORY_NOT_FOUND");
    }
    const generation = registration.reconcileGeneration ?? 0;
    if (
      generation !== request.expectedGeneration
      || registration.classificationDecisionVersion !== request.expectedDecisionRevision
    ) {
      throw new ControlPlaneError(
        "repository 상태가 갱신되었습니다. 최신 입력 큐를 다시 확인해 주세요.",
        409,
        "REPOSITORY_CLASSIFICATION_CONFLICT",
      );
    }
    if (registration.archived || registration.status !== "NEEDS_INPUT") {
      throw new ControlPlaneError(
        "현재 NEEDS_INPUT repository만 분류할 수 있습니다.",
        409,
        "REPOSITORY_CLASSIFICATION_STATE_CONFLICT",
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

    const revision = registration.classificationDecisionVersion + 1;
    const decision = await tx.repositoryClassificationDecision.create({
      data: {
        repoId: registration.repoId,
        revision,
        classification: request.classification,
        candidateMarkerPath: request.candidateMarkerPath,
        justification: request.justification,
        requestHash,
        idempotencyKey: input.idempotencyKey,
        createdBy: input.actor,
      },
    });
    const changed = await tx.repositoryRegistration.updateMany({
      where: {
        repoId: registration.repoId,
        status: "NEEDS_INPUT",
        archived: false,
        reconcileGeneration: request.expectedGeneration,
        classificationDecisionVersion: request.expectedDecisionRevision,
      },
      data: { classificationDecisionVersion: revision },
    });
    if (changed.count !== 1) {
      throw new ControlPlaneError(
        "repository 분류 optimistic concurrency 검사에 실패했습니다.",
        409,
        "REPOSITORY_CLASSIFICATION_CONFLICT",
      );
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
        createdBy: replay.createdBy,
        createdAt: replay.createdAt,
      },
      runId: run?.id ?? null,
      generation: run?.generation ?? null,
    };
  }
}
