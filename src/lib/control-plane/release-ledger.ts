import { Prisma, type ReleaseGateStatus } from "@prisma/client";
import {
  configRevisionPayloadSchema,
  parseStoredPlatformReleaseManifest,
  RELEASE_CANDIDATE_REQUIRED_GATES,
  type ReleaseGateName,
} from "@/lib/control-plane/contracts";
import {
  evidenceLifecycleStage,
  gateIdentitySatisfied,
  isExternalReleaseGate,
  lifecycleStageRank,
  type GateObservationFact,
} from "@/lib/control-plane/lifecycle-policy";
import { assertObservationTime, ControlPlaneError } from "@/lib/control-plane/service";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";
import { exactBuildTargetIdentity } from "@/lib/control-plane/build-target-identity";

const ARTIFACT_BY_MARKET = {
  "google-play": "android-aab",
  "app-store": "ios-archive",
  "apps-in-toss": "ait-bundle",
} as const;

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function candidateRequestHash(input: {
  repoId: bigint;
  sourceSha: string;
  configRevision: number;
  market: string;
  targetKey: string;
  artifactType: string;
  artifactChecksum: string;
  workflowBundleSha: string;
  workflowBundleDigest: string;
  platformVersion: string;
  actor: string;
}): string {
  return jsonDigest({
    ...input,
    repoId: input.repoId.toString(),
    sourceSha: input.sourceSha.toLowerCase(),
    artifactChecksum: input.artifactChecksum.toLowerCase(),
    workflowBundleSha: input.workflowBundleSha.toLowerCase(),
    workflowBundleDigest: input.workflowBundleDigest.toLowerCase(),
  } as JsonValue);
}

export async function createReleaseCandidate(input: {
  repoId: bigint;
  sourceSha: string;
  configRevision: number;
  market: "google-play" | "app-store" | "apps-in-toss";
  targetKey: string;
  artifactType: "android-aab" | "ios-archive" | "ait-bundle" | "web-bundle";
  artifactChecksum: string;
  workflowBundleSha: string;
  workflowBundleDigest: string;
  platformVersion: string;
  actor: string;
  idempotencyKey: string;
}) {
  const requestHash = candidateRequestHash(input);
  const replay = await prisma.releaseCandidate.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (replay) {
    if (replay.requestHash !== requestHash) {
      throw new ControlPlaneError("idempotency key가 다른 release candidate에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { candidate: replay, duplicate: true };
  }

  return prisma.$transaction(async (tx) => {
    const app = await tx.app.findUnique({
      where: { repoId: input.repoId },
      select: { id: true, repoId: true, engine: true },
    });
    if (!app) throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
    await tx.$queryRaw`SELECT id FROM app WHERE id = ${app.id} FOR UPDATE`;
    const afterLockReplay = await tx.releaseCandidate.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (afterLockReplay) {
      if (afterLockReplay.requestHash !== requestHash) {
        throw new ControlPlaneError("idempotency key가 다른 release candidate에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
      }
      return { candidate: afterLockReplay, duplicate: true };
    }
    const revision = await tx.configRevision.findUnique({
      where: { appId_revision: { appId: app.id, revision: input.configRevision } },
    });
    if (!revision) throw new ControlPlaneError("Config revision을 찾을 수 없습니다.", 404, "REVISION_NOT_FOUND");
    if (revision.status !== "ACTIVE") {
      throw new ControlPlaneError("ACTIVE Config revision만 release candidate에 사용할 수 있습니다.", 409, "REVISION_NOT_ACTIVE");
    }
    const payload = configRevisionPayloadSchema.parse(revision.payload);
    const marketProfile = payload.markets.find((profile) => profile.market === input.market);
    if (!marketProfile?.enabled) {
      throw new ControlPlaneError("ACTIVE revision에서 활성화된 market이 아닙니다.", 409, "MARKET_NOT_ENABLED");
    }
    if (ARTIFACT_BY_MARKET[input.market] !== input.artifactType) {
      throw new ControlPlaneError("market과 artifact type이 일치하지 않습니다.", 409, "ARTIFACT_TYPE_MISMATCH");
    }
    if (payload.build?.workflowBundleSha?.toLowerCase() !== input.workflowBundleSha.toLowerCase()) {
      throw new ControlPlaneError("ACTIVE revision의 WorkflowBundle SHA와 일치하지 않습니다.", 409, "WORKFLOW_BUNDLE_MISMATCH");
    }
    if (payload.build?.platformVersion !== input.platformVersion) {
      throw new ControlPlaneError("ACTIVE revision의 Platform version과 일치하지 않습니다.", 409, "PLATFORM_VERSION_MISMATCH");
    }
    const [discovery, target, externalBindings, platformBinding, approvedPlatformReleases] = await Promise.all([
      tx.discoveryObservation.findFirst({
        where: { appId: app.id, sourceSha: input.sourceSha.toLowerCase() },
        select: { id: true },
      }),
      tx.buildTarget.findUnique({
        where: { appId_targetKey: { appId: app.id, targetKey: input.targetKey } },
        select: {
          observedSha: true,
          market: true,
          packageId: true,
          bundleId: true,
          configuration: true,
        },
      }),
      tx.externalBinding.findMany({
        where: { appId: app.id, provider: input.market },
        select: {
          provider: true,
          bindingType: true,
          externalId: true,
          publicIdentity: true,
        },
      }),
      tx.platformFleetBinding.findUnique({
        where: { appId: app.id },
        include: { platformRelease: { select: { id: true, approval: true, manifestDigest: true } } },
      }),
      tx.platformRelease.findMany({
        where: { approval: "FLEET_APPROVED" },
        orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
        select: { id: true, manifest: true },
      }),
    ]);
    if (!discovery) {
      throw new ControlPlaneError("정확한 source SHA의 DiscoveryObservation이 없습니다.", 409, "SOURCE_NOT_OBSERVED");
    }
    if (
      !target
      || target.observedSha !== input.sourceSha.toLowerCase()
      || target.market !== input.market
    ) {
      throw new ControlPlaneError("source SHA와 market에 고정된 BuildTarget이 없습니다.", 409, "BUILD_TARGET_MISMATCH");
    }
    const targetIdentity = exactBuildTargetIdentity([target], input.market, externalBindings);
    if (targetIdentity.status !== "READY") {
      const code = targetIdentity.status === "EXTERNAL_BINDING_AMBIGUOUS"
        ? "BUILD_IDENTITY_AMBIGUOUS"
        : targetIdentity.status === "IDENTITY_CONFLICT"
          ? "BUILD_IDENTITY_CONFLICT"
          : "BUILD_IDENTITY_MISSING";
      throw new ControlPlaneError(
        "source SHA와 provider application binding의 공개 build identity를 확정할 수 없습니다.",
        409,
        code,
      );
    }
    const latestApprovedRelease = approvedPlatformReleases[0];
    const latestApplicablePlatformRelease = latestApprovedRelease
      ? { ...latestApprovedRelease, parsedManifest: parseStoredPlatformReleaseManifest(latestApprovedRelease.manifest) }
      : null;
    const latestArtifact = latestApplicablePlatformRelease?.parsedManifest.artifacts.find(
      (artifact) => artifact.kind === (app.engine === "GODOT" ? "GDSCRIPT" : "TYPESCRIPT"),
    );
    if (
      latestApplicablePlatformRelease
      && (
        latestApplicablePlatformRelease.parsedManifest.canaryEvidence.workflowBundle.sourceSha.toLowerCase()
          !== input.workflowBundleSha.toLowerCase()
        || latestApplicablePlatformRelease.parsedManifest.canaryEvidence.workflowBundle.digest.toLowerCase()
          !== `sha256:${input.workflowBundleDigest.toLowerCase()}`
      )
    ) {
      throw new ControlPlaneError(
        "FLEET_APPROVED canary의 exact WorkflowBundle SHA/digest와 일치하지 않습니다.",
        409,
        "WORKFLOW_BUNDLE_APPROVAL_MISMATCH",
      );
    }
    if (
      !latestApplicablePlatformRelease
      || !platformBinding
      || platformBinding.platformReleaseId !== latestApplicablePlatformRelease.id
      || platformBinding.platformRelease?.approval !== "FLEET_APPROVED"
      || platformBinding.platformRelease.manifestDigest !== platformBinding.manifestDigest
      || platformBinding.state !== "COMPLIANT"
      || platformBinding.sourceSha?.toLowerCase() !== input.sourceSha.toLowerCase()
      || platformBinding.observedVersion !== input.platformVersion
      || platformBinding.approvedVersion !== input.platformVersion
      || platformBinding.approvedVersion !== latestArtifact?.version
      || !platformBinding.observedDigest
      || platformBinding.observedDigest !== platformBinding.approvedDigest
      || platformBinding.approvedDigest !== latestArtifact?.digest.toLowerCase()
      || platformBinding.contractRevision?.toLowerCase()
        !== latestApplicablePlatformRelease.parsedManifest.contractRevision.toLowerCase()
    ) {
      throw new ControlPlaneError(
        "최신 FLEET_APPROVED Platform SDK의 exact version/digest 관측 전에는 release candidate를 만들 수 없습니다.",
        409,
        "PLATFORM_FLEET_STALE",
      );
    }
    const candidate = await tx.releaseCandidate.create({
      data: {
        appId: app.id,
        sourceSha: input.sourceSha.toLowerCase(),
        configRevisionId: revision.id,
        artifactChecksum: input.artifactChecksum.toLowerCase(),
        market: input.market,
        targetKey: input.targetKey,
        artifactType: input.artifactType,
        workflowBundleSha: input.workflowBundleSha.toLowerCase(),
        workflowBundleDigest: input.workflowBundleDigest.toLowerCase(),
        platformVersion: input.platformVersion,
        requestHash,
        idempotencyKey: input.idempotencyKey,
        createdBy: input.actor,
      },
    });
    await tx.auditLog.create({
      data: {
        actorLogin: input.actor,
        action: "control-plane.release-candidate.create",
        entityType: "ReleaseCandidate",
        entityId: candidate.id,
        payload: {
          appId: app.id,
          sourceSha: candidate.sourceSha,
          configRevision: revision.revision,
          market: candidate.market,
          targetKey: candidate.targetKey,
          artifactChecksum: candidate.artifactChecksum,
          workflowBundleSha: candidate.workflowBundleSha,
          workflowBundleDigest: candidate.workflowBundleDigest,
          platformVersion: candidate.platformVersion,
        },
      },
    });
    return { candidate, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export function releaseCandidateStatus(
  observations: Array<{ gate: string; status: ReleaseGateStatus; observedAt: Date; createdAt: Date; id: string }>,
): "PREPARED" | "READY" | "BLOCKED" {
  const latest = new Map<string, ReleaseGateStatus>();
  for (const observation of [...observations].sort((left, right) => (
    right.observedAt.getTime() - left.observedAt.getTime()
    || right.createdAt.getTime() - left.createdAt.getTime()
    || right.id.localeCompare(left.id)
  ))) {
    if (!latest.has(observation.gate)) latest.set(observation.gate, observation.status);
  }
  const required = RELEASE_CANDIDATE_REQUIRED_GATES.map((gate) => latest.get(gate));
  if (required.some((status) => status === "FAILED" || status === "HUMAN_REQUIRED")) return "BLOCKED";
  if (required.every((status) => status === "PASSED")) return "READY";
  return "PREPARED";
}

/** append-only 관측 row에서 전이 정책이 읽는 identity 증거만 뽑아낸다. */
function gateObservationFact(row: {
  id: string;
  gate: string;
  status: ReleaseGateStatus;
  observedAt: Date;
  createdAt: Date;
  evidence: Prisma.JsonValue;
}): GateObservationFact {
  const evidence = row.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence)
    ? row.evidence as Record<string, unknown>
    : {};
  return {
    id: row.id,
    gate: row.gate,
    status: row.status,
    observedAt: row.observedAt,
    createdAt: row.createdAt,
    providerReference: typeof evidence.providerReference === "string" ? evidence.providerReference : null,
    publicIdentity: typeof evidence.publicIdentity === "string" ? evidence.publicIdentity : null,
  };
}

export interface ReleaseGateEvidence {
  schemaVersion: 1;
  sourceSha: string;
  configRevision: number;
  artifactChecksum: string;
  providerReference?: string;
  publicIdentity?: string;
  note?: string;
}

/**
 * 관측이 어느 경계에서 왔는지를 계약으로 고정한다.
 * `PROVIDER_SETTLEMENT`는 provider execution transaction 안에서만 만들 수 있으며
 * 호출자가 값을 직접 넘기는 HTTP 요청 경로에는 존재하지 않는다.
 */
export type ReleaseGateOrigin =
  | { kind: "CANDIDATE_GATE" }
  | {
    kind: "PROVIDER_SETTLEMENT";
    executionId: string;
    observationId: string;
    publicAccountId: string;
    publicAppId: string;
    bindingHash: string;
    policyGrantId: string;
  };

function gateRequestHash(input: {
  candidateId: string;
  gate: ReleaseGateName;
  status: ReleaseGateStatus;
  observedAt: Date;
  evidence: ReleaseGateEvidence;
  actor: string;
}): string {
  return jsonDigest({
    ...input,
    observedAt: input.observedAt.toISOString(),
  } as unknown as JsonValue);
}

/**
 * append-only gate 원장에 한 관측을 쓰고 candidate status와 중앙 lifecycle을 같은 transaction에서 갱신한다.
 * 범용 release-gate 요청과 실제 provider settlement가 이 helper 하나만 사용한다.
 * 별도 validator나 두 번째 원장을 만들지 않는다.
 */
export async function appendReleaseGateObservation(input: {
  tx: Prisma.TransactionClient;
  candidateId: string;
  gate: ReleaseGateName;
  status: ReleaseGateStatus;
  observedAt: Date;
  evidence: ReleaseGateEvidence;
  actor: string;
  dedupeKey: string;
  requestHash: string;
  origin: ReleaseGateOrigin;
}) {
  const { tx } = input;
  const candidate = await tx.releaseCandidate.findUnique({
    where: { id: input.candidateId },
    include: { configRevision: { select: { revision: true } } },
  });
  if (!candidate) throw new ControlPlaneError("Release candidate를 찾을 수 없습니다.", 404, "CANDIDATE_NOT_FOUND");
  if (
    candidate.sourceSha !== input.evidence.sourceSha.toLowerCase()
    || candidate.configRevision.revision !== input.evidence.configRevision
    || candidate.artifactChecksum !== input.evidence.artifactChecksum.toLowerCase()
  ) {
    throw new ControlPlaneError("Gate evidence가 candidate의 source/config/artifact와 일치하지 않습니다.", 409, "EVIDENCE_MISMATCH");
  }
  if (isExternalReleaseGate(input.gate) && input.origin.kind !== "PROVIDER_SETTLEMENT") {
    throw new ControlPlaneError(
      "외부 단계 gate는 exact ProviderExecution settlement에서만 기록할 수 있습니다.",
      409,
      "EXTERNAL_GATE_PROVIDER_ONLY",
    );
  }
  if (!isExternalReleaseGate(input.gate) && input.origin.kind === "PROVIDER_SETTLEMENT") {
    throw new ControlPlaneError(
      "release-candidate gate는 provider settlement로 기록할 수 없습니다.",
      409,
      "CANDIDATE_GATE_PROVIDER_FORBIDDEN",
    );
  }
  if (
    input.status === "PASSED"
    && !gateIdentitySatisfied({
      gate: input.gate,
      providerReference: input.evidence.providerReference ?? null,
      publicIdentity: input.evidence.publicIdentity ?? null,
    })
  ) {
    throw new ControlPlaneError(
      "외부 단계 gate의 PASSED 관측에는 exact provider/public identity 증거가 필요합니다.",
      409,
      "GATE_IDENTITY_REQUIRED",
    );
  }

  let evidence: Record<string, unknown> = { ...input.evidence };
  if (input.origin.kind === "PROVIDER_SETTLEMENT") {
    const origin = input.origin;
    const execution = await tx.providerExecution.findUnique({
      where: { id: origin.executionId },
      select: {
        id: true,
        appId: true,
        kind: true,
        provider: true,
        releaseCandidateId: true,
        sourceSha: true,
        configRevisionNumber: true,
        artifactChecksum: true,
        publicAccountId: true,
        resourceId: true,
        bindingHash: true,
        leaseGeneration: true,
      },
    });
    if (
      !execution
      || execution.kind !== "MARKET_RELEASE"
      || execution.releaseCandidateId !== candidate.id
      || execution.appId !== candidate.appId
      || execution.sourceSha !== candidate.sourceSha
      || execution.configRevisionNumber !== candidate.configRevision.revision
      || (execution.artifactChecksum ?? "") !== candidate.artifactChecksum
      || execution.publicAccountId !== origin.publicAccountId
      || execution.resourceId !== origin.publicAppId
      || execution.bindingHash !== origin.bindingHash
    ) {
      throw new ControlPlaneError(
        "gate 관측이 exact ProviderExecution binding과 일치하지 않습니다.",
        409,
        "PROVIDER_EXECUTION_BINDING_MISMATCH",
      );
    }
    const providerObservation = await tx.providerObservation.findUnique({
      where: { id: origin.observationId },
      select: { id: true, appId: true, provider: true, resourceId: true },
    });
    if (
      !providerObservation
      || providerObservation.appId !== execution.appId
      || providerObservation.provider !== execution.provider
      || providerObservation.resourceId !== execution.resourceId
    ) {
      throw new ControlPlaneError(
        "gate 관측이 signed provider readback observation과 결합되지 않았습니다.",
        409,
        "PROVIDER_OBSERVATION_BINDING_MISMATCH",
      );
    }
    if (input.evidence.publicIdentity !== `${origin.publicAccountId}/${origin.publicAppId}`) {
      throw new ControlPlaneError(
        "provider account/team/workspace 또는 app identity가 일치하지 않습니다.",
        409,
        "PROVIDER_IDENTITY_MISMATCH",
      );
    }
    // 호출자가 넣을 수 없는 서버 파생 provenance만 원장에 덧붙인다.
    if (origin.policyGrantId !== `provider-grant-${execution.bindingHash.slice(0, 40)}-${execution.leaseGeneration}`) {
      throw new ControlPlaneError(
        "gate 관측이 exact Auth Broker policy grant에 결합되지 않았습니다.",
        409,
        "PROVIDER_POLICY_GRANT_BINDING_MISMATCH",
      );
    }
    evidence = {
      ...evidence,
      providerExecutionId: execution.id,
      providerObservationId: providerObservation.id,
      providerPolicyGrantId: origin.policyGrantId,
    };
  }

  const observation = await tx.releaseGateObservation.create({
    data: {
      candidateId: candidate.id,
      gate: input.gate,
      status: input.status,
      evidence: jsonInput(evidence),
      dedupeKey: input.dedupeKey,
      requestHash: input.requestHash,
      observedBy: input.actor,
      observedAt: input.observedAt,
    },
  });
  const observations = await tx.releaseGateObservation.findMany({
    where: { candidateId: candidate.id },
    select: { gate: true, status: true, observedAt: true, createdAt: true, id: true, evidence: true },
  });
  const candidateStatus = releaseCandidateStatus(observations);
  await tx.releaseCandidate.update({ where: { id: candidate.id }, data: { status: candidateStatus } });
  const evidenceStage = evidenceLifecycleStage(observations.map(gateObservationFact));
  if (evidenceStage) {
    const state = await tx.fleetLifecycleState.findUnique({ where: { appId: candidate.appId } });
    if (!state || lifecycleStageRank(state.stage) < lifecycleStageRank(evidenceStage)) {
      await tx.fleetLifecycleState.upsert({
        where: { appId: candidate.appId },
        create: {
          appId: candidate.appId,
          stage: evidenceStage,
          sourceSha: candidate.sourceSha,
          configRevisionId: candidate.configRevisionId,
          generation: 1,
        },
        update: {
          stage: evidenceStage,
          sourceSha: candidate.sourceSha,
          configRevisionId: candidate.configRevisionId,
          generation: { increment: 1 },
        },
      });
      await tx.fleetLifecycleEvent.upsert({
        where: { idempotencyKey: `candidate-evidence:${candidate.id}:${evidenceStage}` },
        create: {
          appId: candidate.appId,
          fromStage: state?.stage,
          toStage: evidenceStage,
          sourceSha: candidate.sourceSha,
          configRevisionId: candidate.configRevisionId,
          actor: input.actor,
          idempotencyKey: `candidate-evidence:${candidate.id}:${evidenceStage}`,
          evidence: { candidateId: candidate.id, gate: input.gate, observationId: observation.id },
        },
        update: {},
      });
    }
  }
  await tx.auditLog.create({
    data: {
      actorLogin: input.actor,
      action: "control-plane.release-gate.record",
      entityType: "ReleaseGateObservation",
      entityId: observation.id,
      payload: {
        candidateId: candidate.id,
        gate: input.gate,
        status: input.status,
        origin: input.origin.kind,
        candidateStatus,
        lifecycleStage: evidenceStage,
        sourceSha: candidate.sourceSha,
        configRevision: candidate.configRevision.revision,
        artifactChecksum: candidate.artifactChecksum,
        providerExecutionId: input.origin.kind === "PROVIDER_SETTLEMENT" ? input.origin.executionId : null,
      },
    },
  });
  return { observation, candidateStatus, lifecycleStage: evidenceStage };
}

/**
 * 범용 control-plane release-gate 요청 경로다.
 * release-candidate를 만드는 6개 gate만 받으며 외부 단계 gate는 helper가 거부한다.
 */
export async function recordReleaseGateObservation(input: {
  candidateId: string;
  gate: ReleaseGateName;
  status: ReleaseGateStatus;
  observedAt: Date;
  evidence: ReleaseGateEvidence;
  actor: string;
  idempotencyKey: string;
}) {
  assertObservationTime(input.observedAt);
  const requestHash = gateRequestHash(input);
  const replay = await prisma.releaseGateObservation.findUnique({ where: { dedupeKey: input.idempotencyKey } });
  if (replay) {
    if (replay.requestHash !== requestHash) {
      throw new ControlPlaneError("idempotency key가 다른 release gate에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { observation: replay, duplicate: true };
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM control_plane_release_candidate WHERE id = ${input.candidateId} FOR UPDATE`;
    const afterLockReplay = await tx.releaseGateObservation.findUnique({
      where: { dedupeKey: input.idempotencyKey },
    });
    if (afterLockReplay) {
      if (afterLockReplay.requestHash !== requestHash) {
        throw new ControlPlaneError("idempotency key가 다른 release gate에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
      }
      return { observation: afterLockReplay, duplicate: true };
    }
    const result = await appendReleaseGateObservation({
      tx,
      candidateId: input.candidateId,
      gate: input.gate,
      status: input.status,
      observedAt: input.observedAt,
      evidence: input.evidence,
      actor: input.actor,
      dedupeKey: input.idempotencyKey,
      requestHash,
      origin: { kind: "CANDIDATE_GATE" },
    });
    return { observation: result.observation, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
