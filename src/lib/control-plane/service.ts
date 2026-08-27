import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
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

export async function recordDiscoveryObservation(input: {
  repoId: bigint;
  sourceSha: string;
  sourceRef?: string;
  observedAt: Date;
  observedBy: string;
  idempotencyKey: string;
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
  const replay = await prisma.discoveryObservation.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { app: { select: { repoId: true } } },
  });
  if (replay) {
    assertIdempotentPayload(replay.payloadHash, payloadHash);
    if (replay.app.repoId !== input.repoId || replay.sourceSha !== input.sourceSha.toLowerCase()) {
      throw new ControlPlaneError("idempotency key가 다른 discovery 요청에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
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
        observedAt: input.observedAt,
        observedBy: input.observedBy,
        idempotencyKey: input.idempotencyKey,
        payload: jsonInput(input.payload),
        payloadHash,
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
        payload: { appId: app.id, sourceSha: input.sourceSha, payloadHash },
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
  const replay = await prisma.providerObservation.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { app: { select: { repoId: true } } },
  });
  if (replay) {
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
