import { Prisma } from "@prisma/client";

import {
  marketReadbackSchema,
  projectBlueprintSchema,
  providerExecutionSettlementSchema,
  type ProviderExecutionCreate,
} from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { normalizeMarketReadback } from "@/lib/control-plane/market-adapter";
import type { ProviderObservationReceipt } from "@/lib/control-plane/provider-adapter-client";
import {
  MARKET_EXECUTION_CONTRACT,
  PROVIDER_EXECUTION_APPROVAL_TTL_MS,
  assertDistinctProviderExecutionCredentials,
  blueprintExecutionContract,
  compileProviderCommandEnvelope,
  decideBlueprintReadback,
  marketUploadReadbackSucceeded,
  providerExecutionBindingHash,
  providerExecutionClaimRequiresApproval,
  providerExecutionCredentialForClaim,
  providerExecutionLeaseToken,
  providerExecutionLeaseTokenHash,
  providerExecutionResumeMode,
  providerApprovalRequiredSettlementStatus,
  providerExecutionRequiresApproval,
  type CredentialExecutionMetadata,
  type MarketName,
  type ProviderExecutionActionClass,
} from "@/lib/control-plane/provider-execution";
import type { ProviderBrokerStage } from "@/lib/control-plane/provider-adapter-client";
import {
  assertDurableProviderClaim,
  assertProviderBrokerRequestBinding,
  providerSignerRequestId,
} from "@/lib/control-plane/provider-execution-signer";
import { getProjectBlueprintPlan } from "@/lib/control-plane/project-blueprint-service";
import { appendReleaseGateObservation } from "@/lib/control-plane/release-ledger";
import {
  assertObservationTime,
  ControlPlaneError,
} from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

type CredentialRow = {
  logicalCredentialId: string;
  capability: string;
  environment: string;
  publicIdentity: string | null;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "NEEDS_REAUTH";
  credentialGeneration: number | null;
  policyGeneration: number | null;
  adapterId: string | null;
  origin: string | null;
  authFactors: Prisma.JsonValue | null;
};

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function requestHash(input: ProviderExecutionCreate): string {
  return jsonDigest(JSON.parse(JSON.stringify(input, (_key, value) => (
    typeof value === "bigint" ? value.toString() : value
  ))) as JsonValue);
}

function requireCredentialMetadata(input: {
  candidates: CredentialRow[];
  logicalCredentialId?: string;
  capability: string;
  expectedAdapterId: string;
  expectedOrigin: string;
}): CredentialExecutionMetadata {
  const matches = input.candidates.filter((candidate) => (
    candidate.status === "ACTIVE"
    && candidate.capability === input.capability
    && (!input.logicalCredentialId || candidate.logicalCredentialId === input.logicalCredentialId)
  ));
  if (matches.length !== 1) {
    throw new ControlPlaneError(
      matches.length === 0
        ? "실행 가능한 shared credential binding이 없습니다."
        : "같은 capability의 active credential binding이 둘 이상입니다.",
      409,
      matches.length === 0 ? "CREDENTIAL_BINDING_MISSING" : "CREDENTIAL_BINDING_AMBIGUOUS",
    );
  }
  const binding = matches[0];
  if (!binding.logicalCredentialId.startsWith("shared/")) {
    throw new ControlPlaneError("공용 provider 기능의 app별 대체 credential은 사용할 수 없습니다.", 409, "APP_SPECIFIC_SUBSTITUTE_REJECTED");
  }
  if (
    !binding.publicIdentity
    || !binding.credentialGeneration
    || !binding.policyGeneration
    || !binding.adapterId
    || !binding.origin
    || !binding.authFactors
  ) {
    throw new ControlPlaneError("credential의 공개 실행 metadata와 generation을 먼저 등록해야 합니다.", 409, "CREDENTIAL_EXECUTION_METADATA_INCOMPLETE");
  }
  if (binding.adapterId !== input.expectedAdapterId || binding.origin !== input.expectedOrigin) {
    throw new ControlPlaneError("credential adapter 또는 exact origin이 중앙 계약과 일치하지 않습니다.", 409, "CREDENTIAL_EXECUTION_CONTRACT_MISMATCH");
  }
  return {
    logicalCredentialId: binding.logicalCredentialId,
    credentialGeneration: binding.credentialGeneration,
    policyGeneration: binding.policyGeneration,
    capability: binding.capability,
    publicAccountId: binding.publicIdentity,
    credentialPublicIdentity: binding.publicIdentity,
    adapterId: binding.adapterId,
    origin: binding.origin,
    environment: binding.environment,
    authFactors: binding.authFactors,
  };
}

function activeScopeKey(input: {
  appId: string;
  provider: string;
  resourceType: string;
  resourceId: string;
}) {
  return `provider:${jsonDigest(input as JsonValue).slice(0, 48)}`;
}

async function replayExecution(idempotencyKey: string, expectedRequestHash: string) {
  const replay = await prisma.providerExecution.findUnique({ where: { idempotencyKey } });
  if (!replay) return null;
  if (replay.requestHash !== expectedRequestHash) {
    throw new ControlPlaneError("idempotency key가 다른 provider execution에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
  }
  return { execution: replay, duplicate: true };
}

/** exact ACTIVE config/source에서 blueprint resource 하나만 실행 큐에 고정한다. */
async function enqueueBlueprintExecution(input: Extract<ProviderExecutionCreate, { kind: "BLUEPRINT_RESOURCE" }> & {
  actor: string;
  idempotencyKey: string;
  requestHash: string;
}) {
  const plan = await getProjectBlueprintPlan({
    repoId: input.repoId,
    sourceSha: input.sourceSha,
    configRevision: input.configRevision,
  });
  const desired = plan.resources.find((resource) => (
    resource.provider === input.resource.provider
    && resource.resourceType === input.resource.resourceType
    && resource.resourceId === input.resource.resourceId
  ));
  if (!desired) throw new ControlPlaneError("ACTIVE ProjectBlueprint에 선택한 resource가 없습니다.", 404, "BLUEPRINT_RESOURCE_NOT_FOUND");
  const contract = blueprintExecutionContract(desired.provider, desired.resourceType);
  if (!contract) throw new ControlPlaneError("지원하지 않는 provider resource입니다.", 409, "PROVIDER_ADAPTER_UNSUPPORTED");

  const app = await prisma.app.findUnique({
    where: { repoId: input.repoId },
    select: {
      id: true,
      repoId: true,
      repoFullName: true,
      configRevisions: {
        where: { revision: input.configRevision, status: "ACTIVE" },
        take: 1,
        select: { id: true, projectBlueprint: { select: { payload: true } } },
      },
      credentialBindings: {
        select: {
          logicalCredentialId: true,
          capability: true,
          environment: true,
          publicIdentity: true,
          status: true,
          credentialGeneration: true,
          policyGeneration: true,
          adapterId: true,
          origin: true,
          authFactors: true,
        },
      },
    },
  });
  const revision = app?.configRevisions[0];
  if (!app?.repoId || !revision?.projectBlueprint) {
    throw new ControlPlaneError("ACTIVE ProjectBlueprint binding을 찾을 수 없습니다.", 409, "BLUEPRINT_BINDING_STALE");
  }
  const blueprint = projectBlueprintSchema.parse(revision.projectBlueprint.payload);
  const capability = input.operation === "READBACK" ? contract.readbackCapability : contract.capability;
  const logicalCredentialId = input.operation === "APPLY"
    ? blueprint.provisioners[contract.provisioner]
    : undefined;
  const credential = requireCredentialMetadata({
    candidates: app.credentialBindings,
    logicalCredentialId,
    capability,
    expectedAdapterId: contract.adapterId,
    expectedOrigin: contract.origin,
  });
  const readbackCredential = input.operation === "READBACK"
    ? credential
    : requireCredentialMetadata({
        candidates: app.credentialBindings,
        capability: contract.readbackCapability,
        expectedAdapterId: contract.adapterId,
        expectedOrigin: contract.origin,
      });
  if (input.operation !== "READBACK") {
    try {
      assertDistinctProviderExecutionCredentials(credential, readbackCredential);
    } catch {
      throw new ControlPlaneError(
        "mutation identity와 fleet readback identity는 logical ID와 공개 identity가 모두 달라야 합니다.",
        409,
        "PROVIDER_READBACK_IDENTITY_NOT_DISTINCT",
      );
    }
  }
  const actionClass: ProviderExecutionActionClass = input.operation === "READBACK"
    ? "READ_ONLY"
    : contract.actionClass;
  const bindingHash = providerExecutionBindingHash({
    repoId: app.repoId,
    repoFullName: app.repoFullName,
    sourceSha: input.sourceSha,
    configRevisionId: revision.id,
    configRevision: input.configRevision,
    operation: input.operation,
    provider: desired.provider,
    resourceType: desired.resourceType,
    resourceId: desired.resourceId,
    desiredHash: desired.desiredHash,
    desired: desired.desired as Record<string, unknown>,
    expectedPublicIdentity: desired.publicIdentity,
    publicAccountId: credential.publicAccountId,
    credentialPublicIdentity: credential.credentialPublicIdentity,
    logicalCredentialId: credential.logicalCredentialId,
    credentialGeneration: credential.credentialGeneration,
    policyGeneration: credential.policyGeneration,
    capability: credential.capability,
    adapterId: credential.adapterId,
    origin: credential.origin,
    environment: credential.environment,
    authFactors: credential.authFactors,
    readbackCredential,
  });
  const status = providerExecutionRequiresApproval(actionClass, credential.environment)
    ? "WAITING_HUMAN_APPROVAL"
    : "QUEUED";
  return prisma.$transaction(async (tx) => {
    const execution = await tx.providerExecution.create({
      data: {
        appId: app.id,
        repoId: app.repoId!,
        repoFullName: app.repoFullName,
        sourceSha: input.sourceSha.toLowerCase(),
        configRevisionId: revision.id,
        configRevisionNumber: input.configRevision,
        kind: input.kind,
        operation: input.operation,
        actionClass,
        provider: desired.provider,
        resourceType: desired.resourceType,
        resourceId: desired.resourceId,
        desiredHash: desired.desiredHash,
        desiredPayload: inputJson(desired.desired),
        expectedPublicIdentity: desired.publicIdentity,
        publicAccountId: credential.publicAccountId,
        credentialPublicIdentity: credential.credentialPublicIdentity,
        logicalCredentialId: credential.logicalCredentialId,
        credentialGeneration: credential.credentialGeneration,
        policyGeneration: credential.policyGeneration,
        capability: credential.capability,
        adapterId: credential.adapterId,
        origin: credential.origin,
        environment: credential.environment,
        authFactors: inputJson(credential.authFactors),
        readbackPublicAccountId: readbackCredential.publicAccountId,
        readbackCredentialPublicIdentity: readbackCredential.credentialPublicIdentity,
        readbackLogicalCredentialId: readbackCredential.logicalCredentialId,
        readbackCredentialGeneration: readbackCredential.credentialGeneration,
        readbackPolicyGeneration: readbackCredential.policyGeneration,
        readbackCapability: readbackCredential.capability,
        readbackAdapterId: readbackCredential.adapterId,
        readbackOrigin: readbackCredential.origin,
        readbackEnvironment: readbackCredential.environment,
        readbackAuthFactors: inputJson(readbackCredential.authFactors),
        bindingHash,
        requestHash: input.requestHash,
        idempotencyKey: input.idempotencyKey,
        status,
        activeScopeKey: activeScopeKey({ appId: app.id, provider: desired.provider, resourceType: desired.resourceType, resourceId: desired.resourceId }),
        maxAttempts: input.maxAttempts,
      },
    });
    await tx.providerExecutionEvent.create({
      data: {
        executionId: execution.id,
        requestId: input.idempotencyKey,
        type: status === "QUEUED" ? "queued" : "human_approval_required",
        actor: input.actor,
        payload: { bindingHash, actionClass, status },
      },
    });
    return { execution, duplicate: false };
  });
}

function exactBinding(rows: Array<{ bindingType: string; externalId: string; publicIdentity: string | null }>, type: string) {
  const matches = rows.filter((row) => row.bindingType === type);
  if (matches.length !== 1) {
    throw new ControlPlaneError(
      matches.length === 0 ? `필수 ${type} public binding이 없습니다.` : `${type} public binding이 둘 이상입니다.`,
      409,
      matches.length === 0 ? "MARKET_PUBLIC_BINDING_MISSING" : "MARKET_PUBLIC_BINDING_AMBIGUOUS",
    );
  }
  return matches[0].publicIdentity ?? matches[0].externalId;
}

async function enqueueMarketExecution(input: Extract<ProviderExecutionCreate, { kind: "MARKET_RELEASE" }> & {
  actor: string;
  idempotencyKey: string;
  requestHash: string;
}) {
  const candidate = await prisma.releaseCandidate.findUnique({
    where: { id: input.releaseCandidateId },
    select: {
      id: true,
      appId: true,
      sourceSha: true,
      configRevisionId: true,
      artifactChecksum: true,
      market: true,
      status: true,
      configRevision: { select: { revision: true, status: true } },
      app: {
        select: {
          repoId: true,
          repoFullName: true,
          externalBindings: { select: { provider: true, bindingType: true, externalId: true, publicIdentity: true } },
          credentialBindings: {
            select: {
              logicalCredentialId: true,
              capability: true,
              environment: true,
              publicIdentity: true,
              status: true,
              credentialGeneration: true,
              policyGeneration: true,
              adapterId: true,
              origin: true,
              authFactors: true,
            },
          },
        },
      },
    },
  });
  if (!candidate || candidate.app.repoId !== input.repoId) {
    throw new ControlPlaneError("release candidate를 찾을 수 없습니다.", 404, "RELEASE_CANDIDATE_NOT_FOUND");
  }
  if (candidate.configRevision.status !== "ACTIVE") {
    throw new ControlPlaneError("ACTIVE config revision의 candidate만 실행할 수 있습니다.", 409, "CANDIDATE_CONFIG_NOT_ACTIVE");
  }
  if (input.operation === "UPLOAD_INTERNAL" && candidate.status !== "READY") {
    throw new ControlPlaneError("READY release candidate만 internal/private upload할 수 있습니다.", 409, "RELEASE_CANDIDATE_NOT_READY");
  }
  const market = candidate.market as MarketName | null;
  const contract = market ? MARKET_EXECUTION_CONTRACT[market] : undefined;
  if (!market || !contract) throw new ControlPlaneError("지원 마켓이 고정된 candidate가 아닙니다.", 409, "MARKET_ADAPTER_UNSUPPORTED");
  const bindings = candidate.app.externalBindings.filter((binding) => binding.provider === market);
  const publicAccountId = exactBinding(bindings, contract.accountBindingType);
  const publicAppId = exactBinding(bindings, contract.appBindingType);
  const capability = input.operation === "READBACK" ? contract.readbackCapability : contract.uploadCapability;
  const credentialBinding = requireCredentialMetadata({
    candidates: candidate.app.credentialBindings,
    capability,
    expectedAdapterId: contract.adapterId,
    expectedOrigin: contract.origin,
  });
  const credential = { ...credentialBinding, publicAccountId };
  const readbackBinding = input.operation === "READBACK"
    ? credentialBinding
    : requireCredentialMetadata({
        candidates: candidate.app.credentialBindings,
        capability: contract.readbackCapability,
        expectedAdapterId: contract.adapterId,
        expectedOrigin: contract.origin,
      });
  const readbackCredential = { ...readbackBinding, publicAccountId };
  if (input.operation !== "READBACK") {
    try {
      assertDistinctProviderExecutionCredentials(credential, readbackCredential);
    } catch {
      throw new ControlPlaneError(
        "market mutation identity와 fleet readback identity는 logical ID와 공개 identity가 모두 달라야 합니다.",
        409,
        "PROVIDER_READBACK_IDENTITY_NOT_DISTINCT",
      );
    }
  }
  const desiredPayload = {
    market,
    publicAccountId,
    publicAppId,
    sourceSha: candidate.sourceSha,
    configRevision: candidate.configRevision.revision,
    artifactChecksum: candidate.artifactChecksum,
  };
  const desiredHash = jsonDigest(desiredPayload);
  const actionClass: ProviderExecutionActionClass = input.operation === "READBACK" ? "READ_ONLY" : "INTERNAL_UPLOAD";
  const status = providerExecutionRequiresApproval(actionClass, credential.environment)
    ? "WAITING_HUMAN_APPROVAL"
    : "QUEUED";
  const bindingHash = providerExecutionBindingHash({
    repoId: input.repoId,
    repoFullName: candidate.app.repoFullName,
    sourceSha: candidate.sourceSha,
    configRevisionId: candidate.configRevisionId,
    configRevision: candidate.configRevision.revision,
    releaseCandidateId: candidate.id,
    operation: input.operation,
    provider: market,
    resourceType: "market-release",
    resourceId: publicAppId,
    desiredHash,
    desired: desiredPayload,
    expectedPublicIdentity: publicAppId,
    publicAccountId,
    credentialPublicIdentity: credential.credentialPublicIdentity,
    logicalCredentialId: credential.logicalCredentialId,
    credentialGeneration: credential.credentialGeneration,
    policyGeneration: credential.policyGeneration,
    capability: credential.capability,
    adapterId: credential.adapterId,
    origin: credential.origin,
    environment: credential.environment,
    authFactors: credential.authFactors,
    readbackCredential,
    artifactChecksum: candidate.artifactChecksum,
  });
  return prisma.$transaction(async (tx) => {
    const execution = await tx.providerExecution.create({
      data: {
        appId: candidate.appId,
        repoId: input.repoId,
        repoFullName: candidate.app.repoFullName,
        sourceSha: candidate.sourceSha,
        configRevisionId: candidate.configRevisionId,
        configRevisionNumber: candidate.configRevision.revision,
        releaseCandidateId: candidate.id,
        kind: input.kind,
        operation: input.operation,
        actionClass,
        provider: market,
        resourceType: "market-release",
        resourceId: publicAppId,
        desiredHash,
        desiredPayload,
        expectedPublicIdentity: publicAppId,
        publicAccountId,
        credentialPublicIdentity: credential.credentialPublicIdentity,
        logicalCredentialId: credential.logicalCredentialId,
        credentialGeneration: credential.credentialGeneration,
        policyGeneration: credential.policyGeneration,
        capability: credential.capability,
        adapterId: credential.adapterId,
        origin: credential.origin,
        environment: credential.environment,
        authFactors: inputJson(credential.authFactors),
        readbackPublicAccountId: readbackCredential.publicAccountId,
        readbackCredentialPublicIdentity: readbackCredential.credentialPublicIdentity,
        readbackLogicalCredentialId: readbackCredential.logicalCredentialId,
        readbackCredentialGeneration: readbackCredential.credentialGeneration,
        readbackPolicyGeneration: readbackCredential.policyGeneration,
        readbackCapability: readbackCredential.capability,
        readbackAdapterId: readbackCredential.adapterId,
        readbackOrigin: readbackCredential.origin,
        readbackEnvironment: readbackCredential.environment,
        readbackAuthFactors: inputJson(readbackCredential.authFactors),
        artifactChecksum: candidate.artifactChecksum,
        bindingHash,
        requestHash: input.requestHash,
        idempotencyKey: input.idempotencyKey,
        activeScopeKey: activeScopeKey({ appId: candidate.appId, provider: market, resourceType: "market-release", resourceId: publicAppId }),
        maxAttempts: input.maxAttempts,
        status,
      },
    });
    await tx.providerExecutionEvent.create({
      data: {
        executionId: execution.id,
        requestId: input.idempotencyKey,
        type: status === "QUEUED" ? "queued" : "human_approval_required",
        actor: input.actor,
        payload: { bindingHash, actionClass: execution.actionClass, status: execution.status },
      },
    });
    return { execution, duplicate: false };
  });
}

export async function enqueueProviderExecution(input: ProviderExecutionCreate & {
  actor: string;
  idempotencyKey: string;
}) {
  const hashed = requestHash(input);
  const replay = await replayExecution(input.idempotencyKey, hashed);
  if (replay) return replay;
  try {
    return input.kind === "BLUEPRINT_RESOURCE"
      ? await enqueueBlueprintExecution({ ...input, requestHash: hashed })
      : await enqueueMarketExecution({ ...input, requestHash: hashed });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const retried = await replayExecution(input.idempotencyKey, hashed);
    if (retried) return retried;
    throw new ControlPlaneError("같은 provider resource의 실행이 이미 진행 중입니다.", 409, "PROVIDER_EXECUTION_BUSY");
  }
}

export async function approveProviderExecution(input: {
  executionId: string;
  expectedGeneration: number;
  bindingHash: string;
  expiresAt: Date;
  actor: string;
  idempotencyKey: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (input.expiresAt <= now || input.expiresAt.getTime() - now.getTime() > PROVIDER_EXECUTION_APPROVAL_TTL_MS) {
    throw new ControlPlaneError("승인 만료는 현재부터 30분 이내여야 합니다.", 400, "APPROVAL_EXPIRY_INVALID");
  }
  const replay = await prisma.providerExecutionEvent.findUnique({ where: { requestId: input.idempotencyKey } });
  if (replay) {
    const payload = replay.payload as { bindingHash?: string; expectedGeneration?: number } | null;
    if (replay.executionId !== input.executionId || replay.type !== "approved" || payload?.bindingHash !== input.bindingHash || payload.expectedGeneration !== input.expectedGeneration) {
      throw new ControlPlaneError("idempotency key가 다른 provider approval에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { executionId: input.executionId, duplicate: true };
  }
  return prisma.$transaction(async (tx) => {
    const execution = await tx.providerExecution.findUnique({ where: { id: input.executionId } });
    if (!execution) throw new ControlPlaneError("provider execution을 찾을 수 없습니다.", 404, "PROVIDER_EXECUTION_NOT_FOUND");
    if (
      !providerExecutionRequiresApproval(execution.actionClass, execution.environment)
      || execution.status !== "WAITING_HUMAN_APPROVAL"
    ) {
      throw new ControlPlaneError("사람 승인을 기다리는 provider mutation이 아닙니다.", 409, "APPROVAL_STATE_CONFLICT");
    }
    if (execution.bindingHash !== input.bindingHash || execution.leaseGeneration !== input.expectedGeneration) {
      throw new ControlPlaneError("승인 대상 binding 또는 generation이 바뀌었습니다.", 409, "APPROVAL_BINDING_MISMATCH");
    }
    const approvalId = `provider-approval:${execution.id}:${input.expectedGeneration + 1}`;
    const changed = await tx.providerExecution.updateMany({
      where: { id: execution.id, status: "WAITING_HUMAN_APPROVAL", leaseGeneration: input.expectedGeneration, bindingHash: input.bindingHash },
      data: {
        status: "QUEUED",
        approvedBy: input.actor,
        approvalId,
        approvalBindingHash: input.bindingHash,
        approvalExpiresAt: input.expiresAt,
        availableAt: now,
      },
    });
    if (changed.count !== 1) throw new ControlPlaneError("provider approval CAS에 실패했습니다.", 409, "APPROVAL_STATE_CONFLICT");
    await tx.providerExecutionEvent.create({
      data: {
        executionId: execution.id,
        requestId: input.idempotencyKey,
        type: "approved",
        generation: input.expectedGeneration,
        actor: input.actor,
        payload: { bindingHash: input.bindingHash, expectedGeneration: input.expectedGeneration, approvalId, expiresAt: input.expiresAt.toISOString() },
      },
    });
    return { executionId: execution.id, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function recoverExpiredProviderLeases(now: Date) {
  const expired = await prisma.providerExecution.findMany({
    where: { status: "RUNNING", leaseExpiresAt: { lte: now } },
    select: { id: true, operation: true, leaseGeneration: true },
    take: 100,
  });
  for (const execution of expired) {
    const mutation = execution.operation !== "READBACK";
    await prisma.$transaction(async (tx) => {
      const changed = await tx.providerExecution.updateMany({
        where: { id: execution.id, status: "RUNNING", leaseGeneration: execution.leaseGeneration, leaseExpiresAt: { lte: now } },
        data: {
          status: mutation ? "READBACK_REQUIRED" : "QUEUED",
          readbackRequiredAt: mutation ? now : null,
          availableAt: now,
          workerId: null,
          leaseTokenHash: null,
          leaseExpiresAt: null,
          lastErrorCode: "WORKER_LEASE_EXPIRED",
        },
      });
      if (changed.count === 1) {
        await tx.providerExecutionEvent.create({
          data: { executionId: execution.id, type: mutation ? "readback_required" : "lease_requeued", generation: execution.leaseGeneration, actor: "system:lease-reaper", payload: { reason: "WORKER_LEASE_EXPIRED" } },
        });
      }
    });
  }
}

function replayClaimToken(input: { signingKey: string | Buffer; executionId: string; generation: number; workerId: string }) {
  return providerExecutionLeaseToken(input);
}

export async function claimProviderExecution(input: {
  workerId: string;
  leaseSeconds: number;
  idempotencyKey: string;
  signingKey: string | Buffer;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const replay = await prisma.providerExecutionEvent.findUnique({ where: { requestId: input.idempotencyKey } });
  if (replay) {
    const payload = replay.payload as { workerId?: string; resumeMode?: "START" | "READBACK_FIRST"; expiresAt?: string } | null;
    if (replay.type !== "claimed" || replay.actor !== input.workerId || !replay.generation || payload?.workerId !== input.workerId) {
      throw new ControlPlaneError("idempotency key가 다른 provider claim에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    const execution = await prisma.providerExecution.findUnique({ where: { id: replay.executionId } });
    if (!execution || execution.status !== "RUNNING" || execution.leaseGeneration !== replay.generation || !execution.leaseExpiresAt || execution.leaseExpiresAt <= now) {
      throw new ControlPlaneError("replay할 수 있는 active provider lease가 아닙니다.", 409, "STALE_LEASE");
    }
    const leaseToken = replayClaimToken({ signingKey: input.signingKey, executionId: execution.id, generation: replay.generation, workerId: input.workerId });
    return { claim: commandClaim(execution, payload.resumeMode ?? "START", leaseToken), duplicate: true };
  }
  await recoverExpiredProviderLeases(now);
  const candidates = await prisma.providerExecution.findMany({
    where: { status: { in: ["QUEUED", "READBACK_REQUIRED"] }, availableAt: { lte: now } },
    orderBy: [{ createdAt: "asc" }],
    take: 50,
  });
  for (const candidate of candidates) {
    if (
      providerExecutionClaimRequiresApproval(candidate.actionClass, candidate.environment, "START")
      && candidate.status === "QUEUED"
      && (candidate.approvalBindingHash !== candidate.bindingHash || !candidate.approvalExpiresAt || candidate.approvalExpiresAt <= now)
    ) {
      await prisma.providerExecution.updateMany({
        where: { id: candidate.id, status: "QUEUED", leaseGeneration: candidate.leaseGeneration },
        data: { status: "WAITING_HUMAN_APPROVAL", approvedBy: null, approvalId: null, approvalBindingHash: null, approvalExpiresAt: null },
      });
      continue;
    }
    const resumeMode = providerExecutionResumeMode(candidate.status);
    const generation = candidate.leaseGeneration + 1;
    const leaseToken = providerExecutionLeaseToken({ signingKey: input.signingKey, executionId: candidate.id, generation, workerId: input.workerId });
    const expiresAt = new Date(now.getTime() + input.leaseSeconds * 1_000);
    try {
      const claimed = await prisma.$transaction(async (tx) => {
        const changed = await tx.providerExecution.updateMany({
          where: { id: candidate.id, status: candidate.status, leaseGeneration: candidate.leaseGeneration },
          data: {
            status: "RUNNING",
            leaseGeneration: generation,
            leaseTokenHash: providerExecutionLeaseTokenHash(leaseToken),
            workerId: input.workerId,
            leaseExpiresAt: expiresAt,
            startedAt: candidate.startedAt ?? now,
            attempts: resumeMode === "START" ? { increment: 1 } : undefined,
            readbackAttempts: resumeMode === "READBACK_FIRST" ? { increment: 1 } : undefined,
            lastErrorCode: null,
          },
        });
        if (changed.count !== 1) return null;
        await tx.providerExecutionEvent.create({
          data: {
            executionId: candidate.id,
            requestId: input.idempotencyKey,
            type: "claimed",
            generation,
            actor: input.workerId,
            payload: { workerId: input.workerId, resumeMode, expiresAt: expiresAt.toISOString(), bindingHash: candidate.bindingHash },
          },
        });
        return tx.providerExecution.findUniqueOrThrow({ where: { id: candidate.id } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      if (claimed) return { claim: commandClaim(claimed, resumeMode, leaseToken), duplicate: false };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    }
  }
  return { claim: null, duplicate: false };
}

function commandClaim(execution: {
  id: string;
  leaseGeneration: number;
  operation: "READBACK" | "APPLY" | "UPLOAD_INTERNAL";
  provider: string;
  repoId: bigint;
  repoFullName: string;
  sourceSha: string;
  configRevisionNumber: number;
  desiredHash: string;
  desiredPayload: Prisma.JsonValue;
  resourceType: string;
  resourceId: string;
  expectedPublicIdentity: string | null;
  artifactChecksum: string | null;
  bindingHash: string;
  logicalCredentialId: string;
  credentialPublicIdentity: string;
  credentialGeneration: number;
  policyGeneration: number;
  capability: string;
  publicAccountId: string;
  adapterId: string;
  origin: string;
  environment: string;
  authFactors: Prisma.JsonValue;
  readbackPublicAccountId: string;
  readbackCredentialPublicIdentity: string;
  readbackLogicalCredentialId: string;
  readbackCredentialGeneration: number;
  readbackPolicyGeneration: number;
  readbackCapability: string;
  readbackAdapterId: string;
  readbackOrigin: string;
  readbackEnvironment: string;
  readbackAuthFactors: Prisma.JsonValue;
  actionClass: "READ_ONLY" | "DETERMINISTIC_MUTATION" | "PROTECTED_MUTATION" | "INTERNAL_UPLOAD" | "HUMAN_ONLY";
  approvalId: string | null;
  approvalExpiresAt: Date | null;
  leaseExpiresAt: Date | null;
}, resumeMode: "START" | "READBACK_FIRST", leaseToken: string) {
  const expiresAt = execution.leaseExpiresAt ?? new Date(0);
  const approval = providerExecutionClaimRequiresApproval(execution.actionClass, execution.environment, resumeMode)
    ? {
        id: execution.approvalId ?? "invalid",
        mode: "per_run" as const,
        expiresAt: execution.approvalExpiresAt && execution.approvalExpiresAt < expiresAt ? execution.approvalExpiresAt : expiresAt,
      }
    : {
        id: `provider-preapproval:${execution.id}:${execution.leaseGeneration}`,
        mode: "preapproved" as const,
        expiresAt,
      };
  const credential = providerExecutionCredentialForClaim(
    resumeMode,
    {
      logicalCredentialId: execution.logicalCredentialId,
      credentialGeneration: execution.credentialGeneration,
      policyGeneration: execution.policyGeneration,
      capability: execution.capability,
      publicAccountId: execution.publicAccountId,
      credentialPublicIdentity: execution.credentialPublicIdentity,
      adapterId: execution.adapterId,
      origin: execution.origin,
      environment: execution.environment,
      authFactors: execution.authFactors,
    },
    {
        logicalCredentialId: execution.readbackLogicalCredentialId,
        credentialGeneration: execution.readbackCredentialGeneration,
        policyGeneration: execution.readbackPolicyGeneration,
        capability: execution.readbackCapability,
        publicAccountId: execution.readbackPublicAccountId,
        credentialPublicIdentity: execution.readbackCredentialPublicIdentity,
        adapterId: execution.readbackAdapterId,
        origin: execution.readbackOrigin,
        environment: execution.readbackEnvironment,
        authFactors: execution.readbackAuthFactors,
    },
  );
  const envelope = compileProviderCommandEnvelope({
    executionId: execution.id,
    generation: execution.leaseGeneration,
    resumeMode,
    operation: execution.operation,
    provider: execution.provider,
    repoId: execution.repoId,
    repoFullName: execution.repoFullName,
    sourceSha: execution.sourceSha,
    configRevision: execution.configRevisionNumber,
    desiredHash: execution.desiredHash,
    desired: execution.desiredPayload as Record<string, unknown>,
    resourceType: execution.resourceType,
    resourceId: execution.resourceId,
    expectedPublicIdentity: execution.expectedPublicIdentity,
    artifactChecksum: execution.artifactChecksum,
    bindingHash: execution.bindingHash,
    credential,
    approval,
  });
  return {
    executionId: execution.id,
    generation: execution.leaseGeneration,
    leaseToken,
    expiresAt,
    resumeMode,
    envelope,
  };
}

export async function authorizeProviderBrokerRequest(input: {
  executionId: string;
  generation: number;
  workerId: string;
  subject: string;
  stage: ProviderBrokerStage;
  ordinal: number;
  expectedRequestDigest: string;
  nonceDigest: string;
  now?: Date;
}) {
  if (!/^[0-9a-f]{64}$/.test(input.nonceDigest)) {
    throw new ControlPlaneError("attestation nonce digest 형식이 올바르지 않습니다.", 400, "PROVIDER_ATTESTATION_NONCE_DIGEST_INVALID");
  }
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const execution = await tx.providerExecution.findUnique({ where: { id: input.executionId } });
    if (!execution) {
      throw new ControlPlaneError("durable provider claim을 찾을 수 없습니다.", 409, "PROVIDER_SIGNER_STALE_DURABLE_CLAIM");
    }
    const durableClaim = assertDurableProviderClaim({
      claim: execution,
      executionId: input.executionId,
      generation: input.generation,
      workerId: input.workerId,
      now,
    });
    const resumeMode = execution.readbackRequiredAt ? "READBACK_FIRST" as const : "START" as const;
    const envelope = commandClaim(execution, resumeMode, "not-returned-to-worker").envelope;
    const request = assertProviderBrokerRequestBinding({
      envelope,
      subject: input.subject,
      workerId: input.workerId,
      stage: input.stage,
      ordinal: input.ordinal,
      expectedRequestDigest: input.expectedRequestDigest,
    });
    const attestationExpiresAt = new Date(Math.min(
      now.getTime() + 60_000,
      durableClaim.leaseExpiresAt.getTime(),
      Date.parse(envelope.approval.expiresAt),
    ));
    if (attestationExpiresAt.getTime() - now.getTime() < 5_000) {
      throw new ControlPlaneError("attestation 유효기간 안에 실행할 수 없습니다.", 409, "PROVIDER_SIGNER_STALE_DURABLE_CLAIM");
    }
    const requestId = providerSignerRequestId(input);
    try {
      await tx.providerExecutionEvent.create({
        data: {
          executionId: execution.id,
          requestId,
          type: "broker_attestation_issued",
          generation: execution.leaseGeneration,
          actor: "system:provider-attestation-signer",
          payload: {
            workerId: input.workerId,
            subject: input.subject,
            repoId: execution.repoId.toString(),
            repository: execution.repoFullName,
            sourceSha: execution.sourceSha,
            bindingHash: execution.bindingHash,
            leaseExpiresAt: durableClaim.leaseExpiresAt.toISOString(),
            attestationExpiresAt: attestationExpiresAt.toISOString(),
            stage: input.stage,
            ordinal: input.ordinal,
            route: request.path,
            requestDigest: input.expectedRequestDigest,
            nonceDigest: input.nonceDigest,
          },
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ControlPlaneError("같은 broker request의 attestation은 다시 발급할 수 없습니다.", 409, "PROVIDER_ATTESTATION_ALREADY_ISSUED");
      }
      throw error;
    }
    return {
      request,
      envelope,
      attestationExpiresAt,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function currentProviderExecutionClaim(input: {
  executionId: string;
  generation: number;
  workerId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const execution = await prisma.providerExecution.findUnique({ where: { id: input.executionId } });
  if (!execution) {
    throw new ControlPlaneError("durable provider claim을 찾을 수 없습니다.", 409, "PROVIDER_SIGNER_STALE_DURABLE_CLAIM");
  }
  const durableClaim = assertDurableProviderClaim({
    claim: execution,
    executionId: input.executionId,
    generation: input.generation,
    workerId: input.workerId,
    now,
  });
  const resumeMode = durableClaim && execution.readbackRequiredAt ? "READBACK_FIRST" as const : "START" as const;
  return commandClaim(execution, resumeMode, "not-returned-to-worker");
}

function terminal(status: string) {
  return ["SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELLED", "HUMAN_ONLY_BLOCKED"].includes(status);
}

function retryStatus(execution: {
  attempts: number;
  maxAttempts: number;
  actionClass: ProviderExecutionActionClass;
  environment: string;
}) {
  if (execution.attempts >= execution.maxAttempts) return "DEAD_LETTER" as const;
  return providerExecutionRequiresApproval(execution.actionClass, execution.environment)
    ? "WAITING_HUMAN_APPROVAL" as const
    : "QUEUED" as const;
}

export async function settleProviderExecution(input: {
  executionId: string;
  generation: number;
  leaseToken: string;
  outcome: "COMMAND_ACCEPTED" | "OBSERVED" | "RESULT_UNKNOWN" | "FAILED" | "HUMAN_REQUIRED" | "APPROVAL_REQUIRED";
  observation?: {
    kind: "BLUEPRINT";
    observedAt: Date;
    payload: { schemaVersion: 1; visibility: "VISIBLE" | "FORBIDDEN" | "ERROR"; state: "PRESENT" | "ABSENT" | "UNKNOWN"; publicIdentity?: string; attributes: Record<string, unknown> };
  } | {
    kind: "MARKET";
    payload: ReturnType<typeof marketReadbackSchema.parse>;
  };
  /**
   * 관측을 동반한 settlement에는 broker policy grant 영수증이 반드시 있어야 한다.
   * signer가 Auth Broker에서 직접 읽은 관측만 이 값을 가질 수 있다.
   */
  observationReceipt?: ProviderObservationReceipt;
  errorCode?: string;
  reauthRequestId?: string;
  workerId: string;
  idempotencyKey: string;
  now?: Date;
}) {
  const parsed = providerExecutionSettlementSchema.parse({
    executionId: input.executionId,
    generation: input.generation,
    leaseToken: input.leaseToken,
    outcome: input.outcome,
    observation: input.observation,
    errorCode: input.errorCode,
    reauthRequestId: input.reauthRequestId,
  });
  const now = input.now ?? new Date();
  const settlementHash = jsonDigest({
    executionId: parsed.executionId,
    generation: parsed.generation,
    outcome: parsed.outcome,
    observation: parsed.observation
      ? JSON.parse(JSON.stringify(parsed.observation, (_key, value) => value instanceof Date ? value.toISOString() : value))
      : null,
    errorCode: parsed.errorCode ?? null,
    reauthRequestId: parsed.reauthRequestId ?? null,
    observationReceipt: input.observationReceipt
      ? { ...input.observationReceipt }
      : null,
  } as unknown as JsonValue);
  const replay = await prisma.providerExecutionEvent.findUnique({ where: { requestId: input.idempotencyKey } });
  if (replay) {
    const payload = replay.payload as { settlementHash?: string; status?: string } | null;
    if (replay.executionId !== input.executionId || replay.generation !== input.generation || replay.actor !== input.workerId || payload?.settlementHash !== settlementHash) {
      throw new ControlPlaneError("idempotency key가 다른 provider settlement에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { status: payload.status ?? "UNKNOWN", duplicate: true };
  }
  return prisma.$transaction(async (tx) => {
    const execution = await tx.providerExecution.findUnique({
      where: { id: input.executionId },
      include: { releaseCandidate: { include: { configRevision: { select: { revision: true } } } } },
    });
    if (
      !execution
      || execution.status !== "RUNNING"
      || execution.leaseGeneration !== input.generation
      || execution.workerId !== input.workerId
      || execution.leaseTokenHash !== providerExecutionLeaseTokenHash(input.leaseToken)
      || !execution.leaseExpiresAt
      || execution.leaseExpiresAt <= now
    ) {
      throw new ControlPlaneError("stale provider completion은 반영할 수 없습니다.", 409, "STALE_LEASE");
    }
    const readbackFirst = Boolean(execution.readbackRequiredAt);
    let status: "QUEUED" | "WAITING_HUMAN_APPROVAL" | "READBACK_REQUIRED" | "SUCCEEDED" | "FAILED" | "DEAD_LETTER";
    let errorCode: string | null = null;
    let eventType: string;
    let observationId: string | null = null;

    if (parsed.outcome === "APPROVAL_REQUIRED") {
      status = providerApprovalRequiredSettlementStatus({
        readbackFirst,
        readbackAttempts: execution.readbackAttempts,
        maxAttempts: execution.maxAttempts,
      });
      errorCode = parsed.errorCode ?? "PER_RUN_APPROVAL_REQUIRED";
      eventType = readbackFirst
        ? status === "DEAD_LETTER" ? "dead_letter" : "readback_required"
        : "human_approval_required";
    } else if (parsed.outcome === "HUMAN_REQUIRED") {
      status = "FAILED";
      errorCode = "HUMAN_REAUTH_REQUIRED";
      eventType = "human_reauth_required";
    } else if (parsed.outcome === "OBSERVED" && parsed.observation) {
      if (execution.kind === "BLUEPRINT_RESOURCE" && parsed.observation.kind !== "BLUEPRINT") {
        throw new ControlPlaneError("blueprint execution에는 blueprint readback이 필요합니다.", 409, "OBSERVATION_KIND_MISMATCH");
      }
      if (execution.kind === "MARKET_RELEASE" && parsed.observation.kind !== "MARKET") {
        throw new ControlPlaneError("market execution에는 market readback이 필요합니다.", 409, "OBSERVATION_KIND_MISMATCH");
      }
      // 관측은 signer가 broker에서 직접 읽은 것만 받는다. 영수증이 이 execution의 exact
      // policy grant, lease generation, bindingHash에 결합되지 않으면 settlement 전체를 되돌린다.
      const receipt = input.observationReceipt;
      const expectedCommandDigest = jsonDigest(
        commandClaim(
          execution,
          execution.readbackRequiredAt ? "READBACK_FIRST" : "START",
          "not-returned-to-worker",
        ).envelope as unknown as JsonValue,
      );
      if (
        !receipt
        || receipt.bindingHash !== execution.bindingHash
        || receipt.generation !== execution.leaseGeneration
        || receipt.policyGeneration !== execution.policyGeneration
        || receipt.policyGrantId !== `provider-grant-${execution.bindingHash.slice(0, 40)}-${execution.leaseGeneration}`
        || receipt.commandDigest !== expectedCommandDigest
        || !/^[0-9a-f]{64}$/.test(receipt.policyGrantDigest)
      ) {
        throw new ControlPlaneError(
          "관측이 exact Auth Broker policy grant 영수증에 결합되지 않았습니다.",
          409,
          "PROVIDER_OBSERVATION_RECEIPT_MISMATCH",
        );
      }
      const observedAt = parsed.observation.kind === "BLUEPRINT" ? parsed.observation.observedAt : parsed.observation.payload.observedAt;
      assertObservationTime(observedAt, now);
      const payload = parsed.observation.kind === "BLUEPRINT"
        ? parsed.observation.payload
        : { ...parsed.observation.payload, observedAt: parsed.observation.payload.observedAt.toISOString() };
      const observation = await tx.providerObservation.create({
        data: {
          appId: execution.appId,
          provider: execution.provider,
          resourceType: execution.resourceType,
          resourceId: execution.resourceId,
          payload: inputJson(payload),
          payloadHash: jsonDigest(payload as JsonValue),
          requestHash: settlementHash,
          idempotencyKey: `provider-execution-observation:${execution.id}:${execution.leaseGeneration}`,
          observedBy: input.workerId,
          observedAt,
        },
      });
      observationId = observation.id;
      if (parsed.observation.kind === "BLUEPRINT") {
        const decision = decideBlueprintReadback(parsed.observation.payload, {
          desiredHash: execution.desiredHash,
          publicIdentity: execution.expectedPublicIdentity,
        });
        if (!readbackFirst || execution.operation === "READBACK") {
          status = decision === "FORBIDDEN" || decision === "ERROR" ? "FAILED" : "SUCCEEDED";
        } else if (decision === "COMPLIANT") {
          status = "SUCCEEDED";
        } else if (decision === "FORBIDDEN") {
          status = "FAILED";
          errorCode = "PROVIDER_VISIBILITY_FORBIDDEN";
        } else if (decision === "ERROR") {
          status = execution.readbackAttempts >= execution.maxAttempts ? "DEAD_LETTER" : "READBACK_REQUIRED";
          errorCode = "PROVIDER_READBACK_ERROR";
        } else {
          status = retryStatus(execution);
          errorCode = decision === "ABSENT" ? "PROVIDER_RESOURCE_ABSENT" : "PROVIDER_RESOURCE_DRIFT";
        }
        eventType = `readback_${decision.toLowerCase()}`;
      } else {
        const candidate = execution.releaseCandidate;
        if (!candidate) throw new ControlPlaneError("market execution의 candidate binding이 없습니다.", 409, "CANDIDATE_BINDING_MISMATCH");
        const normalized = normalizeMarketReadback(parsed.observation.payload, {
          market: execution.provider as MarketName,
          publicAccountId: execution.publicAccountId,
          publicAppId: execution.resourceId,
          sourceSha: execution.sourceSha,
          configRevision: execution.configRevisionNumber,
          artifactChecksum: execution.artifactChecksum ?? "",
        });
        // 범용 요청 경로와 같은 helper를 쓴다. candidate status와 중앙 lifecycle이 이 transaction에서 함께 전진한다.
        await appendReleaseGateObservation({
          tx,
          candidateId: candidate.id,
          gate: normalized.gate,
          status: normalized.status,
          observedAt: normalized.observedAt,
          evidence: normalized.evidence,
          actor: input.workerId,
          dedupeKey: `provider-execution:${jsonDigest({ executionId: execution.id, generation: execution.leaseGeneration, gate: normalized.gate } as JsonValue)}`,
          requestHash: settlementHash,
          origin: {
            kind: "PROVIDER_SETTLEMENT",
            executionId: execution.id,
            observationId: observation.id,
            publicAccountId: execution.publicAccountId,
            publicAppId: execution.resourceId,
            bindingHash: execution.bindingHash,
            policyGrantId: receipt.policyGrantId,
          },
        });
        if (!readbackFirst || execution.operation === "READBACK") {
          status = "SUCCEEDED";
        } else if (marketUploadReadbackSucceeded(parsed.observation.payload)) {
          status = "SUCCEEDED";
        } else {
          status = parsed.observation.payload.state === "FAILED" || parsed.observation.payload.state === "REJECTED"
            ? "DEAD_LETTER"
            : execution.readbackAttempts >= execution.maxAttempts
              ? "DEAD_LETTER"
              : "READBACK_REQUIRED";
          errorCode = status === "DEAD_LETTER" ? "MARKET_UPLOAD_REJECTED" : "MARKET_READBACK_PENDING";
        }
        eventType = `market_readback_${parsed.observation.payload.state.toLowerCase()}`;
      }
    } else if (execution.operation !== "READBACK") {
      status = "READBACK_REQUIRED";
      errorCode = parsed.outcome === "FAILED" ? (parsed.errorCode ?? "ADAPTER_FAILED") : "PROVIDER_READBACK_REQUIRED";
      eventType = "readback_required";
    } else {
      const retry = execution.attempts < execution.maxAttempts;
      status = retry ? "QUEUED" : "DEAD_LETTER";
      errorCode = parsed.errorCode ?? (parsed.outcome === "RESULT_UNKNOWN" ? "READBACK_RESULT_UNKNOWN" : "ADAPTER_FAILED");
      eventType = retry ? "retry_scheduled" : "dead_letter";
    }

    const protectedRetry = status === "WAITING_HUMAN_APPROVAL";
    const changed = await tx.providerExecution.updateMany({
      where: { id: execution.id, status: "RUNNING", leaseGeneration: execution.leaseGeneration, workerId: input.workerId },
      data: {
        status,
        activeScopeKey: terminal(status) ? null : execution.activeScopeKey,
        workerId: null,
        leaseTokenHash: null,
        leaseExpiresAt: null,
        availableAt: status === "READBACK_REQUIRED" || status === "QUEUED" ? now : execution.availableAt,
        readbackRequiredAt: status === "READBACK_REQUIRED" ? (execution.readbackRequiredAt ?? now) : null,
        approvedBy: protectedRetry ? null : execution.approvedBy,
        approvalId: protectedRetry ? null : execution.approvalId,
        approvalBindingHash: protectedRetry ? null : execution.approvalBindingHash,
        approvalExpiresAt: protectedRetry ? null : execution.approvalExpiresAt,
        lastObservationId: observationId ?? execution.lastObservationId,
        lastErrorCode: errorCode,
        completedAt: terminal(status) ? now : null,
      },
    });
    if (changed.count !== 1) throw new ControlPlaneError("provider settlement CAS에 실패했습니다.", 409, "STALE_LEASE");
    await tx.providerExecutionEvent.create({
      data: {
        executionId: execution.id,
        requestId: input.idempotencyKey,
        type: eventType,
        generation: execution.leaseGeneration,
        actor: input.workerId,
        payload: {
          status,
          settlementHash,
          bindingHash: execution.bindingHash,
          observationId,
          errorCode,
          reauthRequestId: parsed.reauthRequestId ?? null,
          observationReceipt: input.observationReceipt
            ? {
              policyGrantId: input.observationReceipt.policyGrantId,
              policyGrantDigest: input.observationReceipt.policyGrantDigest,
              bindingHash: input.observationReceipt.bindingHash,
              commandDigest: input.observationReceipt.commandDigest,
              policyGeneration: input.observationReceipt.policyGeneration,
              generation: input.observationReceipt.generation,
            }
            : null,
        },
      },
    });
    return { status, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
