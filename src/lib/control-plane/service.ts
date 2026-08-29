import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  androidBuildBindingObservationSchema,
  configRevisionPayloadSchema,
  type AndroidBuildBindingObservation,
  workflowCallerSchema,
  type ReauthGate,
  type WorkflowCaller,
} from "@/lib/control-plane/contracts";
import { createDraftRevisionInTransaction } from "@/lib/control-plane/config-revision-store";
import { latestDiscoveryObservationOrder } from "@/lib/control-plane/discovery-order";
import { jsonDigest, signSnapshot, verifySnapshot, type JsonValue } from "@/lib/control-plane/json";
import {
  type GitHubActionsBuildManifestIdentity,
  GITHUB_ACTIONS_STATIC_WORKFLOW_PATHS,
  type GitHubActionsStaticManifestIdentity,
  type GitHubActionsStaticWorkflowPath,
} from "@/lib/control-plane/github-actions-oidc";
import {
  buildStaticRuntimeManifestReadback,
  StaticRuntimeManifestError,
  type StaticRuntimeBinding,
} from "@/lib/control-plane/static-runtime-manifest";
import {
  buildRuntimeManifestReadback,
  BuildRuntimeManifestError,
} from "@/lib/control-plane/build-runtime-manifest";
import {
  BUILD_TARGET_MARKETS,
  exactBuildTargetIdentity,
  type BuildTargetMarket,
} from "@/lib/control-plane/build-target-identity";

export class ControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export const MAX_OBSERVATION_FUTURE_SKEW_MS = 5 * 60 * 1_000;

/** caller clock 오류가 event-time latest pointer를 영구 오염시키지 못하게 한다. */
export function assertObservationTime(
  observedAt: Date,
  receivedAt = new Date(),
): void {
  const observedTime = observedAt.getTime();
  const receivedTime = receivedAt.getTime();
  if (
    !Number.isFinite(observedTime)
    || !Number.isFinite(receivedTime)
    || observedTime > receivedTime + MAX_OBSERVATION_FUTURE_SKEW_MS
  ) {
    throw new ControlPlaneError(
      "observation 시각이 서버 수신 시각의 허용 범위를 벗어났습니다.",
      400,
      "OBSERVED_AT_FUTURE",
    );
  }
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function appForRepoId(
  client: Prisma.TransactionClient | typeof prisma,
  repoId: bigint,
) {
  const app = await client.app.findUnique({
    where: { repoId },
    select: { id: true, repoId: true, repoFullName: true, slug: true },
  });
  if (!app) throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
  return app;
}

function assertIdempotentPayload(
  storedHash: string,
  payloadHash: string,
): void {
  if (storedHash !== payloadHash) {
    throw new ControlPlaneError(
      "같은 idempotency key가 다른 payload에 사용되었습니다.",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
}

export function assertIdempotentRequestHash(storedHash: string | null, requestHash: string): void {
  if (storedHash !== requestHash) {
    throw new ControlPlaneError(
      "같은 idempotency key가 다른 전체 요청에 사용되었습니다.",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
}

export function discoveryObservationRequestHash(input: {
  repoId: bigint;
  sourceSha: string;
  sourceRef?: string;
  observedAt: Date;
  observedBy: string;
  workflowCaller: WorkflowCaller;
  buildBindings?: AndroidBuildBindingObservation[];
  payload: Record<string, unknown>;
  buildTargets: Array<{
    targetKey: string;
    stack: string;
    market?: string;
    packageId?: string | null;
    bundleId?: string | null;
    configuration?: Record<string, unknown> | null;
  }>;
}): string {
  return jsonDigest({
    repoId: input.repoId.toString(),
    sourceSha: input.sourceSha.toLowerCase(),
    sourceRef: input.sourceRef ?? null,
    observedAt: input.observedAt.toISOString(),
    observedBy: input.observedBy,
    workflowCaller: input.workflowCaller,
    ...(input.buildBindings === undefined ? {} : { buildBindings: input.buildBindings }),
    payload: input.payload,
    buildTargets: input.buildTargets.map((target) => ({
      targetKey: target.targetKey,
      stack: target.stack,
      market: target.market?.toLowerCase() ?? null,
      packageId: target.packageId ?? null,
      bundleId: target.bundleId ?? null,
      configuration: target.configuration ?? null,
    })),
  } as JsonValue);
}

export function providerObservationRequestHash(input: {
  repoId: bigint;
  provider: string;
  resourceType: string;
  resourceId: string;
  observedAt: Date;
  observedBy: string;
  payload: Record<string, unknown>;
  externalBinding?: {
    bindingType: string;
    externalId: string;
    publicIdentity?: string;
    metadata?: Record<string, unknown>;
  };
}): string {
  return jsonDigest({
    repoId: input.repoId.toString(),
    provider: input.provider.toLowerCase(),
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    observedAt: input.observedAt.toISOString(),
    observedBy: input.observedBy,
    payload: input.payload,
    externalBinding: input.externalBinding
      ? {
          bindingType: input.externalBinding.bindingType,
          externalId: input.externalBinding.externalId,
          publicIdentity: input.externalBinding.publicIdentity ?? null,
          metadata: input.externalBinding.metadata ?? null,
        }
      : null,
  } as JsonValue);
}

export function assertConfigRevisionPayload(payload: unknown): asserts payload is Record<string, unknown> {
  const validated = configRevisionPayloadSchema.safeParse(payload);
  if (validated.success) return;
  const paths = validated.error.issues.map((issue) => issue.path.join(".")).filter(Boolean);
  throw new ControlPlaneError(
    `허용된 비민감 Config 계약 밖의 필드 또는 값은 별도 사람 승인 workflow가 필요합니다: ${paths.join(", ") || "unknown"}`,
    403,
    "HUMAN_APPROVAL_REQUIRED",
  );
}

export function assertActivationPreconditions(input: {
  actualActiveRevision: number;
  expectedActiveRevision: number;
  targetStatus: "DRAFT" | "ACTIVE" | "SUPERSEDED";
  shadowImportId?: string | null;
}): void {
  if (input.shadowImportId) {
    throw new ControlPlaneError(
      "Legacy shadow import가 만든 DRAFT는 직접 활성화할 수 없습니다.",
      409,
      "SHADOW_IMPORT_NOT_ACTIVATABLE",
    );
  }
  if (input.actualActiveRevision !== input.expectedActiveRevision) {
    throw new ControlPlaneError(
      `ACTIVE revision 충돌: expected=${input.expectedActiveRevision}, actual=${input.actualActiveRevision}`,
      409,
      "REVISION_CONFLICT",
    );
  }
  if (input.targetStatus !== "DRAFT") {
    throw new ControlPlaneError("DRAFT revision만 활성화할 수 있습니다.", 409, "IMMUTABLE_REVISION");
  }
}

export function resolvedWorkflowCaller(input: {
  profile: string | null;
  packageManager: string | null;
  workingDirectory: string | null;
}): WorkflowCaller {
  const result = workflowCallerSchema.safeParse({
    profile: input.profile,
    packageManager: input.packageManager,
    workingDirectory: input.workingDirectory,
  });
  if (result.success) return result.data;
  throw new ControlPlaneError(
    "요청한 source SHA의 workflow caller 탐지 결과가 없거나 모호합니다.",
    409,
    "NO_WORKFLOW_CALLER_FOR_SHA",
  );
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function observedStaticWorkspaceRoot(input: {
  payload: unknown;
  caller: WorkflowCaller;
  repositoryId: string;
  fullName: string;
  sourceSha: string;
}): string {
  if (input.caller.profile === "godot" || input.caller.workingDirectory === ".") {
    return input.caller.workingDirectory;
  }
  const payload = jsonRecord(input.payload);
  const repository = jsonRecord(payload?.repository);
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  if (
    payload?.schemaVersion !== 2
    || payload?.contractVersion !== "repository-discovery/v7"
    || String(repository?.id ?? "") !== input.repositoryId
    || repository?.fullName !== input.fullName
    || repository?.sourceSha !== input.sourceSha
    || repository?.sourceRef !== "refs/heads/main"
  ) {
    return input.caller.workingDirectory;
  }
  const lockPath = input.caller.packageManager === "pnpm"
    ? "pnpm-lock.yaml"
    : "package-lock.json";
  const observedAtRoot = (expectedPath: string) => sources.some((value) => {
    const source = jsonRecord(value);
    return source?.path === expectedPath
      && source.status === "PRESENT"
      && source.reason === null
      && String(source.repoId ?? "") === input.repositoryId
      && source.fullName === input.fullName
      && source.sourceSha === input.sourceSha
      && source.sourceRef === "refs/heads/main"
      && /^[0-9a-f]{40}$/.test(String(source.blobSha ?? ""))
      && /^[0-9a-f]{64}$/.test(String(source.contentSha256 ?? ""));
  });
  return observedAtRoot("package.json") && observedAtRoot(lockPath)
    ? "."
    : input.caller.workingDirectory;
}

export type DiscoveryObservationInput = {
  repoId: bigint;
  sourceSha: string;
  sourceRef?: string;
  observedAt: Date;
  observedBy: string;
  idempotencyKey: string;
  workflowCaller: WorkflowCaller;
  buildBindings?: AndroidBuildBindingObservation[];
  payload: Record<string, unknown>;
  buildTargets: Array<{
    targetKey: string;
    stack: string;
    market?: string;
    packageId?: string | null;
    bundleId?: string | null;
    configuration?: Record<string, unknown> | null;
  }>;
};

/**
 * Repository discovery reconciler가 App 등록, observation, registration 상태를
 * 하나의 row-lock transaction으로 닫을 수 있게 하는 내부 service 경계다.
 */
export async function recordDiscoveryObservationInTransaction(
  tx: Prisma.TransactionClient,
  input: DiscoveryObservationInput,
) {
  assertObservationTime(input.observedAt);
  const payloadHash = jsonDigest(input.payload as JsonValue);
  const requestHash = discoveryObservationRequestHash(input);
  const replay = await tx.discoveryObservation.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { app: { select: { repoId: true } } },
  });
  if (replay) {
    assertIdempotentRequestHash(replay.requestHash, requestHash);
    assertIdempotentPayload(replay.payloadHash, payloadHash);
    if (replay.app.repoId !== input.repoId || replay.sourceSha !== input.sourceSha.toLowerCase()) {
      throw new ControlPlaneError("idempotency key가 다른 discovery 요청에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    if (
      replay.workflowProfile !== input.workflowCaller.profile
      || replay.workflowPackageManager !== input.workflowCaller.packageManager
      || replay.workflowWorkingDirectory !== input.workflowCaller.workingDirectory
      || jsonDigest((replay.buildBindings ?? []) as JsonValue)
        !== jsonDigest((input.buildBindings ?? []) as JsonValue)
    ) {
      throw new ControlPlaneError("idempotency key가 다른 workflow caller에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { observation: replay, duplicate: true };
  }

  const app = await appForRepoId(tx, input.repoId);
  const observation = await tx.discoveryObservation.create({
    data: {
      appId: app.id,
      sourceSha: input.sourceSha.toLowerCase(),
      sourceRef: input.sourceRef,
      workflowProfile: input.workflowCaller.profile,
      workflowPackageManager: input.workflowCaller.packageManager,
      workflowWorkingDirectory: input.workflowCaller.workingDirectory,
      buildBindings: input.buildBindings?.length
        ? jsonInput(input.buildBindings)
        : Prisma.DbNull,
      observedAt: input.observedAt,
      observedBy: input.observedBy,
      idempotencyKey: input.idempotencyKey,
      payload: jsonInput(input.payload),
      payloadHash,
      requestHash,
    },
  });
  for (const target of input.buildTargets) {
    const market = target.market?.toLowerCase();
    await tx.buildTarget.upsert({
      where: { appId_targetKey: { appId: app.id, targetKey: target.targetKey } },
      create: {
        appId: app.id,
        targetKey: target.targetKey,
        stack: target.stack,
        market,
        packageId: target.packageId ?? null,
        bundleId: target.bundleId ?? null,
        observedSha: input.sourceSha.toLowerCase(),
        observedAt: input.observedAt,
        configuration: target.configuration ? jsonInput(target.configuration) : Prisma.DbNull,
      },
      update: {},
    });
    await tx.buildTarget.updateMany({
      where: {
        appId: app.id,
        targetKey: target.targetKey,
        observedAt: { lte: input.observedAt },
      },
      data: {
        stack: target.stack,
        market,
        packageId: target.packageId ?? null,
        bundleId: target.bundleId ?? null,
        observedSha: input.sourceSha.toLowerCase(),
        observedAt: input.observedAt,
        configuration: target.configuration ? jsonInput(target.configuration) : Prisma.DbNull,
      },
    });
  }
  await tx.auditLog.create({
    data: {
      actorLogin: input.observedBy,
      action: "control-plane.discovery.record",
      entityType: "DiscoveryObservation",
      entityId: observation.id,
      payload: {
        appId: app.id,
        sourceSha: input.sourceSha,
        payloadHash,
        workflowCaller: input.workflowCaller,
      },
    },
  });
  return { observation, duplicate: false };
}

export async function recordDiscoveryObservation(input: DiscoveryObservationInput) {
  return prisma.$transaction((tx) => recordDiscoveryObservationInTransaction(tx, input));
}

export async function recordProviderObservation(input: {
  repoId: bigint;
  provider: string;
  resourceType: string;
  resourceId: string;
  observedAt: Date;
  observedBy: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  externalBinding?: {
    bindingType: string;
    externalId: string;
    publicIdentity?: string;
    metadata?: Record<string, unknown>;
  };
}) {
  assertObservationTime(input.observedAt);
  const provider = input.provider.toLowerCase();
  const payloadHash = jsonDigest(input.payload as JsonValue);
  const requestHash = providerObservationRequestHash(input);
  const replay = await prisma.providerObservation.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { app: { select: { repoId: true } } },
  });
  if (replay) {
    assertIdempotentRequestHash(replay.requestHash, requestHash);
    assertIdempotentPayload(replay.payloadHash, payloadHash);
    if (
      replay.app.repoId !== input.repoId
      || replay.provider !== provider
      || replay.resourceType !== input.resourceType
      || replay.resourceId !== input.resourceId
    ) {
      throw new ControlPlaneError("idempotency key가 다른 provider 요청에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { observation: replay, duplicate: true };
  }
  return prisma.$transaction(async (tx) => {
    const app = await appForRepoId(tx, input.repoId);
    const observation = await tx.providerObservation.create({
      data: {
        appId: app.id,
        provider,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        payload: jsonInput(input.payload),
        payloadHash,
        requestHash,
        observedBy: input.observedBy,
        observedAt: input.observedAt,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (input.externalBinding) {
      const binding = input.externalBinding;
      await tx.externalBinding.upsert({
        where: {
          provider_bindingType_externalId: {
            provider,
            bindingType: binding.bindingType,
            externalId: binding.externalId,
          },
        },
        create: {
          appId: app.id,
          provider,
          bindingType: binding.bindingType,
          externalId: binding.externalId,
          publicIdentity: binding.publicIdentity,
          metadata: binding.metadata ? jsonInput(binding.metadata) : undefined,
          observedAt: input.observedAt,
        },
        update: {},
      });
      await tx.externalBinding.updateMany({
        where: {
          provider,
          bindingType: binding.bindingType,
          externalId: binding.externalId,
          observedAt: { lte: input.observedAt },
        },
        data: {
          appId: app.id,
          publicIdentity: binding.publicIdentity,
          metadata: binding.metadata ? jsonInput(binding.metadata) : Prisma.JsonNull,
          observedAt: input.observedAt,
        },
      });
    }
    await tx.auditLog.create({
      data: {
        actorLogin: input.observedBy,
        action: "control-plane.provider.record",
        entityType: "ProviderObservation",
        entityId: observation.id,
        payload: {
          appId: app.id,
          provider,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          payloadHash,
        },
      },
    });
    return { observation, duplicate: false };
  });
}

export async function createConfigRevision(input: {
  repoId: bigint;
  payload: Record<string, unknown>;
  actor: string;
  idempotencyKey: string;
}) {
  assertConfigRevisionPayload(input.payload);
  const payloadHash = jsonDigest(input.payload as JsonValue);
  const replay = await prisma.configRevision.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { app: { select: { repoId: true } } },
  });
  if (replay) {
    assertIdempotentPayload(replay.payloadHash, payloadHash);
    if (replay.app.repoId !== input.repoId) {
      throw new ControlPlaneError("idempotency key가 다른 config 요청에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { revision: replay, duplicate: true };
  }

  return prisma.$transaction(async (tx) => {
    const app = await appForRepoId(tx, input.repoId);
    await tx.$queryRaw`SELECT id FROM app WHERE id = ${app.id} FOR UPDATE`;
    const afterLockReplay = await tx.configRevision.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (afterLockReplay) {
      assertIdempotentPayload(afterLockReplay.payloadHash, payloadHash);
      if (afterLockReplay.appId !== app.id) {
        throw new ControlPlaneError("idempotency key가 다른 config 요청에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
      }
      return { revision: afterLockReplay, duplicate: true };
    }
    const revision = await createDraftRevisionInTransaction(tx, {
      appId: app.id,
      payload: input.payload,
      payloadHash,
      createdBy: input.actor,
      idempotencyKey: input.idempotencyKey,
    });
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.config.create",
        entityType: "ConfigRevision",
        entityId: revision.id,
        payload: { appId: app.id, revision: revision.revision, payloadHash },
      },
    });
    return { revision, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function activateConfigRevision(input: {
  repoId: bigint;
  revision: number;
  expectedActiveRevision: number;
  actor: string;
  idempotencyKey: string;
  signingKey: string;
}) {
  const replay = await prisma.configRevision.findUnique({
    where: { activationIdempotencyKey: input.idempotencyKey },
    include: { app: { select: { repoId: true } } },
  });
  if (replay) {
    if (replay.revision !== input.revision || replay.app.repoId !== input.repoId) {
      throw new ControlPlaneError(
        "같은 idempotency key가 다른 revision activation에 사용되었습니다.",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    }
    return { revision: replay, duplicate: true };
  }

  return prisma.$transaction(async (tx) => {
    const app = await appForRepoId(tx, input.repoId);
    await tx.$queryRaw`SELECT id FROM app WHERE id = ${app.id} FOR UPDATE`;
    const active = await tx.configRevision.findFirst({
      where: { appId: app.id, status: "ACTIVE" },
      orderBy: { revision: "desc" },
    });
    const target = await tx.configRevision.findUnique({
      where: { appId_revision: { appId: app.id, revision: input.revision } },
      include: { legacyConfigImport: { select: { id: true } } },
    });
    if (!target) throw new ControlPlaneError("Config revision을 찾을 수 없습니다.", 404, "REVISION_NOT_FOUND");
    // 새 validator 도입 전에 생성된 DRAFT도 activation 시 다시 검사해 우회를 막는다.
    assertConfigRevisionPayload(target.payload);
    assertActivationPreconditions({
      actualActiveRevision: active?.revision ?? 0,
      expectedActiveRevision: input.expectedActiveRevision,
      targetStatus: target.status,
      // append-only import relation이 운영자 DB 조작으로 훼손돼도 파생 DRAFT key가
      // 남아 있는 한 activation을 fail-closed한다.
      shadowImportId: target.legacyConfigImport?.id
        ?? (target.idempotencyKey.startsWith("legacy-shadow-draft:") ? target.idempotencyKey : null),
    });

    const activatedAt = new Date();
    const snapshot = {
      schemaVersion: 1,
      appId: app.id,
      repoId: app.repoId?.toString() ?? null,
      repoFullName: app.repoFullName,
      revision: target.revision,
      payloadHash: target.payloadHash,
      payload: target.payload,
      activatedAt: activatedAt.toISOString(),
    } as JsonValue;
    const signed = signSnapshot(snapshot, input.signingKey);

    if (active) {
      await tx.configRevision.update({
        where: { id: active.id },
        data: {
          status: "SUPERSEDED",
          activeSlot: null,
          supersededAt: activatedAt,
        },
      });
    }
    const updated = await tx.configRevision.updateMany({
      where: { id: target.id, status: "DRAFT", activeSlot: null },
      data: {
        status: "ACTIVE",
        activeSlot: app.id,
        activationIdempotencyKey: input.idempotencyKey,
        activatedSnapshot: jsonInput(snapshot),
        snapshotDigest: signed.digest,
        snapshotSignature: signed.signature,
        activatedAt,
      },
    });
    if (updated.count !== 1) {
      throw new ControlPlaneError("Config revision activation CAS에 실패했습니다.", 409, "REVISION_CONFLICT");
    }
    const revision = await tx.configRevision.findUniqueOrThrow({ where: { id: target.id } });
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.config.activate",
        entityType: "ConfigRevision",
        entityId: revision.id,
        payload: {
          appId: app.id,
          revision: revision.revision,
          previousRevision: active?.revision ?? null,
          snapshotDigest: signed.digest,
        },
      },
    });
    return { revision, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function recordReauthRequest(input: {
  repoId: bigint;
  runId?: string;
  provider: string;
  origin: string;
  publicAccountId: string;
  capability: string;
  gate: ReauthGate;
  actor: string;
  idempotencyKey: string;
}) {
  const provider = input.provider.toLowerCase();
  const origin = new URL(input.origin).origin;
  const replay = await prisma.reauthRequest.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { app: { select: { repoId: true } } },
  });
  if (replay) {
    if (
      replay.app.repoId !== input.repoId
      || replay.runId !== (input.runId ?? null)
      || replay.provider !== provider
      || replay.origin !== origin
      || replay.publicAccountId !== input.publicAccountId
      || replay.capability !== input.capability
      || replay.gate !== input.gate
      || replay.requestedBy !== input.actor
    ) {
      throw new ControlPlaneError(
        "idempotency key가 다른 reauth 요청에 사용되었습니다.",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    }
    return { request: replay, duplicate: true };
  }

  return prisma.$transaction(async (tx) => {
    const app = await appForRepoId(tx, input.repoId);
    if (input.runId) {
      const run = await tx.agentRun.findUnique({
        where: { id: input.runId },
        select: { appId: true, repoFullName: true },
      });
      if (!run || (run.appId !== app.id && run.repoFullName.toLowerCase() !== app.repoFullName.toLowerCase())) {
        throw new ControlPlaneError("reauth run이 앱 범위와 일치하지 않습니다.", 409, "RUN_SCOPE_MISMATCH");
      }
    }
    const request = await tx.reauthRequest.create({
      data: {
        appId: app.id,
        runId: input.runId,
        provider,
        origin,
        publicAccountId: input.publicAccountId,
        capability: input.capability,
        gate: input.gate,
        requestedBy: input.actor,
        idempotencyKey: input.idempotencyKey,
      },
    });
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.reauth.request",
        entityType: "ReauthRequest",
        entityId: request.id,
        payload: {
          appId: app.id,
          runId: input.runId ?? null,
          provider,
          origin,
          publicAccountId: input.publicAccountId,
          capability: input.capability,
          gate: input.gate,
        },
      },
    });
    return { request, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function listReauthRequests(repoId: bigint) {
  const app = await appForRepoId(prisma, repoId);
  return prisma.reauthRequest.findMany({
    where: { appId: app.id },
    orderBy: { createdAt: "desc" },
    take: 100,
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
      updatedAt: true,
    },
  });
}

/** Backoffice의 DB session/RBAC를 통과한 사람 UI server action에서만 호출한다. */
export async function markReauthTrustedLocalPendingFromHumanUi(input: {
  repoId: bigint;
  reauthRequestId: string;
  expectedGeneration: number;
  actor: string;
  idempotencyKey: string;
}) {
  const replay = await prisma.reauthRequest.findUnique({
    where: { trustedLocalIdempotencyKey: input.idempotencyKey },
    include: { app: { select: { repoId: true } } },
  });
  if (replay) {
    if (
      replay.id !== input.reauthRequestId
      || replay.app.repoId !== input.repoId
      || replay.trustedLocalRequestedBy !== input.actor
    ) {
      throw new ControlPlaneError(
        "idempotency key가 다른 trusted-local 요청에 사용되었습니다.",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    }
    return { request: replay, duplicate: true };
  }

  return prisma.$transaction(async (tx) => {
    const app = await appForRepoId(tx, input.repoId);
    const requestedAt = new Date();
    const updated = await tx.reauthRequest.updateMany({
      where: {
        id: input.reauthRequestId,
        appId: app.id,
        status: "HUMAN_REAUTH_REQUIRED",
        generation: input.expectedGeneration,
        trustedLocalIdempotencyKey: null,
      },
      data: {
        status: "TRUSTED_LOCAL_PENDING",
        generation: { increment: 1 },
        trustedLocalIdempotencyKey: input.idempotencyKey,
        trustedLocalRequestedBy: input.actor,
        trustedLocalRequestedAt: requestedAt,
      },
    });
    if (updated.count !== 1) {
      throw new ControlPlaneError(
        "reauth 상태가 변경되었거나 이미 trusted-local 대기 중입니다.",
        409,
        "REAUTH_STATE_CONFLICT",
      );
    }
    const request = await tx.reauthRequest.findUniqueOrThrow({
      where: { id: input.reauthRequestId },
    });
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.reauth.trusted-local-pending.human-ui",
        entityType: "ReauthRequest",
        entityId: request.id,
        payload: {
          appId: request.appId,
          generation: request.generation,
          provider: request.provider,
          publicAccountId: request.publicAccountId,
          transitionSource: "BACKOFFICE_HUMAN_UI",
        },
      },
    });
    return { request, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function resolveManifest(input: {
  repoId: bigint;
  sourceSha: string;
  market?: string;
  revision?: number;
  signingKey: string;
}) {
  const app = await appForRepoId(prisma, input.repoId);
  const revision = input.revision
    ? await prisma.configRevision.findUnique({
        where: { appId_revision: { appId: app.id, revision: input.revision } },
      })
    : await prisma.configRevision.findFirst({ where: { appId: app.id, status: "ACTIVE" } });
  if (!revision) {
    throw new ControlPlaneError("활성화된 Config revision이 없습니다.", 409, "NO_ACTIVE_CONFIG");
  }
  const configPayload = configPayloadFromSignedSnapshot({
    revision,
    signingKey: input.signingKey,
    appId: app.id,
    repoId: input.repoId.toString(),
    repoFullName: app.repoFullName,
  });
  const discovery = await prisma.discoveryObservation.findFirst({
    where: { appId: app.id, sourceSha: input.sourceSha.toLowerCase() },
    orderBy: latestDiscoveryObservationOrder(),
  });
  if (!discovery) {
    throw new ControlPlaneError("요청한 source SHA의 discovery observation이 없습니다.", 409, "NO_DISCOVERY_FOR_SHA");
  }
  const workflowCaller = resolvedWorkflowCaller({
    profile: discovery.workflowProfile,
    packageManager: discovery.workflowPackageManager,
    workingDirectory: discovery.workflowWorkingDirectory,
  });
  const requestedMarket = input.market?.toLowerCase();
  if (
    requestedMarket
    && !BUILD_TARGET_MARKETS.includes(requestedMarket as BuildTargetMarket)
  ) {
    throw new ControlPlaneError("지원하지 않는 market입니다.", 409, "MARKET_NOT_ENABLED");
  }
  const market = requestedMarket as BuildTargetMarket | undefined;
  const enabledMarkets = configPayload.markets
    .filter((profile) => profile.enabled)
    .map((profile) => profile.market);
  if (market && !enabledMarkets.includes(market)) {
    throw new ControlPlaneError("ACTIVE revision에서 활성화된 market이 아닙니다.", 409, "MARKET_NOT_ENABLED");
  }
  const [buildTargets, externalBindings, providerRows, platformFleet] = await Promise.all([
    prisma.buildTarget.findMany({
      where: {
        appId: app.id,
        observedSha: input.sourceSha.toLowerCase(),
        ...(market ? { OR: [{ market }, { market: null }] } : {}),
      },
      orderBy: { targetKey: "asc" },
    }),
    prisma.externalBinding.findMany({
      where: { appId: app.id, ...(market ? { provider: market } : {}) },
      orderBy: [{ provider: "asc" }, { bindingType: "asc" }],
    }),
    prisma.providerObservation.findMany({
      where: { appId: app.id, ...(market ? { provider: market } : {}) },
      orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    }),
    prisma.platformFleetBinding.findUnique({ where: { appId: app.id } }),
  ]);
  const latestProvider = new Map<string, (typeof providerRows)[number]>();
  for (const row of providerRows) {
    const key = `${row.provider}:${row.resourceType}:${row.resourceId}`;
    if (!latestProvider.has(key)) latestProvider.set(key, row);
  }
  for (const requiredMarket of market ? [market] : enabledMarkets) {
    const identity = exactBuildTargetIdentity(buildTargets, requiredMarket, externalBindings);
    if (identity.status === "TARGET_MISSING" || identity.status === "TARGET_AMBIGUOUS") {
      throw new ControlPlaneError(
        "요청한 source SHA와 market에 고정된 BuildTarget이 하나 필요합니다.",
        409,
        "BUILD_TARGET_MISMATCH",
      );
    }
    if (identity.status !== "READY") {
      const code = identity.status === "EXTERNAL_BINDING_AMBIGUOUS"
        ? "BUILD_IDENTITY_AMBIGUOUS"
        : identity.status === "IDENTITY_CONFLICT"
          ? "BUILD_IDENTITY_CONFLICT"
          : "BUILD_IDENTITY_MISSING";
      throw new ControlPlaneError(
        "요청한 source SHA와 provider application binding의 공개 build identity를 확정할 수 없습니다.",
        409,
        code,
      );
    }
  }
  return {
    schemaVersion: 1,
    resolvedAt: new Date().toISOString(),
    app: { ...app, repoId: app.repoId?.toString() ?? null },
    source: {
      sha: input.sourceSha.toLowerCase(),
      ref: discovery.sourceRef,
      observationId: discovery.id,
      payload: discovery.payload,
    },
    workflowCaller,
    config: {
      id: revision.id,
      revision: revision.revision,
      status: revision.status,
      snapshot: revision.activatedSnapshot,
      digest: revision.snapshotDigest,
      signature: revision.snapshotSignature,
    },
    ...(configPayload.build?.workflowBundleSha && configPayload.build.workflowBundleDigest
      ? {
          workflowBundleBinding: {
            sourceSha: configPayload.build.workflowBundleSha.toLowerCase(),
            payloadDigest: configPayload.build.workflowBundleDigest.toLowerCase(),
          },
        }
      : {}),
    market: market ?? null,
    buildTargets,
    externalBindings,
    providerObservations: [...latestProvider.values()],
    platformFleet,
  };
}

export async function resolveStaticRuntimeManifest(input: {
  identity: GitHubActionsStaticManifestIdentity;
  signingKey: string;
  snapshotSignatureKeyId: string;
  snapshotSignaturePolicyRevision: string;
}, client: Pick<typeof prisma, "app" | "configRevision" | "discoveryObservation"> = prisma) {
  const repositoryId = BigInt(input.identity.repositoryId);
  const app = await client.app.findUnique({
    where: { repoId: repositoryId },
    select: {
      id: true,
      repoId: true,
      repoFullName: true,
      status: true,
      isPublicRepo: true,
    },
  });
  if (!app) throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
  if (
    app.repoId !== repositoryId
    || app.repoFullName !== input.identity.fullName
  ) {
    throw new ControlPlaneError(
      "GitHub OIDC repository identity가 중앙 App binding과 일치하지 않습니다.",
      403,
      "REPOSITORY_IDENTITY_MISMATCH",
    );
  }
  const expectedVisibility = app.isPublicRepo ? "public" : "private";
  const expectedRunner = app.isPublicRepo ? "github-hosted" : "self-hosted";
  if (
    input.identity.repositoryVisibility !== expectedVisibility
    || input.identity.runnerEnvironment !== expectedRunner
  ) {
    throw new ControlPlaneError(
      "repository visibility 또는 runner trust boundary가 중앙 binding과 일치하지 않습니다.",
      403,
      "RUNNER_TRUST_BOUNDARY_MISMATCH",
    );
  }

  const revision = await client.configRevision.findFirst({
    where: { appId: app.id, status: "ACTIVE" },
  });
  if (!revision) {
    throw new ControlPlaneError("활성화된 Config revision이 없습니다.", 409, "NO_ACTIVE_CONFIG");
  }
  const configPayload = configPayloadFromSignedSnapshot({
    revision,
    signingKey: input.signingKey,
    appId: app.id,
    repoId: input.identity.repositoryId,
    repoFullName: app.repoFullName,
  });
  if (
    !configPayload.build?.workflowBundleSha
    || configPayload.build.workflowBundleSha.toLowerCase() !== input.identity.workflowBundleSha
  ) {
    throw new ControlPlaneError(
      "ACTIVE revision이 요청한 WorkflowBundle SHA를 승인하지 않았습니다.",
      409,
      "WORKFLOW_BUNDLE_NOT_APPROVED",
    );
  }

  const discovery = await client.discoveryObservation.findFirst({
    where: {
      appId: app.id,
      sourceSha: input.identity.bindingSourceSha,
    },
    orderBy: latestDiscoveryObservationOrder(),
  });
  if (!discovery) {
    throw new ControlPlaneError(
      "binding source SHA의 discovery observation이 없습니다.",
      409,
      "NO_DISCOVERY_FOR_SHA",
    );
  }
  if (discovery.sourceRef !== "refs/heads/main" || !discovery.requestHash) {
    throw new ControlPlaneError(
      "main exact-SHA discovery provenance를 검증할 수 없습니다.",
      409,
      "DISCOVERY_PROVENANCE_INVALID",
    );
  }
  const workflowCaller = resolvedWorkflowCaller({
    profile: discovery.workflowProfile,
    packageManager: discovery.workflowPackageManager,
    workingDirectory: discovery.workflowWorkingDirectory,
  });
  const expectedCalledWorkflowPath: GitHubActionsStaticWorkflowPath =
    workflowCaller.profile === "godot"
      ? GITHUB_ACTIONS_STATIC_WORKFLOW_PATHS.godot
      : GITHUB_ACTIONS_STATIC_WORKFLOW_PATHS.javascript;
  if (input.identity.calledWorkflowPath !== expectedCalledWorkflowPath) {
    throw new ControlPlaneError(
      "호출된 중앙 workflow와 exact-SHA discovery profile이 일치하지 않습니다.",
      409,
      "STATIC_WORKFLOW_PROFILE_MISMATCH",
    );
  }
  const workflowDirectories = {
    workspaceRoot: observedStaticWorkspaceRoot({
      payload: discovery.payload,
      caller: workflowCaller,
      repositoryId: input.identity.repositoryId,
      fullName: app.repoFullName,
      sourceSha: input.identity.bindingSourceSha,
    }),
    commandDirectory: workflowCaller.workingDirectory,
  };
  const staticBinding: StaticRuntimeBinding = workflowCaller.profile === "godot"
    ? {
        ...workflowDirectories,
        profile: workflowCaller.profile,
        packageManager: workflowCaller.packageManager,
      }
    : {
        ...workflowDirectories,
        profile: workflowCaller.profile,
        packageManager: workflowCaller.packageManager,
      };
  if (!revision.snapshotDigest || !revision.snapshotSignature) {
    throw new ControlPlaneError(
      "Config snapshot 서명 provenance를 확인할 수 없습니다.",
      409,
      "INVALID_CONFIG_SIGNATURE",
    );
  }
  try {
    return buildStaticRuntimeManifestReadback({
      lifecycleState: app.status,
      repositoryId: input.identity.repositoryId,
      fullName: app.repoFullName,
      bindingSourceSha: input.identity.bindingSourceSha,
      applicationSourceSha: input.identity.applicationSourceSha,
      observationId: discovery.id,
      observationRequestHash: discovery.requestHash,
      configRevisionId: revision.id,
      configRevision: revision.revision,
      configRevisionPayloadHash: revision.payloadHash,
      signedSnapshotDigest: revision.snapshotDigest,
      snapshotSignature: revision.snapshotSignature,
      snapshotSignatureKeyId: input.snapshotSignatureKeyId,
      snapshotSignaturePolicyRevision: input.snapshotSignaturePolicyRevision,
      staticBinding,
    });
  } catch (error) {
    if (error instanceof StaticRuntimeManifestError) {
      throw new ControlPlaneError(
        "서명된 runtime manifest provenance를 생성할 수 없습니다.",
        error.code === "SNAPSHOT_SIGNATURE_IDENTITY_MISSING" ? 503 : 409,
        error.code,
      );
    }
    throw error;
  }
}

export async function resolveBuildRuntimeManifest(input: {
  identity: GitHubActionsBuildManifestIdentity;
  signingKey: string;
  snapshotSignatureKeyId: string;
  snapshotSignaturePolicyRevision: string;
}, client: Pick<
  typeof prisma,
  "app" | "configRevision" | "discoveryObservation" | "workflowBundleRegistryRecord"
> = prisma) {
  const repositoryId = BigInt(input.identity.repositoryId);
  const app = await client.app.findUnique({
    where: { repoId: repositoryId },
    select: {
      id: true,
      repoId: true,
      repoFullName: true,
      status: true,
      isPublicRepo: true,
    },
  });
  if (!app) throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
  if (app.repoId !== repositoryId || app.repoFullName !== input.identity.fullName) {
    throw new ControlPlaneError(
      "GitHub OIDC repository identity가 중앙 App binding과 일치하지 않습니다.",
      403,
      "REPOSITORY_IDENTITY_MISMATCH",
    );
  }
  if (app.isPublicRepo || input.identity.repositoryVisibility !== "private"
    || input.identity.runnerEnvironment !== "self-hosted") {
    throw new ControlPlaneError(
      "Android build-only runtime은 private repository의 trusted self-hosted 경계만 허용합니다.",
      403,
      "RUNNER_TRUST_BOUNDARY_MISMATCH",
    );
  }
  if (app.status !== "ACTIVE") {
    throw new ControlPlaneError(
      "ACTIVE 앱만 build-only runtime을 사용할 수 있습니다.",
      403,
      `${app.status}_BUILD_RUNTIME_FORBIDDEN`,
    );
  }

  const revision = await client.configRevision.findFirst({
    where: { appId: app.id, status: "ACTIVE" },
  });
  if (!revision) {
    throw new ControlPlaneError("활성화된 Config revision이 없습니다.", 409, "NO_ACTIVE_CONFIG");
  }
  const configPayload = configPayloadFromSignedSnapshot({
    revision,
    signingKey: input.signingKey,
    appId: app.id,
    repoId: input.identity.repositoryId,
    repoFullName: app.repoFullName,
  });
  if (
    configPayload.build?.workflowBundleSha?.toLowerCase() !== input.identity.workflowBundleSha
    || !configPayload.build.workflowBundleDigest
  ) {
    throw new ControlPlaneError(
      "ACTIVE revision이 WorkflowBundle source SHA와 payload digest를 함께 승인하지 않았습니다.",
      409,
      "WORKFLOW_BUNDLE_BINDING_MISSING",
    );
  }
  const workflowBundlePayloadDigest = configPayload.build.workflowBundleDigest.toLowerCase();
  const registry = await client.workflowBundleRegistryRecord.findFirst({
    where: {
      registryId: "seorilabs-workflow-bundles-v5",
      subject: `workflow-bundle-v5:${input.identity.workflowBundleSha}`,
      sourceSha: input.identity.workflowBundleSha,
      workflowExecutionSha: input.identity.workflowBundleSha,
      payloadDigest: workflowBundlePayloadDigest,
      approvalState: input.identity.mode,
    },
  });
  if (
    !registry
    || registry.sourceSha !== input.identity.workflowBundleSha
    || registry.workflowExecutionSha !== input.identity.workflowBundleSha
    || registry.payloadDigest !== workflowBundlePayloadDigest
    || registry.approvalState !== input.identity.mode
  ) {
    throw new ControlPlaneError(
      "Config와 분리된 immutable WorkflowBundle registry readback이 없습니다.",
      409,
      "WORKFLOW_BUNDLE_REGISTRY_READBACK_MISSING",
    );
  }
  if (
    input.identity.mode === "CANDIDATE"
      ? !registry.artifactRunId || !registry.artifactId || !registry.artifactDigest
      : !registry.approvalPayloadDigest || !registry.approvalKeyId || !registry.approvalPolicyRevision
  ) {
    throw new ControlPlaneError(
      "WorkflowBundle registry provenance가 불완전합니다.",
      409,
      "WORKFLOW_BUNDLE_REGISTRY_PROVENANCE_INVALID",
    );
  }
  const { verifyWorkflowBundleRegistryReadback } = await import(
    "@/lib/control-plane/workflow-bundle-v5-registry"
  );
  verifyWorkflowBundleRegistryReadback(
    registry,
    process.env.WORKFLOW_BUNDLE_V5_APPROVAL_PUBLIC_KEYS_JSON ?? "",
  );

  const discovery = await client.discoveryObservation.findFirst({
    where: {
      appId: app.id,
      sourceSha: input.identity.applicationSourceSha,
    },
    orderBy: latestDiscoveryObservationOrder(),
  });
  if (!discovery) {
    throw new ControlPlaneError(
      "application source SHA의 discovery observation이 없습니다.",
      409,
      "NO_DISCOVERY_FOR_SHA",
    );
  }
  if (discovery.sourceRef !== "refs/heads/main" || !discovery.requestHash) {
    throw new ControlPlaneError(
      "main exact-SHA discovery provenance를 검증할 수 없습니다.",
      409,
      "DISCOVERY_PROVENANCE_INVALID",
    );
  }
  const bindingResult = androidBuildBindingObservationSchema.array().length(1).safeParse(
    discovery.buildBindings,
  );
  if (!bindingResult.success) {
    throw new ControlPlaneError(
      "exact-SHA discovery에 단일 Android build binding fact가 없습니다.",
      409,
      "BUILD_BINDING_OBSERVATION_MISSING",
    );
  }
  const buildBinding = bindingResult.data[0];
  if (buildBinding.buildProfile !== input.identity.buildProfile) {
    throw new ControlPlaneError(
      "호출된 중앙 build workflow와 discovery build profile이 일치하지 않습니다.",
      409,
      "BUILD_WORKFLOW_PROFILE_MISMATCH",
    );
  }
  if (!revision.snapshotDigest || !revision.snapshotSignature) {
    throw new ControlPlaneError(
      "Config snapshot 서명 provenance를 확인할 수 없습니다.",
      409,
      "INVALID_CONFIG_SIGNATURE",
    );
  }
  try {
    return buildRuntimeManifestReadback({
      mode: input.identity.mode,
      lifecycleState: app.status,
      repositoryId: input.identity.repositoryId,
      fullName: app.repoFullName,
      applicationSourceSha: input.identity.applicationSourceSha,
      eventSourceSha: input.identity.eventSourceSha,
      observationId: discovery.id,
      observationRequestHash: discovery.requestHash,
      configRevisionId: revision.id,
      configRevision: revision.revision,
      configRevisionPayloadHash: revision.payloadHash,
      signedSnapshotDigest: revision.snapshotDigest,
      snapshotSignature: revision.snapshotSignature,
      snapshotSignatureKeyId: input.snapshotSignatureKeyId,
      snapshotSignaturePolicyRevision: input.snapshotSignaturePolicyRevision,
      workflowBundleSourceSha: registry.sourceSha,
      workflowBundlePayloadDigest: registry.payloadDigest,
      buildBinding,
    });
  } catch (error) {
    if (error instanceof BuildRuntimeManifestError) {
      throw new ControlPlaneError(
        "서명된 build runtime manifest provenance를 생성할 수 없습니다.",
        error.code === "SNAPSHOT_SIGNATURE_IDENTITY_MISSING" ? 503 : 409,
        error.code,
      );
    }
    throw error;
  }
}

/** 운영 resolve와 격리 복구 rehearsal이 동일한 fail-closed 경계를 검증한다. */
export function assertResolvableConfigRevision(revision: {
  status: "DRAFT" | "ACTIVE" | "SUPERSEDED";
  activatedSnapshot: unknown;
  snapshotDigest: string | null;
  snapshotSignature: string | null;
}, signingKey: string): asserts revision is typeof revision & { activatedSnapshot: JsonValue } {
  if (revision.status === "DRAFT" || !revision.activatedSnapshot) {
    throw new ControlPlaneError("활성화된 Config revision이 없습니다.", 409, "NO_ACTIVE_CONFIG");
  }
  if (!verifySnapshot(
    revision.activatedSnapshot as JsonValue,
    signingKey,
    revision.snapshotDigest,
    revision.snapshotSignature,
  )) {
    throw new ControlPlaneError("Config snapshot 서명을 검증할 수 없습니다.", 409, "INVALID_CONFIG_SIGNATURE");
  }
}

function configPayloadFromSignedSnapshot(input: {
  revision: {
    id: string;
    revision: number;
    status: "DRAFT" | "ACTIVE" | "SUPERSEDED";
    payload: unknown;
    payloadHash: string;
    activatedSnapshot: unknown;
    snapshotDigest: string | null;
    snapshotSignature: string | null;
  };
  signingKey: string;
  appId: string;
  repoId: string;
  repoFullName: string;
}) {
  assertResolvableConfigRevision({
    status: input.revision.status,
    activatedSnapshot: input.revision.activatedSnapshot,
    snapshotDigest: input.revision.snapshotDigest,
    snapshotSignature: input.revision.snapshotSignature,
  }, input.signingKey);
  const snapshot = input.revision.activatedSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new ControlPlaneError(
      "서명된 Config snapshot envelope를 확인할 수 없습니다.",
      409,
      "INVALID_CONFIG_SIGNATURE",
    );
  }
  const snapshotRecord = snapshot as Record<string, unknown>;
  const snapshotPayload = snapshotRecord.payload;
  if (
    snapshotRecord.schemaVersion !== 1
    || snapshotRecord.appId !== input.appId
    || snapshotRecord.repoId !== input.repoId
    || snapshotRecord.repoFullName !== input.repoFullName
    || snapshotRecord.revision !== input.revision.revision
    || snapshotRecord.payloadHash !== input.revision.payloadHash
    || !snapshotPayload
    || typeof snapshotPayload !== "object"
    || Array.isArray(snapshotPayload)
    || jsonDigest(snapshotPayload as JsonValue) !== input.revision.payloadHash
    || jsonDigest(input.revision.payload as JsonValue) !== input.revision.payloadHash
  ) {
    throw new ControlPlaneError(
      "서명된 Config snapshot identity와 immutable revision이 일치하지 않습니다.",
      409,
      "INVALID_CONFIG_SIGNATURE",
    );
  }
  return configRevisionPayloadSchema.parse(snapshotPayload);
}
