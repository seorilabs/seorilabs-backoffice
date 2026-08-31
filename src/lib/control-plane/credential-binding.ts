import { Prisma, type CredentialBinding as CredentialBindingRow } from "@prisma/client";

import {
  credentialBindingImportSchema,
  type CredentialBindingImport,
} from "@/lib/control-plane/contracts";
import {
  automationMutationIdentityMatches,
  automationMutationRequestHash,
} from "@/lib/control-plane/automation-mutation";
import { canonicalJson, jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { assertObservationTime, ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

type CredentialBindingState = Pick<CredentialBindingRow,
  | "id"
  | "revision"
  | "logicalCredentialId"
  | "provider"
  | "capability"
  | "environment"
  | "publicIdentity"
  | "fingerprint"
  | "consumer"
  | "scope"
  | "status"
  | "credentialGeneration"
  | "policyGeneration"
  | "adapterId"
  | "origin"
  | "authFactors"
  | "observedAt"
  | "catalogEntryDigest"
  | "catalogSnapshotDigest"
  | "catalogContractVersion"
  | "observedBy"
  | "createdAt"
  | "updatedAt"
>;

export interface PublicCredentialBinding {
  id: string;
  revision: number | null;
  logicalCredentialId: string;
  provider: string;
  capability: string;
  environment: string;
  publicIdentity: string | null;
  fingerprint: string | null;
  consumer: string;
  scope: string[];
  status: CredentialBindingRow["status"];
  credentialGeneration: number | null;
  policyGeneration: number | null;
  adapterId: string | null;
  origin: string | null;
  authFactors: string[];
  observedAt: string;
  catalogEntryDigest: string | null;
  catalogSnapshotDigest: string | null;
  catalogContractVersion: string | null;
  observedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function stringArray(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").sort()
    : [];
}

function normalizedFingerprint(value: string): string {
  return `sha256:${value.replace(/^sha256:/i, "").replaceAll(":", "").toLowerCase()}`;
}

export function normalizeCredentialBindingImport(input: CredentialBindingImport): CredentialBindingImport {
  return {
    ...input,
    binding: {
      ...input.binding,
      fingerprint: normalizedFingerprint(input.binding.fingerprint),
      scope: [...input.binding.scope].sort(),
      authFactors: [...input.binding.authFactors].sort() as CredentialBindingImport["binding"]["authFactors"],
    },
    provenance: {
      ...input.provenance,
      catalogEntryDigest: input.provenance.catalogEntryDigest.toLowerCase(),
      catalogSnapshotDigest: input.provenance.catalogSnapshotDigest.toLowerCase(),
    },
  };
}

export function publicCredentialBinding(row: CredentialBindingState): PublicCredentialBinding {
  return {
    id: row.id,
    revision: row.revision,
    logicalCredentialId: row.logicalCredentialId,
    provider: row.provider,
    capability: row.capability,
    environment: row.environment,
    publicIdentity: row.publicIdentity,
    fingerprint: row.fingerprint,
    consumer: row.consumer,
    scope: stringArray(row.scope),
    status: row.status,
    credentialGeneration: row.credentialGeneration,
    policyGeneration: row.policyGeneration,
    adapterId: row.adapterId,
    origin: row.origin,
    authFactors: stringArray(row.authFactors),
    observedAt: row.observedAt.toISOString(),
    catalogEntryDigest: row.catalogEntryDigest,
    catalogSnapshotDigest: row.catalogSnapshotDigest,
    catalogContractVersion: row.catalogContractVersion,
    observedBy: row.observedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function executionState(input: CredentialBindingImport["binding"] | CredentialBindingState): JsonValue {
  return {
    logicalCredentialId: input.logicalCredentialId,
    provider: input.provider,
    capability: input.capability,
    environment: input.environment,
    publicIdentity: input.publicIdentity,
    fingerprint: input.fingerprint,
    consumer: input.consumer,
    scope: Array.isArray(input.scope) ? stringArray(input.scope as Prisma.JsonValue) : [],
    status: input.status,
    credentialGeneration: input.credentialGeneration,
    policyGeneration: input.policyGeneration,
    adapterId: input.adapterId,
    origin: input.origin,
    authFactors: Array.isArray(input.authFactors) ? stringArray(input.authFactors as Prisma.JsonValue) : [],
  } as JsonValue;
}

export type CredentialBindingWriteDecision = "CREATE" | "UPDATE" | "UNCHANGED";

/**
 * expectedRevision이 snapshot CAS다. 실행 metadata가 바뀌면 catalog의 credential 또는 policy
 * generation도 반드시 전진해야 하며, 과거 observation이나 generation으로 되돌릴 수 없다.
 */
export function decideCredentialBindingWrite(input: {
  current: CredentialBindingState | null;
  desired: CredentialBindingImport;
}): CredentialBindingWriteDecision {
  if (!input.current) {
    if (input.desired.expectedRevision !== 0) {
      throw new ControlPlaneError(
        `CredentialBinding revision 충돌: expected=${input.desired.expectedRevision}, actual=0`,
        409,
        "CREDENTIAL_BINDING_REVISION_CONFLICT",
      );
    }
    return "CREATE";
  }
  if (input.current.revision === null) {
    throw new ControlPlaneError(
      "검증 provenance가 없는 기존 CredentialBinding은 자동 승격할 수 없습니다.",
      409,
      "CREDENTIAL_BINDING_PROVENANCE_UNVERIFIED",
    );
  }
  if (input.current.revision !== input.desired.expectedRevision) {
    throw new ControlPlaneError(
      `CredentialBinding revision 충돌: expected=${input.desired.expectedRevision}, actual=${input.current.revision}`,
      409,
      "CREDENTIAL_BINDING_REVISION_CONFLICT",
    );
  }
  const { current, desired } = input;
  if (desired.provenance.observedAt.getTime() < current.observedAt.getTime()) {
    throw new ControlPlaneError(
      "현재 CredentialBinding보다 오래된 catalog observation은 반영할 수 없습니다.",
      409,
      "CREDENTIAL_BINDING_OBSERVATION_STALE",
    );
  }
  if (
    desired.binding.credentialGeneration < (current.credentialGeneration ?? 0)
    || desired.binding.policyGeneration < (current.policyGeneration ?? 0)
  ) {
    throw new ControlPlaneError(
      "credential 또는 policy generation은 되돌릴 수 없습니다.",
      409,
      "CREDENTIAL_BINDING_GENERATION_REGRESSION",
    );
  }
  const executionChanged = canonicalJson(executionState(current))
    !== canonicalJson(executionState(desired.binding));
  const generationAdvanced = desired.binding.credentialGeneration > (current.credentialGeneration ?? 0)
    || desired.binding.policyGeneration > (current.policyGeneration ?? 0);
  if (executionChanged && !generationAdvanced) {
    throw new ControlPlaneError(
      "credential 실행 metadata 변경에는 catalog credential 또는 policy generation 증가가 필요합니다.",
      409,
      "CREDENTIAL_BINDING_GENERATION_NOT_ADVANCED",
    );
  }
  const provenanceChanged = current.catalogEntryDigest !== desired.provenance.catalogEntryDigest
    || current.catalogSnapshotDigest !== desired.provenance.catalogSnapshotDigest
    || current.catalogContractVersion !== desired.provenance.catalogContractVersion
    || current.observedAt.getTime() !== desired.provenance.observedAt.getTime();
  return executionChanged || provenanceChanged ? "UPDATE" : "UNCHANGED";
}

function mutationRequest(input: CredentialBindingImport): JsonValue {
  return {
    schemaVersion: input.schemaVersion,
    repoId: input.repoId.toString(),
    expectedRevision: input.expectedRevision,
    binding: input.binding,
    provenance: {
      ...input.provenance,
      observedAt: input.provenance.observedAt.toISOString(),
    },
  } as unknown as JsonValue;
}

function mutationTarget(input: CredentialBindingImport): string {
  const digest = jsonDigest({
    repoId: input.repoId.toString(),
    logicalCredentialId: input.binding.logicalCredentialId,
    capability: input.binding.capability,
  });
  return `credential-binding:${input.repoId.toString()}:${digest.slice(0, 48)}`;
}

const credentialBindingSelect = {
  id: true,
  revision: true,
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
  catalogEntryDigest: true,
  catalogSnapshotDigest: true,
  catalogContractVersion: true,
  observedBy: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CredentialBindingSelect;

export async function importCredentialBinding(input: {
  request: CredentialBindingImport;
  actor: string;
  idempotencyKey: string;
}): Promise<{ duplicate: boolean; changed: boolean; binding: PublicCredentialBinding }> {
  const request = normalizeCredentialBindingImport(credentialBindingImportSchema.parse(input.request));
  assertObservationTime(request.provenance.observedAt);
  const serializedRequest = mutationRequest(request);
  const identity = {
    requestId: input.idempotencyKey,
    actor: input.actor,
    operation: "CREDENTIAL_BINDING_IMPORT",
    targetKey: mutationTarget(request),
    request: serializedRequest,
  } as const;
  const requestHash = automationMutationRequestHash(identity);

  return prisma.$transaction(async (tx) => {
    const inserted = await tx.automationMutationRequest.createMany({
      data: [{
        requestId: identity.requestId,
        actor: identity.actor,
        operation: identity.operation,
        targetKey: identity.targetKey,
        requestHash,
        request: serializedRequest as Prisma.InputJsonValue,
      }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) {
      const replay = await tx.automationMutationRequest.findUnique({
        where: { requestId: identity.requestId },
      });
      if (!replay || !automationMutationIdentityMatches(replay, identity, requestHash)) {
        throw new ControlPlaneError(
          "idempotency key가 다른 CredentialBinding import에 사용되었습니다.",
          409,
          "IDEMPOTENCY_CONFLICT",
        );
      }
      if (replay.status !== "COMPLETED" || replay.response === null) {
        throw new ControlPlaneError(
          "같은 CredentialBinding import가 아직 처리 중입니다.",
          409,
          "MUTATION_IN_PROGRESS",
        );
      }
      const response = replay.response as unknown as {
        changed: boolean;
        binding: PublicCredentialBinding;
      };
      return { duplicate: true, changed: response.changed, binding: response.binding };
    }

    const app = await tx.app.findUnique({
      where: { repoId: request.repoId },
      select: { id: true, repoFullName: true, status: true },
    });
    if (!app || app.status !== "ACTIVE") {
      throw new ControlPlaneError(
        "ACTIVE managed app을 찾을 수 없습니다.",
        404,
        "APP_NOT_MANAGED",
      );
    }
    if (request.binding.consumer.toLowerCase() !== app.repoFullName.toLowerCase()) {
      throw new ControlPlaneError(
        "CredentialBinding consumer가 app repository identity와 일치하지 않습니다.",
        409,
        "CREDENTIAL_BINDING_CONSUMER_MISMATCH",
      );
    }
    await tx.$queryRaw`SELECT id FROM app WHERE id = ${app.id} FOR UPDATE`;
    const current = await tx.credentialBinding.findUnique({
      where: {
        appId_logicalCredentialId_capability: {
          appId: app.id,
          logicalCredentialId: request.binding.logicalCredentialId,
          capability: request.binding.capability,
        },
      },
      select: credentialBindingSelect,
    });
    const decision = decideCredentialBindingWrite({ current, desired: request });
    const data = {
      provider: request.binding.provider,
      environment: request.binding.environment,
      publicIdentity: request.binding.publicIdentity,
      fingerprint: request.binding.fingerprint,
      consumer: app.repoFullName,
      scope: request.binding.scope as Prisma.InputJsonValue,
      status: request.binding.status,
      credentialGeneration: request.binding.credentialGeneration,
      policyGeneration: request.binding.policyGeneration,
      adapterId: request.binding.adapterId,
      origin: request.binding.origin,
      authFactors: request.binding.authFactors as Prisma.InputJsonValue,
      observedAt: request.provenance.observedAt,
      catalogEntryDigest: request.provenance.catalogEntryDigest,
      catalogSnapshotDigest: request.provenance.catalogSnapshotDigest,
      catalogContractVersion: request.provenance.catalogContractVersion,
      observedBy: input.actor,
    } as const;
    let row: CredentialBindingState;
    if (decision === "CREATE") {
      row = await tx.credentialBinding.create({
        data: {
          appId: app.id,
          logicalCredentialId: request.binding.logicalCredentialId,
          capability: request.binding.capability,
          revision: 1,
          ...data,
        },
        select: credentialBindingSelect,
      });
    } else if (decision === "UPDATE") {
      const updated = await tx.credentialBinding.updateMany({
        where: { id: current!.id, revision: request.expectedRevision },
        data: { ...data, revision: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new ControlPlaneError(
          "CredentialBinding optimistic concurrency 검사에 실패했습니다.",
          409,
          "CREDENTIAL_BINDING_REVISION_CONFLICT",
        );
      }
      row = await tx.credentialBinding.findUniqueOrThrow({
        where: { id: current!.id },
        select: credentialBindingSelect,
      });
    } else {
      row = current!;
    }

    const response = {
      changed: decision !== "UNCHANGED",
      binding: publicCredentialBinding(row),
    };
    const completed = await tx.automationMutationRequest.updateMany({
      where: {
        requestId: identity.requestId,
        actor: identity.actor,
        operation: identity.operation,
        targetKey: identity.targetKey,
        requestHash,
        status: "PENDING",
      },
      data: {
        status: "COMPLETED",
        response: response as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
    if (completed.count !== 1) {
      throw new ControlPlaneError(
        "CredentialBinding import 완료 CAS에 실패했습니다.",
        409,
        "MUTATION_CAS_CONFLICT",
      );
    }
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.credential-binding.import",
        entityType: "CredentialBinding",
        entityId: row.id,
        payload: {
          requestId: input.idempotencyKey,
          repoId: request.repoId.toString(),
          logicalCredentialId: row.logicalCredentialId,
          provider: row.provider,
          capability: row.capability,
          status: row.status,
          revision: row.revision,
          credentialGeneration: row.credentialGeneration,
          policyGeneration: row.policyGeneration,
          catalogEntryDigest: row.catalogEntryDigest,
          catalogSnapshotDigest: row.catalogSnapshotDigest,
          changed: response.changed,
        },
      },
    });
    return { duplicate: false, ...response };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function listCredentialBindings(repoId: bigint): Promise<{
  repoId: string;
  repoFullName: string;
  bindings: PublicCredentialBinding[];
}> {
  const app = await prisma.app.findUnique({
    where: { repoId },
    select: {
      repoId: true,
      repoFullName: true,
      credentialBindings: {
        orderBy: [{ provider: "asc" }, { capability: "asc" }, { logicalCredentialId: "asc" }],
        select: credentialBindingSelect,
      },
    },
  });
  if (!app?.repoId) {
    throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
  }
  return {
    repoId: app.repoId.toString(),
    repoFullName: app.repoFullName,
    bindings: app.credentialBindings.map(publicCredentialBinding),
  };
}
