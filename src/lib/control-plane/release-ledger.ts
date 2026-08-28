import { Prisma, type ReleaseGateStatus } from "@prisma/client";
import {
  configRevisionPayloadSchema,
  platformReleaseManifestSchema,
  RELEASE_CANDIDATE_REQUIRED_GATES,
  type ReleaseGateName,
} from "@/lib/control-plane/contracts";
import { assertObservationTime, ControlPlaneError } from "@/lib/control-plane/service";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";

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
  platformVersion: string;
  actor: string;
}): string {
  return jsonDigest({
    ...input,
    repoId: input.repoId.toString(),
    sourceSha: input.sourceSha.toLowerCase(),
    artifactChecksum: input.artifactChecksum.toLowerCase(),
    workflowBundleSha: input.workflowBundleSha.toLowerCase(),
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
      select: { id: true, repoId: true },
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
    const [discovery, target, platformBinding, approvedPlatformReleases] = await Promise.all([
      tx.discoveryObservation.findFirst({
        where: { appId: app.id, sourceSha: input.sourceSha.toLowerCase() },
        select: { id: true },
      }),
      tx.buildTarget.findUnique({
        where: { appId_targetKey: { appId: app.id, targetKey: input.targetKey } },
        select: { observedSha: true, market: true },
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
    const repoId = app.repoId?.toString() ?? null;
    const latestApplicablePlatformRelease = repoId
      ? approvedPlatformReleases
          .map((release) => ({ ...release, parsedManifest: platformReleaseManifestSchema.parse(release.manifest) }))
          .find((release) => release.parsedManifest.consumers.some((consumer) => consumer.repoId === repoId))
      : null;
    const latestConsumer = latestApplicablePlatformRelease?.parsedManifest.consumers.find(
      (consumer) => consumer.repoId === repoId,
    );
    const latestArtifact = latestApplicablePlatformRelease?.parsedManifest.artifacts.find(
      (artifact) => artifact.kind === latestConsumer?.artifactKind,
    );
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

function gateRequestHash(input: {
  candidateId: string;
  gate: ReleaseGateName;
  status: ReleaseGateStatus;
  observedAt: Date;
  evidence: Record<string, unknown>;
  actor: string;
}): string {
  return jsonDigest({
    ...input,
    observedAt: input.observedAt.toISOString(),
  } as JsonValue);
}

export async function recordReleaseGateObservation(input: {
  candidateId: string;
  gate: ReleaseGateName;
  status: ReleaseGateStatus;
  observedAt: Date;
  evidence: {
    schemaVersion: 1;
    sourceSha: string;
    configRevision: number;
    artifactChecksum: string;
    providerReference?: string;
    publicIdentity?: string;
    note?: string;
  };
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
    const observation = await tx.releaseGateObservation.create({
      data: {
        candidateId: candidate.id,
        gate: input.gate,
        status: input.status,
        evidence: jsonInput(input.evidence),
        dedupeKey: input.idempotencyKey,
        requestHash,
        observedBy: input.actor,
        observedAt: input.observedAt,
      },
    });
    const observations = await tx.releaseGateObservation.findMany({
      where: { candidateId: candidate.id },
      select: { gate: true, status: true, observedAt: true, createdAt: true, id: true },
    });
    const status = releaseCandidateStatus(observations);
    await tx.releaseCandidate.update({ where: { id: candidate.id }, data: { status } });
    if (status === "READY") {
      const state = await tx.fleetLifecycleState.findUnique({ where: { appId: candidate.appId } });
      const rank = [
        "IDEA", "PLANNING", "SPEC_REVIEW", "APPROVED", "BUILD", "QA", "RELEASE_ASSETS",
        "RELEASE_CANDIDATE", "SUBMITTED", "REVIEW", "APPROVED_FOR_RELEASE", "DEPLOYED",
        "PUBLIC_VERIFIED", "MONITORED",
      ];
      if (!state || rank.indexOf(state.stage) < rank.indexOf("RELEASE_CANDIDATE")) {
        await tx.fleetLifecycleState.upsert({
          where: { appId: candidate.appId },
          create: {
            appId: candidate.appId,
            stage: "RELEASE_CANDIDATE",
            sourceSha: candidate.sourceSha,
            configRevisionId: candidate.configRevisionId,
            generation: 1,
          },
          update: {
            stage: "RELEASE_CANDIDATE",
            sourceSha: candidate.sourceSha,
            configRevisionId: candidate.configRevisionId,
            generation: { increment: 1 },
          },
        });
        await tx.fleetLifecycleEvent.upsert({
          where: { idempotencyKey: `candidate-ready:${candidate.id}` },
          create: {
            appId: candidate.appId,
            fromStage: state?.stage,
            toStage: "RELEASE_CANDIDATE",
            sourceSha: candidate.sourceSha,
            configRevisionId: candidate.configRevisionId,
            actor: input.actor,
            idempotencyKey: `candidate-ready:${candidate.id}`,
            evidence: { candidateId: candidate.id },
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
          candidateStatus: status,
          sourceSha: candidate.sourceSha,
          configRevision: candidate.configRevision.revision,
          artifactChecksum: candidate.artifactChecksum,
        },
      },
    });
    return { observation, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
