import { Prisma } from "@prisma/client";

import { createDraftRevisionInTransaction } from "@/lib/control-plane/config-revision-store";
import { projectDiscoveryConfigPayload } from "@/lib/control-plane/config-revision-discovery-projection";
import { latestDiscoveryObservationOrder } from "@/lib/control-plane/discovery-order";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";
import { repositoryProductPlanningReason } from "@/lib/control-plane/repository-product-readiness";
import { REPOSITORY_DISCOVERY_CONTRACT_VERSION } from "@/lib/control-plane/repository-discovery";

export const DESIRED_STATE_BACKFILL_CONTRACT_VERSION = "desired-state-draft-backfill/v2";
export const DESIRED_STATE_BACKFILL_MODE = "DRAFT_ONLY" as const;

const ACTOR = /^[A-Za-z0-9._:/-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:/-]{8,191}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;

export type DesiredStateBackfillTrigger =
  | "HOURLY_CRON"
  | "DEPLOY_CATCH_UP"
  | "CONTROL_PLANE_API";

export interface DesiredStateBackfillInvocation {
  actor: string;
  idempotencyKey: string;
  trigger: DesiredStateBackfillTrigger;
  sourceSha: string | null;
}

/**
 * Admin scheduler 요청은 caller가 임의 key를 고르지 못하게 trigger별 namespace에
 * 결합한다. 배포는 exact source SHA, 정기는 UTC hour occurrence가 재시도 단위다.
 */
export function desiredStateBackfillAdminInvocation(input: {
  trigger: string | null;
  sourceSha: string | null;
  now: Date;
}): DesiredStateBackfillInvocation {
  if (input.trigger === "deploy-catch-up") {
    if (!input.sourceSha || !SOURCE_SHA.test(input.sourceSha)) {
      throw new ControlPlaneError(
        "deploy catch-up에는 소문자 40자리 source SHA가 필요합니다.",
        400,
        "SOURCE_SHA_INVALID",
      );
    }
    return {
      actor: "deploy:desired-state-backfill",
      idempotencyKey: `desired-state-backfill:deploy:${input.sourceSha}`,
      trigger: "DEPLOY_CATCH_UP",
      sourceSha: input.sourceSha,
    };
  }
  if (input.trigger === "hourly-cron") {
    if (input.sourceSha !== null) {
      throw new ControlPlaneError(
        "hourly backfill 요청에는 source SHA를 지정할 수 없습니다.",
        400,
        "SOURCE_SHA_NOT_ALLOWED",
      );
    }
    if (!Number.isFinite(input.now.getTime())) {
      throw new ControlPlaneError("hourly occurrence 시각이 유효하지 않습니다.", 400, "OCCURRENCE_INVALID");
    }
    const occurrence = input.now.toISOString().slice(0, 13).replace(/[-T:]/g, "");
    return {
      actor: "scheduler:desired-state-backfill",
      idempotencyKey: `desired-state-backfill:hourly:${occurrence}`,
      trigger: "HOURLY_CRON",
      sourceSha: null,
    };
  }
  throw new ControlPlaneError(
    "x-seorilabs-backfill-trigger는 hourly-cron 또는 deploy-catch-up이어야 합니다.",
    400,
    "BACKFILL_TRIGGER_INVALID",
  );
}

export type DesiredStateNeedsInputReason =
  | "APP_REPO_ID_MISSING"
  | "REPOSITORY_REGISTRATION_MISSING"
  | "REPOSITORY_ARCHIVED"
  | "REPOSITORY_NOT_MANAGED"
  | "REPOSITORY_CLASSIFICATION_PENDING"
  | "REPOSITORY_NOT_PRODUCT_APP"
  | "PRODUCT_SOURCE_CANDIDATE_MISSING"
  | "PRODUCT_BUILD_TARGET_MISSING"
  | "PRODUCT_DISCOVERY_NOT_READY"
  | "DISCOVERY_OBSERVATION_MISSING"
  | "DISCOVERY_SOURCE_STALE"
  | "BUILD_TARGET_MISSING"
  | "CONCURRENT_STATE_CHANGED";

export interface DesiredStateCandidate {
  appId: string;
  slug: string;
  repoFullName: string;
  repoId: string | null;
  status: string;
  configuredRevision: { id: string; revision: number; status: string } | null;
  registration: {
    repoId: string;
    status: string;
    archived: boolean;
    managementKind: string | null;
    classification: string | null;
    discoveryContractVersion: string | null;
    lastDefaultPushSha: string | null;
    lastReconciledSha: string | null;
    lastDiscoveryReason: string | null;
  } | null;
  observation: {
    id: string;
    sourceSha: string;
    payloadHash: string;
    observedAt: Date;
  } | null;
  buildTargets: Array<{
    targetKey: string;
    market: string | null;
    observedSha: string | null;
  }>;
}

type DesiredStateAssessment =
  | {
      outcome: "READY";
      sourceObservationId: string;
      payload: Record<string, unknown>;
    }
  | {
      outcome: "ALREADY_CONFIGURED";
      revisionId: string;
      revision: number;
      revisionStatus: string;
    }
  | {
      outcome: "NEEDS_INPUT";
      reason: DesiredStateNeedsInputReason;
      detail: string | null;
    };

export interface DesiredStateBackfillItem {
  appId: string;
  slug: string;
  repoFullName: string;
  repoId: string | null;
  outcome: "DRAFT_CREATED" | "ALREADY_CONFIGURED" | "NEEDS_INPUT" | "FAILED";
  reason: DesiredStateNeedsInputReason | "INTERNAL_ERROR" | null;
  detail: string | null;
  sourceObservationId: string | null;
  configRevisionId: string | null;
  revision: number | null;
  verifiedProjectionCounts: {
    markets: number;
    localizations: number;
    complianceDrafts: number;
    storeAssets: number;
    projectBlueprints: number;
  };
}

export interface DesiredStateBackfillSummary {
  contractVersion: typeof DESIRED_STATE_BACKFILL_CONTRACT_VERSION;
  mode: typeof DESIRED_STATE_BACKFILL_MODE;
  activeApps: number;
  draftCreated: number;
  alreadyConfigured: number;
  needsInput: number;
  failed: number;
  activationAttempted: false;
  providerMutationAttempted: false;
  deferredHumanOrProviderFields: readonly [
    "PROJECT_BLUEPRINT_INCOMPLETE",
    "LOCALIZATION_UNOBSERVED",
    "COMPLIANCE_HUMAN_DRAFT_REQUIRED",
    "STORE_ASSET_CHECKSUM_UNOBSERVED",
  ];
  items: DesiredStateBackfillItem[];
}

export interface DesiredStateBackfillRunResult extends DesiredStateBackfillSummary {
  runId: string;
  duplicate: boolean;
  state: "completed" | "partial" | "busy";
  runStatus: "RUNNING" | "COMPLETED" | "PARTIAL";
  trigger: DesiredStateBackfillTrigger;
  sourceSha: string | null;
  ok: boolean;
}

export function desiredStateBackfillReadbackHeaders(
  result: DesiredStateBackfillRunResult,
): Record<string, string> {
  return {
    "x-seorilabs-backfill-run-id": result.runId,
    "x-seorilabs-backfill-contract-version": result.contractVersion,
    "x-seorilabs-backfill-trigger": result.trigger,
    "x-seorilabs-backfill-source-sha": result.sourceSha ?? "",
    "x-seorilabs-backfill-status": result.runStatus,
    "x-seorilabs-backfill-failed": String(result.failed),
  };
}

const EMPTY_PROJECTIONS = {
  markets: 0,
  localizations: 0,
  complianceDrafts: 0,
  storeAssets: 0,
  projectBlueprints: 0,
} as const;

function needsInput(
  reason: DesiredStateNeedsInputReason,
  detail: string | null = null,
): DesiredStateAssessment {
  return { outcome: "NEEDS_INPUT", reason, detail };
}

/**
 * Discovery fact에서 확인 가능한 market presence만 DRAFT로 옮긴다. locale,
 * 법적 선언, asset checksum, cloud owner/billing identity는 추측하지 않는다.
 */
export function assessDesiredStateCandidate(
  candidate: DesiredStateCandidate,
): DesiredStateAssessment {
  if (candidate.status !== "ACTIVE") {
    return needsInput("CONCURRENT_STATE_CHANGED", `app status=${candidate.status}`);
  }
  if (!candidate.repoId) return needsInput("APP_REPO_ID_MISSING");
  const registration = candidate.registration;
  if (!registration || registration.repoId !== candidate.repoId) {
    return needsInput("REPOSITORY_REGISTRATION_MISSING");
  }
  if (registration.archived || registration.status === "ARCHIVED") {
    return needsInput("REPOSITORY_ARCHIVED");
  }
  if (!registration.classification) {
    return needsInput("REPOSITORY_CLASSIFICATION_PENDING", registration.managementKind);
  }
  if (registration.discoveryContractVersion !== REPOSITORY_DISCOVERY_CONTRACT_VERSION) {
    return needsInput("REPOSITORY_CLASSIFICATION_PENDING", registration.discoveryContractVersion);
  }
  if (registration.classification !== "PRODUCT_APP") {
    return needsInput("REPOSITORY_NOT_PRODUCT_APP", registration.classification);
  }
  if (registration.status !== "MANAGED") {
    return needsInput(
      repositoryProductPlanningReason(registration.lastDiscoveryReason),
      registration.lastDiscoveryReason,
    );
  }
  const observation = candidate.observation;
  if (!observation) return needsInput("DISCOVERY_OBSERVATION_MISSING");
  const sourceSha = observation.sourceSha.toLowerCase();
  if (
    registration.lastDefaultPushSha?.toLowerCase() !== sourceSha
    || registration.lastReconciledSha?.toLowerCase() !== sourceSha
  ) {
    return needsInput("DISCOVERY_SOURCE_STALE", registration.lastDiscoveryReason);
  }
  if (candidate.configuredRevision) {
    return {
      outcome: "ALREADY_CONFIGURED",
      revisionId: candidate.configuredRevision.id,
      revision: candidate.configuredRevision.revision,
      revisionStatus: candidate.configuredRevision.status,
    };
  }
  const payload = projectDiscoveryConfigPayload({ sourceSha, buildTargets: candidate.buildTargets });
  if (!payload) return needsInput("BUILD_TARGET_MISSING");
  return { outcome: "READY", sourceObservationId: observation.id, payload };
}

const desiredStateCandidateSelect = Prisma.validator<Prisma.AppSelect>()({
  id: true,
  slug: true,
  repoFullName: true,
  repoId: true,
  status: true,
  configRevisions: {
    where: { status: { in: ["DRAFT", "ACTIVE"] } },
    orderBy: { revision: "desc" },
    take: 1,
    select: { id: true, revision: true, status: true },
  },
  discoveryObservations: {
    orderBy: latestDiscoveryObservationOrder(),
    take: 1,
    select: { id: true, sourceSha: true, payloadHash: true, observedAt: true },
  },
  buildTargets: {
    select: { targetKey: true, market: true, observedSha: true },
    orderBy: { targetKey: "asc" },
  },
});

async function loadCandidates(
  tx: Prisma.TransactionClient,
  appId?: string,
): Promise<DesiredStateCandidate[]> {
  const apps = await tx.app.findMany({
    where: appId ? { id: appId } : { status: "ACTIVE" },
    orderBy: [{ slug: "asc" }, { id: "asc" }],
    select: desiredStateCandidateSelect,
  });
  const repoIds = apps
    .map((app) => app.repoId)
    .filter((repoId): repoId is bigint => repoId !== null);
  const registrations = repoIds.length === 0
    ? []
    : await tx.repositoryRegistration.findMany({
        where: { repoId: { in: repoIds } },
        select: {
          repoId: true,
          status: true,
          archived: true,
          managementKind: true,
          classification: true,
          discoveryContractVersion: true,
          lastDefaultPushSha: true,
          lastReconciledSha: true,
          lastDiscoveryReason: true,
        },
      });
  const registrationByRepoId = new Map(registrations.map((registration) => [
    registration.repoId.toString(),
    registration,
  ]));
  return apps.map((app) => {
    const repoId = app.repoId?.toString() ?? null;
    const registration = repoId ? registrationByRepoId.get(repoId) : undefined;
    return {
      appId: app.id,
      slug: app.slug,
      repoFullName: app.repoFullName,
      repoId,
      status: app.status,
      configuredRevision: app.configRevisions[0] ?? null,
      registration: registration ? {
        ...registration,
        repoId: registration.repoId.toString(),
      } : null,
      observation: app.discoveryObservations[0] ?? null,
      buildTargets: app.buildTargets,
    };
  });
}

function baseItem(candidate: DesiredStateCandidate): Omit<DesiredStateBackfillItem, "outcome" | "reason" | "detail" | "sourceObservationId" | "configRevisionId" | "revision"> {
  return {
    appId: candidate.appId,
    slug: candidate.slug,
    repoFullName: candidate.repoFullName,
    repoId: candidate.repoId,
    verifiedProjectionCounts: { ...EMPTY_PROJECTIONS },
  };
}

function assessmentItem(
  candidate: DesiredStateCandidate,
  assessment: Exclude<DesiredStateAssessment, { outcome: "READY" }>,
): DesiredStateBackfillItem {
  if (assessment.outcome === "ALREADY_CONFIGURED") {
    return {
      ...baseItem(candidate),
      outcome: "ALREADY_CONFIGURED",
      reason: null,
      detail: assessment.revisionStatus,
      sourceObservationId: candidate.observation?.id ?? null,
      configRevisionId: assessment.revisionId,
      revision: assessment.revision,
    };
  }
  return {
    ...baseItem(candidate),
    outcome: "NEEDS_INPUT",
    reason: assessment.reason,
    detail: assessment.detail,
    sourceObservationId: candidate.observation?.id ?? null,
    configRevisionId: null,
    revision: null,
  };
}

function summarize(items: DesiredStateBackfillItem[]): DesiredStateBackfillSummary {
  return {
    contractVersion: DESIRED_STATE_BACKFILL_CONTRACT_VERSION,
    mode: DESIRED_STATE_BACKFILL_MODE,
    activeApps: items.length,
    draftCreated: items.filter((item) => item.outcome === "DRAFT_CREATED").length,
    alreadyConfigured: items.filter((item) => item.outcome === "ALREADY_CONFIGURED").length,
    needsInput: items.filter((item) => item.outcome === "NEEDS_INPUT").length,
    failed: items.filter((item) => item.outcome === "FAILED").length,
    activationAttempted: false,
    providerMutationAttempted: false,
    deferredHumanOrProviderFields: [
      "PROJECT_BLUEPRINT_INCOMPLETE",
      "LOCALIZATION_UNOBSERVED",
      "COMPLIANCE_HUMAN_DRAFT_REQUIRED",
      "STORE_ASSET_CHECKSUM_UNOBSERVED",
    ],
    items,
  };
}

export function desiredStateBackfillRequestHash(input: DesiredStateBackfillInvocation): string {
  return jsonDigest({
    contractVersion: DESIRED_STATE_BACKFILL_CONTRACT_VERSION,
    mode: DESIRED_STATE_BACKFILL_MODE,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    trigger: input.trigger,
    sourceSha: input.sourceSha,
  } as JsonValue);
}

function storedSummary(value: unknown): DesiredStateBackfillSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = value as Partial<DesiredStateBackfillSummary>;
  return summary.contractVersion === DESIRED_STATE_BACKFILL_CONTRACT_VERSION
    && summary.mode === DESIRED_STATE_BACKFILL_MODE
    && Array.isArray(summary.items)
    ? summary as DesiredStateBackfillSummary
    : null;
}

export function assertDesiredStateBackfillReplay(input: {
  stored: {
    actor: string;
    requestHash: string;
    trigger: string | null;
    sourceSha: string | null;
  };
  requested: DesiredStateBackfillInvocation & { requestHash: string };
}): void {
  if (
    input.stored.requestHash !== input.requested.requestHash
    || input.stored.actor !== input.requested.actor
    || input.stored.trigger !== input.requested.trigger
    || input.stored.sourceSha !== input.requested.sourceSha
  ) {
    throw new ControlPlaneError(
      "같은 idempotency key가 다른 desired-state backfill 요청에 사용되었습니다.",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
}

async function createRun(input: DesiredStateBackfillInvocation & { requestHash: string }) {
  try {
    const run = await prisma.$transaction(async (tx) => {
      const created = await tx.desiredStateBackfillRun.create({
        data: {
          actor: input.actor,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          contractVersion: DESIRED_STATE_BACKFILL_CONTRACT_VERSION,
          trigger: input.trigger,
          sourceSha: input.sourceSha,
        },
      });
      await tx.auditLog.create({
        data: {
          actorLogin: input.actor,
          action: "control-plane.desired-state-backfill.started",
          entityType: "DesiredStateBackfillRun",
          entityId: created.id,
          payload: {
            contractVersion: DESIRED_STATE_BACKFILL_CONTRACT_VERSION,
            mode: DESIRED_STATE_BACKFILL_MODE,
            requestHash: input.requestHash,
            trigger: input.trigger,
            sourceSha: input.sourceSha,
          },
        },
      });
      return created;
    });
    return { run, duplicate: false };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const run = await prisma.desiredStateBackfillRun.findUniqueOrThrow({
      where: { idempotencyKey: input.idempotencyKey },
    });
    assertDesiredStateBackfillReplay({ stored: run, requested: input });
    return { run, duplicate: true };
  }
}

async function createDraftForCandidate(
  initial: DesiredStateCandidate,
  actor: string,
): Promise<DesiredStateBackfillItem> {
  return prisma.$transaction(async (tx) => {
    // Repository discovery와 같은 registration -> app lock 순서를 유지한다.
    if (initial.repoId) {
      await tx.$queryRaw`SELECT repoId FROM repository_registration WHERE repoId = ${BigInt(initial.repoId)} FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT id FROM app WHERE id = ${initial.appId} FOR UPDATE`;
    const current = (await loadCandidates(tx, initial.appId))[0];
    if (!current) {
      return {
        ...baseItem(initial),
        outcome: "NEEDS_INPUT",
        reason: "CONCURRENT_STATE_CHANGED",
        detail: "app row missing",
        sourceObservationId: initial.observation?.id ?? null,
        configRevisionId: null,
        revision: null,
      };
    }
    if (current.repoId !== initial.repoId) {
      return {
        ...baseItem(current),
        outcome: "NEEDS_INPUT",
        reason: "CONCURRENT_STATE_CHANGED",
        detail: "app repository binding changed",
        sourceObservationId: current.observation?.id ?? null,
        configRevisionId: null,
        revision: null,
      };
    }
    const assessment = assessDesiredStateCandidate(current);
    if (assessment.outcome !== "READY") return assessmentItem(current, assessment);
    const payloadHash = jsonDigest(assessment.payload as JsonValue);
    const revision = await createDraftRevisionInTransaction(tx, {
      appId: current.appId,
      payload: assessment.payload,
      payloadHash,
      createdBy: actor,
      idempotencyKey: `desired-state-backfill:${current.appId}:${assessment.sourceObservationId}`,
      sourceObservationId: assessment.sourceObservationId,
      backfillContractVersion: DESIRED_STATE_BACKFILL_CONTRACT_VERSION,
    });
    await tx.auditLog.create({
      data: {
        actorLogin: actor,
        action: "control-plane.desired-state-backfill.draft-created",
        entityType: "ConfigRevision",
        entityId: revision.id,
        payload: {
          appId: current.appId,
          repoId: current.repoId,
          sourceObservationId: assessment.sourceObservationId,
          sourceSha: current.observation?.sourceSha ?? null,
          observationPayloadHash: current.observation?.payloadHash ?? null,
          revision: revision.revision,
          payloadHash,
          activationAttempted: false,
        },
      },
    });
    return {
      ...baseItem(current),
      outcome: "DRAFT_CREATED",
      reason: null,
      detail: null,
      sourceObservationId: assessment.sourceObservationId,
      configRevisionId: revision.id,
      revision: revision.revision,
      verifiedProjectionCounts: {
        ...EMPTY_PROJECTIONS,
        markets: (assessment.payload.markets as unknown[]).length,
      },
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function runDesiredStateDraftBackfill(
  input: DesiredStateBackfillInvocation,
): Promise<DesiredStateBackfillRunResult> {
  if (!ACTOR.test(input.actor)) throw new ControlPlaneError("actor가 유효하지 않습니다.", 400, "ACTOR_INVALID");
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw new ControlPlaneError("idempotency key가 유효하지 않습니다.", 400, "IDEMPOTENCY_KEY_INVALID");
  }
  if (input.sourceSha !== null && !SOURCE_SHA.test(input.sourceSha)) {
    throw new ControlPlaneError("source SHA가 유효하지 않습니다.", 400, "SOURCE_SHA_INVALID");
  }
  if (input.trigger === "DEPLOY_CATCH_UP" && input.sourceSha === null) {
    throw new ControlPlaneError("deploy catch-up source SHA가 필요합니다.", 400, "SOURCE_SHA_INVALID");
  }
  if (input.trigger !== "DEPLOY_CATCH_UP" && input.sourceSha !== null) {
    throw new ControlPlaneError("이 trigger에는 source SHA를 지정할 수 없습니다.", 400, "SOURCE_SHA_NOT_ALLOWED");
  }
  const hashed = desiredStateBackfillRequestHash(input);
  const created = await createRun({ ...input, requestHash: hashed });
  if (created.duplicate) {
    const summary = storedSummary(created.run.summary);
    if (summary) {
      return {
        ...summary,
        runId: created.run.id,
        duplicate: true,
        state: created.run.status === "COMPLETED" ? "completed" : "partial",
        runStatus: created.run.status,
        trigger: input.trigger,
        sourceSha: input.sourceSha,
        ok: created.run.status === "COMPLETED" && summary.failed === 0,
      };
    }
    const empty = summarize([]);
    return {
      ...empty,
      runId: created.run.id,
      duplicate: true,
      state: "busy",
      runStatus: "RUNNING",
      trigger: input.trigger,
      sourceSha: input.sourceSha,
      ok: false,
    };
  }

  const candidates = await prisma.$transaction((tx) => loadCandidates(tx));
  const items: DesiredStateBackfillItem[] = [];
  for (const candidate of candidates) {
    const assessment = assessDesiredStateCandidate(candidate);
    if (assessment.outcome !== "READY") {
      items.push(assessmentItem(candidate, assessment));
      continue;
    }
    try {
      items.push(await createDraftForCandidate(candidate, input.actor));
    } catch {
      items.push({
        ...baseItem(candidate),
        outcome: "FAILED",
        reason: "INTERNAL_ERROR",
        detail: null,
        sourceObservationId: assessment.sourceObservationId,
        configRevisionId: null,
        revision: null,
      });
    }
  }
  const summary = summarize(items);
  const status = summary.failed === 0 ? "COMPLETED" as const : "PARTIAL" as const;
  const completedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.desiredStateBackfillRun.update({
      where: { id: created.run.id },
      data: {
        status,
        summary: summary as unknown as Prisma.InputJsonValue,
        completedAt,
      },
    });
    const needsInputByReason = Object.fromEntries(
      [...new Set(items
        .filter((item) => item.outcome === "NEEDS_INPUT")
        .map((item) => item.reason)
        .filter((reason): reason is DesiredStateNeedsInputReason => reason !== null))]
        .sort()
        .map((reason) => [reason, items.filter((item) => item.reason === reason).length]),
    );
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.desired-state-backfill.completed",
        entityType: "DesiredStateBackfillRun",
        entityId: created.run.id,
        payload: {
          activeApps: summary.activeApps,
          draftCreated: summary.draftCreated,
          alreadyConfigured: summary.alreadyConfigured,
          needsInput: summary.needsInput,
          failed: summary.failed,
          needsInputByReason,
          activationAttempted: false,
          providerMutationAttempted: false,
          trigger: input.trigger,
          sourceSha: input.sourceSha,
        },
      },
    });
  });
  return {
    ...summary,
    runId: created.run.id,
    duplicate: false,
    state: status === "COMPLETED" ? "completed" : "partial",
    runStatus: status,
    trigger: input.trigger,
    sourceSha: input.sourceSha,
    ok: status === "COMPLETED",
  };
}

export async function getDesiredStateBackfillSummary() {
  const [candidates, registrations, latestRun] = await Promise.all([
    prisma.$transaction((tx) => loadCandidates(tx)),
    prisma.repositoryRegistration.findMany({
      orderBy: [{ status: "asc" }, { repoFullName: "asc" }],
      select: {
        repoId: true,
        repoFullName: true,
        status: true,
        archived: true,
        managementKind: true,
        classification: true,
        lastDiscoveryReason: true,
      },
    }),
    prisma.desiredStateBackfillRun.findFirst({ orderBy: [{ startedAt: "desc" }, { id: "desc" }] }),
  ]);
  const items = candidates.map((candidate) => {
    const assessment = assessDesiredStateCandidate(candidate);
    return assessment.outcome === "READY"
      ? {
          ...baseItem(candidate),
          outcome: "READY" as const,
          reason: null,
          detail: null,
          sourceObservationId: assessment.sourceObservationId,
        }
      : assessmentItem(candidate, assessment);
  });
  const classificationCounts = {
    PRODUCT_APP: registrations.filter((row) => row.classification === "PRODUCT_APP").length,
    INFRA_REPO: registrations.filter((row) => row.classification === "INFRA_REPO").length,
    PLATFORM_PRODUCER: registrations.filter((row) => row.classification === "PLATFORM_PRODUCER").length,
    EXCLUDED: registrations.filter((row) => row.classification === "EXCLUDED").length,
    LEGACY_APP: registrations.filter((row) => row.classification === null && row.managementKind === "APP").length,
    UNCLASSIFIED: registrations.filter((row) => row.classification === null && row.managementKind !== "APP").length,
    ARCHIVED: registrations.filter((row) => row.status === "ARCHIVED" || row.archived).length,
  };
  const needsInputByReason = Object.fromEntries(
    [...new Set(items
      .filter((item) => item.outcome === "NEEDS_INPUT")
      .map((item) => item.reason)
      .filter((reason): reason is DesiredStateNeedsInputReason => reason !== null))]
      .sort()
      .map((reason) => [reason, items.filter((item) => item.reason === reason).length]),
  );
  return {
    contractVersion: DESIRED_STATE_BACKFILL_CONTRACT_VERSION,
    generatedAt: new Date(),
    registrations: registrations.length,
    classificationCounts,
    activeApps: candidates.length,
    readyForDraft: items.filter((item) => item.outcome === "READY").length,
    alreadyConfigured: items.filter((item) => item.outcome === "ALREADY_CONFIGURED").length,
    needsInput: items.filter((item) => item.outcome === "NEEDS_INPUT").length,
    needsInputByReason,
    items,
    latestRun: latestRun ? {
      id: latestRun.id,
      status: latestRun.status,
      actor: latestRun.actor,
      trigger: latestRun.trigger,
      sourceSha: latestRun.sourceSha,
      requestHash: latestRun.requestHash,
      startedAt: latestRun.startedAt,
      completedAt: latestRun.completedAt,
      summary: storedSummary(latestRun.summary),
    } : null,
  };
}
