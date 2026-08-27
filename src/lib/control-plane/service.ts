import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  configRevisionPayloadSchema,
  workflowCallerSchema,
  type ReauthGate,
  type WorkflowCaller,
} from "@/lib/control-plane/contracts";
import { jsonDigest, signSnapshot, verifySnapshot, type JsonValue } from "@/lib/control-plane/json";

export class ControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
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
  payload: Record<string, unknown>;
  buildTargets: Array<{
    targetKey: string;
    stack: string;
    market?: string;
    packageId?: string;
    bundleId?: string;
    configuration?: Record<string, unknown>;
  }>;
}): string {
  return jsonDigest({
    repoId: input.repoId.toString(),
    sourceSha: input.sourceSha.toLowerCase(),
    sourceRef: input.sourceRef ?? null,
    observedAt: input.observedAt.toISOString(),
    observedBy: input.observedBy,
    workflowCaller: input.workflowCaller,
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
}): void {
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

export async function recordDiscoveryObservation(input: {
  repoId: bigint;
  sourceSha: string;
  sourceRef?: string;
  observedAt: Date;
  observedBy: string;
  idempotencyKey: string;
  workflowCaller: WorkflowCaller;
  payload: Record<string, unknown>;
  buildTargets: Array<{
    targetKey: string;
    stack: string;
    market?: string;
    packageId?: string;
    bundleId?: string;
    configuration?: Record<string, unknown>;
  }>;
}) {
  const payloadHash = jsonDigest(input.payload as JsonValue);
  const requestHash = discoveryObservationRequestHash(input);
  const replay = await prisma.discoveryObservation.findUnique({
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
    ) {
      throw new ControlPlaneError("idempotency key가 다른 workflow caller에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { observation: replay, duplicate: true };
  }

  return prisma.$transaction(async (tx) => {
    const app = await appForRepoId(tx, input.repoId);
    const observation = await tx.discoveryObservation.create({
      data: {
        appId: app.id,
        sourceSha: input.sourceSha.toLowerCase(),
        sourceRef: input.sourceRef,
        workflowProfile: input.workflowCaller.profile,
        workflowPackageManager: input.workflowCaller.packageManager,
        workflowWorkingDirectory: input.workflowCaller.workingDirectory,
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
          packageId: target.packageId,
          bundleId: target.bundleId,
          observedSha: input.sourceSha.toLowerCase(),
          observedAt: input.observedAt,
          configuration: target.configuration ? jsonInput(target.configuration) : undefined,
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
          packageId: target.packageId,
          bundleId: target.bundleId,
          observedSha: input.sourceSha.toLowerCase(),
          observedAt: input.observedAt,
          configuration: target.configuration ? jsonInput(target.configuration) : Prisma.JsonNull,
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
  });
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
    const latest = await tx.configRevision.aggregate({
      where: { appId: app.id },
      _max: { revision: true },
    });
    const revision = await tx.configRevision.create({
      data: {
        appId: app.id,
        revision: (latest._max.revision ?? 0) + 1,
        status: "DRAFT",
        payload: jsonInput(input.payload),
        payloadHash,
        createdBy: input.actor,
        idempotencyKey: input.idempotencyKey,
      },
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
    });
    if (!target) throw new ControlPlaneError("Config revision을 찾을 수 없습니다.", 404, "REVISION_NOT_FOUND");
    // 새 validator 도입 전에 생성된 DRAFT도 activation 시 다시 검사해 우회를 막는다.
    assertConfigRevisionPayload(target.payload);
    assertActivationPreconditions({
      actualActiveRevision: active?.revision ?? 0,
      expectedActiveRevision: input.expectedActiveRevision,
      targetStatus: target.status,
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
  if (!revision || revision.status === "DRAFT" || !revision.activatedSnapshot) {
    throw new ControlPlaneError("활성화된 Config revision이 없습니다.", 409, "NO_ACTIVE_CONFIG");
  }
  if (!verifySnapshot(
    revision.activatedSnapshot as JsonValue,
    input.signingKey,
    revision.snapshotDigest,
    revision.snapshotSignature,
  )) {
    throw new ControlPlaneError("Config snapshot 서명을 검증할 수 없습니다.", 409, "INVALID_CONFIG_SIGNATURE");
  }
  const discovery = await prisma.discoveryObservation.findFirst({
    where: { appId: app.id, sourceSha: input.sourceSha.toLowerCase() },
    orderBy: { observedAt: "desc" },
  });
  if (!discovery) {
    throw new ControlPlaneError("요청한 source SHA의 discovery observation이 없습니다.", 409, "NO_DISCOVERY_FOR_SHA");
  }
  const workflowCaller = resolvedWorkflowCaller({
    profile: discovery.workflowProfile,
    packageManager: discovery.workflowPackageManager,
    workingDirectory: discovery.workflowWorkingDirectory,
  });
  const market = input.market?.toLowerCase();
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
      orderBy: { observedAt: "desc" },
    }),
    prisma.platformFleetBinding.findUnique({ where: { appId: app.id } }),
  ]);
  const latestProvider = new Map<string, (typeof providerRows)[number]>();
  for (const row of providerRows) {
    const key = `${row.provider}:${row.resourceType}:${row.resourceId}`;
    if (!latestProvider.has(key)) latestProvider.set(key, row);
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
    market: market ?? null,
    buildTargets,
    externalBindings,
    providerObservations: [...latestProvider.values()],
    platformFleet,
  };
}
