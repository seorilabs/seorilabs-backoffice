import crypto from "node:crypto";
import { Prisma, type PlatformFleetPlanStatus, type PlatformRelease } from "@prisma/client";

import {
  agentResultSchema,
  isStoredPlatformReleaseV067Omission,
  parseStoredPlatformReleaseManifest,
  platformConsumerObservationPayloadSchema,
  platformFleetTaskInputSchema,
  platformReleaseManifestSchema,
  redactCredentialCandidates,
  type PlatformFleetTaskInput,
  type PlatformReleaseManifest,
} from "@/lib/control-plane/contracts";
import {
  PLATFORM_FLEET_AUTOMATION_TEMPLATE_KEY,
  parseManagedPlatformFleetPolicy,
  platformFleetAutomationPolicy,
} from "@/lib/control-plane/automation-catalog";
import { canonicalJson, jsonDigest, verifySnapshot, type JsonValue } from "@/lib/control-plane/json";
import { loadExactManagedPlatformConsumers } from "@/lib/control-plane/platform-fleet-cohort";
import { platformFleetDisposition } from "@/lib/control-plane/platform-fleet-policy";
import { repositorySourceIsCurrent } from "@/lib/control-plane/repository-registration";
import { assertObservationTime, ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";

const PLATFORM_PROVIDER = "platform";
const PLATFORM_CONSUMER_RESOURCE = "platform-consumer";
const PLATFORM_PLAN_BUDGET_MICROS = 2_000_000;
const REQUIRED_CHECKS = ["test:core", "check:architecture", "check:release", "repo-contract"] as const;
const PLATFORM_ISSUE_LABELS = {
  P1: { color: "E99695", description: "최우선" },
  autopilot: { color: "0E8A16", description: "자율 스케줄러 처리 대상" },
  platform: { color: "0052CC", description: "Seorilabs Platform 연동" },
  "platform-contract": { color: "FBCA04", description: "Platform 계약 변경 대응" },
  "platform-remediation": { color: "D4C5F9", description: "Platform SDK 비관리 상태 해소" },
} as const;

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function repoParts(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = repoFullName.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new ControlPlaneError("관리 repository identity가 올바르지 않습니다.", 409, "REPOSITORY_IDENTITY_INVALID");
  }
  return { owner, repo };
}

function publicError(error: unknown): string {
  return redactCredentialCandidates(error instanceof Error ? error.message : "PLATFORM_FLEET_OPERATION_FAILED").slice(0, 1_000);
}

function platformMarker(manifestDigest: string, repoId: string): string {
  return `<!-- seorilabs-platform-fleet:${manifestDigest}:${repoId} -->`;
}

function platformRemediationMarker(repoId: string): string {
  return `<!-- seorilabs-platform-remediation:v1:${repoId} -->`;
}

function platformPlanWorkKey(manifestDigest: string, repoId: string): string {
  return `platform:${manifestDigest}:${repoId}`;
}

function platformDefinitionKey(appId: string): string {
  const suffix = crypto.createHash("sha256").update(appId).digest("hex").slice(0, 24);
  return `${PLATFORM_FLEET_AUTOMATION_TEMPLATE_KEY}:codex:${suffix}`;
}

function releaseRequestHash(input: {
  manifest: PlatformReleaseManifest;
  manifestDigest: string;
  signature: string;
  actor: string;
}): string {
  return jsonDigest({
    manifest: input.manifest,
    manifestDigest: input.manifestDigest.toLowerCase(),
    signature: input.signature.toLowerCase(),
    actor: input.actor,
  } as JsonValue);
}

function existingV067ReleaseMatchesReadOnly(input: {
  stored: PlatformRelease;
  incoming: PlatformReleaseManifest;
  incomingActor: string;
  incomingIdempotencyKey: string;
  signingKey: string;
}): boolean {
  if (!isStoredPlatformReleaseV067Omission(input.stored.manifest)) return false;
  if (!verifySnapshot(
    input.stored.manifest as JsonValue,
    input.signingKey,
    input.stored.manifestDigest,
    input.stored.signature,
  )) {
    throw new ControlPlaneError(
      "저장된 v0.6.7 Platform release signature 검증에 실패했습니다.",
      409,
      "PLATFORM_RELEASE_TAMPERED",
    );
  }
  const expectedStoredRequestHash = jsonDigest({
    manifest: input.stored.manifest,
    manifestDigest: input.stored.manifestDigest.toLowerCase(),
    signature: input.stored.signature.toLowerCase(),
    actor: input.stored.observedBy,
  } as JsonValue);
  if (input.stored.requestHash !== expectedStoredRequestHash) {
    throw new ControlPlaneError(
      "저장된 v0.6.7 Platform release idempotency identity가 유효하지 않습니다.",
      409,
      "PLATFORM_RELEASE_TAMPERED",
    );
  }
  const projected = parseStoredPlatformReleaseManifest(input.stored.manifest);
  return input.stored.version === projected.version
    && input.stored.observedBy === input.incomingActor
    && input.stored.idempotencyKey === input.incomingIdempotencyKey
    && input.stored.sourceSha === projected.sourceSha.toLowerCase()
    && input.stored.classification === projected.classification
    && input.stored.approval === projected.approval
    && input.stored.contractRevision === projected.contractRevision.toLowerCase()
    && input.stored.publishedAt.toISOString() === new Date(projected.publishedAt).toISOString()
    && canonicalJson(projected as unknown as JsonValue)
      === canonicalJson(input.incoming as unknown as JsonValue);
}

export async function recordPlatformRelease(input: {
  manifest: PlatformReleaseManifest;
  manifestDigest: string;
  signature: string;
  actor: string;
  idempotencyKey: string;
  signingKey: string;
}) {
  const manifest = platformReleaseManifestSchema.parse(input.manifest);
  const manifestDigest = input.manifestDigest.toLowerCase();
  const signature = input.signature.toLowerCase();
  const publishedAt = new Date(manifest.publishedAt);
  assertObservationTime(publishedAt);
  if (!verifySnapshot(manifest as unknown as JsonValue, input.signingKey, manifestDigest, signature)) {
    throw new ControlPlaneError(
      "Platform release manifest digest 또는 signature가 유효하지 않습니다.",
      403,
      "PLATFORM_RELEASE_SIGNATURE_INVALID",
    );
  }
  const requestHash = releaseRequestHash({ manifest, manifestDigest, signature, actor: input.actor });
  const replay = await prisma.platformRelease.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (replay) {
    if (existingV067ReleaseMatchesReadOnly({
      stored: replay,
      incoming: manifest,
      incomingActor: input.actor,
      incomingIdempotencyKey: input.idempotencyKey,
      signingKey: input.signingKey,
    })) {
      return { release: replay, duplicate: true };
    }
    if (replay.requestHash !== requestHash || replay.manifestDigest !== manifestDigest) {
      throw new ControlPlaneError("idempotency key가 다른 Platform release에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { release: replay, duplicate: true };
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const conflicting = await tx.platformRelease.findFirst({
        where: { OR: [{ version: manifest.version }, { manifestDigest }] },
      });
      if (conflicting) {
        if (existingV067ReleaseMatchesReadOnly({
          stored: conflicting,
          incoming: manifest,
          incomingActor: input.actor,
          incomingIdempotencyKey: input.idempotencyKey,
          signingKey: input.signingKey,
        })) {
          return { release: conflicting, duplicate: true };
        }
        if (
          conflicting.version !== manifest.version
          || conflicting.manifestDigest !== manifestDigest
          || conflicting.requestHash !== requestHash
        ) {
          throw new ControlPlaneError("Platform version 또는 manifest digest가 다른 release에 고정되어 있습니다.", 409, "PLATFORM_RELEASE_CONFLICT");
        }
        return { release: conflicting, duplicate: true };
      }
      const release = await tx.platformRelease.create({
        data: {
          version: manifest.version,
          sourceSha: manifest.sourceSha.toLowerCase(),
          classification: manifest.classification,
          approval: manifest.approval,
          contractRevision: manifest.contractRevision.toLowerCase(),
          manifest: jsonInput(manifest),
          manifestDigest,
          signature,
          publishedAt,
          observedBy: input.actor,
          requestHash,
          idempotencyKey: input.idempotencyKey,
        },
      });
      await tx.auditLog.create({
        data: {
          actorLogin: input.actor,
          action: "control-plane.platform-release.record",
          entityType: "PlatformRelease",
          entityId: release.id,
          payload: {
            version: release.version,
            sourceSha: release.sourceSha,
            classification: release.classification,
            approval: release.approval,
            contractRevision: release.contractRevision,
            manifestDigest: release.manifestDigest,
          },
        },
      });
      return { release, duplicate: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    return recordPlatformRelease(input);
  }
}

function contractIssueTask(input: {
  planId: string;
  repoId: string;
  repoFullName: string;
  sourceSha: string;
  manifest: PlatformReleaseManifest;
  manifestDigest: string;
  artifact: PlatformReleaseManifest["artifacts"][number];
}): PlatformFleetTaskInput {
  const marker = platformMarker(input.manifestDigest, input.repoId);
  const change = input.manifest.classification === "CONTRACT_ADDITION" ? "추가" : "변경";
  return platformFleetTaskInputSchema.parse({
    schemaVersion: 1,
    kind: "PLATFORM_CONTRACT_ISSUE",
    planId: input.planId,
    repoId: input.repoId,
    repoFullName: input.repoFullName,
    sourceSha: input.sourceSha,
    manifestDigest: input.manifestDigest,
    releaseVersion: input.manifest.version,
    releaseSourceSha: input.manifest.sourceSha,
    contractRevision: input.manifest.contractRevision,
    classification: input.manifest.classification,
    artifact: input.artifact,
    issueMarker: marker,
    title: `[P1] Platform ${input.manifest.version} 계약 ${change} 대응`,
    body: [
      marker,
      "",
      `Platform ${input.manifest.version}의 계약 ${change}를 이 레포에 반영합니다.`,
      "",
      `- 기준 source SHA: \`${input.sourceSha}\``,
      `- Platform source SHA: \`${input.manifest.sourceSha}\``,
      `- Manifest digest: \`${input.manifestDigest}\``,
      `- Contract revision: \`${input.manifest.contractRevision}\``,
      `- SDK: ${input.artifact.kind} ${input.artifact.version} / \`${input.artifact.digest}\``,
      "",
      "코드와 테스트 적응까지만 이 이슈에서 처리합니다. feature 활성화, 업로드, 실기기 QA, 공개 rollout은 별도 gate입니다.",
    ].join("\n"),
    labels: ["P1", "autopilot", "platform", "platform-contract"],
  });
}

function integrationRemediationIssueTask(input: {
  planId: string;
  repoId: string;
  repoFullName: string;
  sourceSha: string;
  manifest: PlatformReleaseManifest;
  manifestDigest: string;
  artifact: PlatformReleaseManifest["artifacts"][number];
  integration: "CUSTOM_HTTP" | "MISSING";
}): PlatformFleetTaskInput {
  const marker = platformRemediationMarker(input.repoId);
  const custom = input.integration === "CUSTOM_HTTP";
  return platformFleetTaskInputSchema.parse({
    schemaVersion: 1,
    kind: "PLATFORM_INTEGRATION_REMEDIATION_ISSUE",
    planId: input.planId,
    repoId: input.repoId,
    repoFullName: input.repoFullName,
    sourceSha: input.sourceSha,
    manifestDigest: input.manifestDigest,
    releaseVersion: input.manifest.version,
    releaseSourceSha: input.manifest.sourceSha,
    contractRevision: input.manifest.contractRevision,
    integration: input.integration,
    artifact: input.artifact,
    issueMarker: marker,
    title: custom
      ? "[P1] Platform custom HTTP 연동을 공식 SDK로 전환"
      : "[P1] Platform 공식 SDK 탑재",
    body: [
      marker,
      "",
      custom
        ? "현재 custom HTTP 연동을 중앙 Platform SDK 계약으로 전환합니다."
        : "현재 누락된 중앙 Platform SDK를 탑재합니다.",
      "",
      `- 기준 source SHA: \`${input.sourceSha}\``,
      `- 승인 Platform release: \`${input.manifest.version}\` / \`${input.manifest.sourceSha}\``,
      `- Manifest digest: \`${input.manifestDigest}\``,
      `- Contract revision: \`${input.manifest.contractRevision}\``,
      `- SDK: ${input.artifact.kind} ${input.artifact.version} / \`${input.artifact.digest}\``,
      `- 탐지 상태: \`${input.integration}\``,
      "",
      "공식 SDK 탑재와 회귀 테스트까지만 이 이슈에서 처리합니다. feature 활성화, 업로드, 실기기 QA, 공개 rollout은 별도 gate입니다.",
    ].join("\n"),
    labels: ["P1", "autopilot", "platform", "platform-remediation"],
  });
}

function sdkUpdateTask(input: {
  planId: string;
  repoId: string;
  repoFullName: string;
  sourceSha: string;
  manifest: PlatformReleaseManifest;
  manifestDigest: string;
  artifact: PlatformReleaseManifest["artifacts"][number];
}): PlatformFleetTaskInput {
  return platformFleetTaskInputSchema.parse({
    schemaVersion: 1,
    kind: "PLATFORM_SDK_UPDATE",
    planId: input.planId,
    repoId: input.repoId,
    repoFullName: input.repoFullName,
    sourceSha: input.sourceSha,
    manifestDigest: input.manifestDigest,
    releaseVersion: input.manifest.version,
    releaseSourceSha: input.manifest.sourceSha,
    contractRevision: input.manifest.contractRevision,
    artifact: input.artifact,
    pullRequestMarker: platformMarker(input.manifestDigest, input.repoId),
    requiredChecks: [...REQUIRED_CHECKS],
  });
}

async function ensurePlatformDefinition(
  tx: Prisma.TransactionClient,
  app: { id: string },
) {
  const key = platformDefinitionKey(app.id);
  const policy = platformFleetAutomationPolicy({ budgetCeilingMicros: PLATFORM_PLAN_BUDGET_MICROS });
  const existing = await tx.automationDefinition.findUnique({ where: { key } });
  if (existing) {
    const existingPolicy = parseManagedPlatformFleetPolicy(existing.configuration);
    if (
      existing.appId !== app.id
      || existing.template !== PLATFORM_FLEET_AUTOMATION_TEMPLATE_KEY
      || existing.agentKind !== "CODEX"
      || existing.schedule !== null
      || existing.model !== null
      || existing.maxAttempts !== 3
      || !existing.enabled
      || existing.cancelledAt !== null
      || !existingPolicy
      || canonicalJson(existingPolicy as unknown as JsonValue) !== canonicalJson(policy as unknown as JsonValue)
    ) {
      throw new ControlPlaneError("Platform Fleet worker definition이 다른 계약으로 존재합니다.", 409, "PLATFORM_DEFINITION_CONFLICT");
    }
    return existing;
  }
  return tx.automationDefinition.create({
    data: {
      key,
      appId: app.id,
      template: PLATFORM_FLEET_AUTOMATION_TEMPLATE_KEY,
      agentKind: "CODEX",
      configuration: jsonInput(policy),
      maxAttempts: 3,
    },
  });
}

async function enqueueSdkUpdatePlan(input: {
  tx: Prisma.TransactionClient;
  planId: string;
  workKey: string;
  task: PlatformFleetTaskInput;
  app: { id: string; repoFullName: string };
  release: { id: string; createdAt: Date; manifestDigest: string };
}) {
  const definition = await ensurePlatformDefinition(input.tx, input.app);
  const idempotencyKey = jsonDigest({
    scope: "platform-fleet-agent-run",
    manifestDigest: input.release.manifestDigest,
    appId: input.app.id,
  } as JsonValue);
  const triggerKey = `platform:${input.release.manifestDigest}:${input.app.id}`.slice(0, 191);
  const existing = await input.tx.automationOccurrence.findUnique({
    where: { idempotencyKey },
    include: { runs: true },
  });
  if (existing) {
    const run = existing.runs[0];
    if (!run || run.workKey !== input.workKey || existing.definitionId !== definition.id) {
      throw new ControlPlaneError("Platform Fleet occurrence가 다른 run에 사용되었습니다.", 409, "PLATFORM_OCCURRENCE_CONFLICT");
    }
    if (run.status === "PENDING") {
      await input.tx.agentRun.update({ where: { id: run.id }, data: { taskInput: jsonInput(input.task) } });
    }
    return run;
  }
  const occurrence = await input.tx.automationOccurrence.create({
    data: {
      definitionId: definition.id,
      scheduledFor: input.release.createdAt,
      idempotencyKey,
      triggerKind: "PLATFORM_RELEASE",
      triggerKey,
      runs: {
        create: {
          appId: input.app.id,
          repoFullName: input.app.repoFullName,
          issueState: null,
          labels: ["autopilot", "platform"],
          taskInput: jsonInput(input.task),
          createsPr: true,
          workKey: input.workKey,
          priority: 1,
          maxAttempts: 3,
        },
      },
    },
    include: { runs: true },
  });
  const run = occurrence.runs[0];
  if (!run) throw new Error("Platform Fleet AgentRun creation failed");
  await input.tx.platformFleetPlan.update({ where: { id: input.planId }, data: { agentRunId: run.id, status: "QUEUED" } });
  await input.tx.agentRunEvent.create({
    data: {
      runId: run.id,
      type: "platform_plan_queued",
      actor: "system:platform-fleet",
      payload: {
        planId: input.planId,
        manifestDigest: input.release.manifestDigest,
        sourceSha: input.task.sourceSha,
      },
    },
  });
  return run;
}

export async function reconcilePlatformFleet(input: {
  platformReleaseId: string;
  consumers: Array<{
    repoId: string;
    discoveryObservationId: string;
    providerObservationId: string;
  }>;
  actor: string;
  idempotencyKey: string;
  signingKey: string;
}) {
  const requestHash = jsonDigest({
    platformReleaseId: input.platformReleaseId,
    consumers: [...input.consumers]
      .sort((left, right) => left.repoId.localeCompare(right.repoId))
      .map((consumer) => ({
        repoId: consumer.repoId,
        discoveryObservationId: consumer.discoveryObservationId,
        providerObservationId: consumer.providerObservationId,
      })),
    actor: input.actor,
  } as JsonValue);
  const replay = await prisma.platformFleetReconcileRun.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (replay) {
    if (replay.requestHash !== requestHash || replay.platformReleaseId !== input.platformReleaseId) {
      throw new ControlPlaneError("idempotency key가 다른 Platform Fleet reconcile에 사용되었습니다.", 409, "IDEMPOTENCY_CONFLICT");
    }
    if (replay.status !== "COMPLETED" || !replay.result) {
      throw new ControlPlaneError("Platform Fleet reconcile 결과를 확정할 수 없습니다.", 409, "PLATFORM_RECONCILE_READBACK_REQUIRED");
    }
    return { ...(replay.result as Record<string, unknown>), duplicate: true };
  }
  try {
    return await prisma.$transaction(async (tx) => {
    const release = await tx.platformRelease.findUnique({ where: { id: input.platformReleaseId } });
    if (!release || release.approval !== "FLEET_APPROVED") {
      throw new ControlPlaneError("FLEET_APPROVED Platform release를 찾을 수 없습니다.", 404, "PLATFORM_RELEASE_NOT_APPROVED");
    }
    if (!verifySnapshot(release.manifest as JsonValue, input.signingKey, release.manifestDigest, release.signature)) {
      throw new ControlPlaneError("저장된 Platform release signature 검증에 실패했습니다.", 409, "PLATFORM_RELEASE_TAMPERED");
    }
    const manifest = parseStoredPlatformReleaseManifest(release.manifest);
    const reconcileRun = await tx.platformFleetReconcileRun.create({
      data: {
        platformReleaseId: release.id,
        requestHash,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
      },
    });

    const cohort = await loadExactManagedPlatformConsumers(tx);
    const [observations, currentPlatformObservations] = await Promise.all([
      tx.providerObservation.findMany({
        where: { id: { in: input.consumers.map(({ providerObservationId }) => providerObservationId) } },
        select: {
          id: true,
          appId: true,
          provider: true,
          resourceType: true,
          resourceId: true,
          payload: true,
          payloadHash: true,
          observedAt: true,
        },
      }),
      tx.providerObservation.findMany({
        where: {
          provider: PLATFORM_PROVIDER,
          resourceType: PLATFORM_CONSUMER_RESOURCE,
          resourceId: { in: input.consumers.map(({ repoId }) => repoId) },
        },
        orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        select: { id: true, appId: true, resourceId: true },
      }),
    ]);
    const exactRepoIds = cohort.map(({ registration }) => registration.repoId.toString()).sort();
    const requestedRepoIds = input.consumers.map(({ repoId }) => repoId).sort();
    if (canonicalJson(exactRepoIds) !== canonicalJson(requestedRepoIds)) {
      throw new ControlPlaneError(
        "현재 exact MANAGED PRODUCT_APP cohort 전체와 reconcile input이 정확히 일치해야 합니다.",
        409,
        "PLATFORM_CONSUMER_COHORT_MISMATCH",
      );
    }
    if (observations.length !== cohort.length) {
      throw new ControlPlaneError("모든 manifest consumer의 exact 관리 observation이 필요합니다.", 409, "PLATFORM_OBSERVATION_COHORT_INCOMPLETE");
    }
    const consumerByRepo = new Map(cohort.map((entry) => [entry.registration.repoId.toString(), entry]));
    const observationById = new Map(observations.map((row) => [row.id, row]));
    const currentObservationByRepo = new Map<string, { id: string; appId: string }>();
    for (const observation of currentPlatformObservations) {
      if (!currentObservationByRepo.has(observation.resourceId)) {
        currentObservationByRepo.set(observation.resourceId, observation);
      }
    }
    const artifactByKind = new Map(manifest.artifacts.map((artifact) => [artifact.kind, artifact]));
    const summaries: Array<{ repoId: string; planId: string; kind: string; status: string }> = [];

    for (const consumerInput of input.consumers) {
      const consumer = consumerByRepo.get(consumerInput.repoId);
      const app = consumer?.app;
      const registration = consumer?.registration;
      const discovery = consumer?.discovery;
      const observationRow = observationById.get(consumerInput.providerObservationId);
      if (
        !app
        || !registration
        || !discovery
        || !observationRow
        || consumerInput.discoveryObservationId !== discovery.id
      ) {
        throw new ControlPlaneError("exact MANAGED PRODUCT_APP consumer identity가 일치하지 않습니다.", 409, "PLATFORM_CONSUMER_IDENTITY_MISMATCH");
      }
      if (
        registration.repoFullName.toLowerCase() !== app.repoFullName.toLowerCase()
        || discovery.appId !== app.id
        || observationRow.appId !== app.id
        || !repositorySourceIsCurrent(registration, discovery.sourceSha)
      ) {
        throw new ControlPlaneError("현재 default HEAD에 고정된 discovery/provider observation이 아닙니다.", 409, "PLATFORM_OBSERVATION_STALE");
      }
      if (
        jsonDigest(discovery.payload as JsonValue) !== discovery.payloadHash
        || jsonDigest(observationRow.payload as JsonValue) !== observationRow.payloadHash
      ) {
        throw new ControlPlaneError("Platform reconcile observation digest가 저장 payload와 다릅니다.", 409, "PLATFORM_OBSERVATION_TAMPERED");
      }
      if (
        observationRow.provider !== PLATFORM_PROVIDER
        || observationRow.resourceType !== PLATFORM_CONSUMER_RESOURCE
        || observationRow.resourceId !== consumerInput.repoId
      ) {
        throw new ControlPlaneError("Platform consumer observation 공개 identity가 일치하지 않습니다.", 409, "PLATFORM_PROVIDER_IDENTITY_MISMATCH");
      }
      const currentObservation = currentObservationByRepo.get(consumerInput.repoId);
      if (!currentObservation || currentObservation.id !== observationRow.id || currentObservation.appId !== app.id) {
        throw new ControlPlaneError("최신 Platform provider observation만 reconcile할 수 있습니다.", 409, "PLATFORM_PROVIDER_OBSERVATION_STALE");
      }
      const observation = platformConsumerObservationPayloadSchema.parse(observationRow.payload);
      if (observation.sourceSha.toLowerCase() !== discovery.sourceSha.toLowerCase()) {
        throw new ControlPlaneError("Platform observation source SHA가 current discovery와 다릅니다.", 409, "PLATFORM_OBSERVATION_SOURCE_MISMATCH");
      }
      const expectedArtifactKind = app.engine === "GODOT" ? "GDSCRIPT" : "TYPESCRIPT";
      const artifact = artifactByKind.get(expectedArtifactKind);
      if (!artifact) throw new ControlPlaneError("manifest artifact가 없습니다.", 409, "PLATFORM_ARTIFACT_MISSING");
      if (observation.integration === "SDK" && observation.artifactKind !== artifact.kind) {
        throw new ControlPlaneError("관측 SDK kind가 PRODUCT_APP engine과 다릅니다.", 409, "PLATFORM_ARTIFACT_KIND_MISMATCH");
      }
      const disposition = platformFleetDisposition({
        classification: manifest.classification,
        contractRevision: manifest.contractRevision,
        artifact,
        observation,
      });
      const existing = await tx.platformFleetPlan.findUnique({
        where: { platformReleaseId_appId: { platformReleaseId: release.id, appId: app.id } },
        include: { agentRun: { select: { id: true, occurrenceId: true, status: true, readbackRequestedAt: true } } },
      });
      if (
        existing
        && existing.sourceSha !== discovery.sourceSha
        && ["PROCESSING", "READBACK_REQUIRED"].includes(existing.status)
      ) {
        throw new ControlPlaneError("이전 source의 Platform mutation readback을 먼저 완료해야 합니다.", 409, "PLATFORM_PLAN_READBACK_REQUIRED");
      }
      if (
        existing?.agentRun
        && disposition.kind !== "SDK_UPDATE_PR"
        && (existing.agentRun.status === "RUNNING" || existing.agentRun.readbackRequestedAt)
      ) {
        throw new ControlPlaneError("진행 중인 Platform PR mutation을 readback하기 전에는 plan을 바꿀 수 없습니다.", 409, "PLATFORM_RUN_READBACK_REQUIRED");
      }
      if (
        existing?.agentRun
        && existing.sourceSha !== discovery.sourceSha
        && (existing.agentRun.status === "RUNNING" || existing.agentRun.readbackRequestedAt)
      ) {
        throw new ControlPlaneError("이전 source의 Platform run 결과를 먼저 readback해야 합니다.", 409, "PLATFORM_RUN_READBACK_REQUIRED");
      }
      const planId = existing?.id ?? crypto.randomUUID();
      const task = disposition.kind === "SDK_UPDATE_PR"
        ? sdkUpdateTask({
            planId,
            repoId: consumerInput.repoId,
            repoFullName: app.repoFullName,
            sourceSha: discovery.sourceSha,
            manifest,
            manifestDigest: release.manifestDigest,
            artifact,
          })
        : disposition.kind === "CONTRACT_ISSUE"
          ? contractIssueTask({
              planId,
              repoId: consumerInput.repoId,
              repoFullName: app.repoFullName,
              sourceSha: discovery.sourceSha,
              manifest,
              manifestDigest: release.manifestDigest,
              artifact,
            })
          : disposition.kind === "CUSTOM_UNMANAGED" || disposition.kind === "MISSING_UNMANAGED"
            ? integrationRemediationIssueTask({
                planId,
                repoId: consumerInput.repoId,
                repoFullName: app.repoFullName,
                sourceSha: discovery.sourceSha,
                manifest,
                manifestDigest: release.manifestDigest,
                artifact,
                integration: disposition.kind === "CUSTOM_UNMANAGED" ? "CUSTOM_HTTP" : "MISSING",
              })
            : {
                schemaVersion: 1,
                kind: disposition.kind,
                repoId: consumerInput.repoId,
                repoFullName: app.repoFullName,
                sourceSha: discovery.sourceSha,
                manifestDigest: release.manifestDigest,
                releaseVersion: manifest.version,
                contractRevision: manifest.contractRevision,
                artifact,
                observation,
              } as const;
      const desiredHash = jsonDigest(task as unknown as JsonValue);
      const workKey = platformPlanWorkKey(release.manifestDigest, consumerInput.repoId);
      const marker = platformMarker(release.manifestDigest, consumerInput.repoId);
      let planStatus: PlatformFleetPlanStatus = disposition.status;
      if (existing?.kind === disposition.kind && existing.sourceSha === discovery.sourceSha) {
        if (disposition.kind === "SDK_UPDATE_PR" && ["PROCESSING", "PR_OPEN", "PR_MERGED", "READBACK_REQUIRED", "BLOCKED"].includes(existing.status)) {
          planStatus = existing.status;
        }
        if (disposition.kind === "CONTRACT_ISSUE" && ["PROCESSING", "ISSUE_OPEN", "READBACK_REQUIRED", "BLOCKED"].includes(existing.status)) {
          planStatus = existing.status;
        }
        if (
          (disposition.kind === "CUSTOM_UNMANAGED" || disposition.kind === "MISSING_UNMANAGED")
          && ["PROCESSING", "ISSUE_OPEN", "READBACK_REQUIRED", "BLOCKED"].includes(existing.status)
        ) {
          planStatus = existing.status;
        }
      }
      const cancelPendingSdkRun = disposition.kind !== "SDK_UPDATE_PR"
        && existing?.agentRun?.status === "PENDING";
      if (cancelPendingSdkRun && existing.agentRun) {
        const cancelledAt = new Date();
        const cancelled = await tx.agentRun.updateMany({
          where: { id: existing.agentRun.id, status: "PENDING" },
          data: {
            status: "CANCELLED",
            workKey: null,
            completedAt: cancelledAt,
            error: "PLATFORM_PLAN_SUPERSEDED",
          },
        });
        if (cancelled.count !== 1) {
          throw new ControlPlaneError("Platform AgentRun 취소 CAS에 실패했습니다.", 409, "PLATFORM_RUN_CAS_FAILED");
        }
        await tx.agentRepoGuard.updateMany({
          where: { runId: existing.agentRun.id, activeScopeKey: { not: null } },
          data: { activeScopeKey: null, releasedAt: cancelledAt },
        });
        await tx.automationOccurrence.update({
          where: { id: existing.agentRun.occurrenceId },
          data: { status: "COMPLETED", completedAt: cancelledAt, result: { code: "PLATFORM_PLAN_SUPERSEDED" } },
        });
        await tx.agentRunEvent.create({
          data: {
            runId: existing.agentRun.id,
            type: "platform_plan_superseded",
            actor: "system:platform-fleet",
            payload: { planId, nextKind: disposition.kind },
          },
        });
      }
      const plan = existing
        ? await tx.platformFleetPlan.update({
            where: { id: existing.id },
            data: {
              discoveryObservationId: discovery.id,
              providerObservationId: observationRow.id,
              sourceSha: discovery.sourceSha,
              kind: disposition.kind,
              status: planStatus,
              desired: jsonInput(task),
              desiredHash,
              ...(cancelPendingSdkRun ? { agentRunId: null } : {}),
              lastError: disposition.status === "COMPLIANT" ? null : existing.lastError,
              ...(disposition.status === "COMPLIANT" ? { appliedAt: new Date(), readbackRequestedAt: null } : {}),
            },
          })
        : await tx.platformFleetPlan.create({
            data: {
              id: planId,
              platformReleaseId: release.id,
              appId: app.id,
              discoveryObservationId: discovery.id,
              providerObservationId: observationRow.id,
              sourceSha: discovery.sourceSha,
              kind: disposition.kind,
              status: disposition.status,
              desired: jsonInput(task),
              desiredHash,
              workKey,
              mutationMarker: marker,
              ...(disposition.status === "COMPLIANT" ? { appliedAt: new Date() } : {}),
            },
          });
      if (disposition.kind === "SDK_UPDATE_PR" && !plan.agentRunId) {
        await enqueueSdkUpdatePlan({
          tx,
          planId: plan.id,
          workKey,
          task: platformFleetTaskInputSchema.parse(task),
          app,
          release,
        });
      } else if (disposition.kind === "SDK_UPDATE_PR" && existing?.agentRun?.status === "PENDING") {
        await tx.agentRun.update({ where: { id: existing.agentRun.id }, data: { taskInput: jsonInput(task) } });
      }

      const currentBinding = await tx.platformFleetBinding.findUnique({ where: { appId: app.id } });
      const sameRelease = currentBinding?.platformReleaseId === release.id;
      const observedVersion = observation.integration === "SDK" ? observation.observedVersion : null;
      const observedDigest = observation.integration === "SDK"
        ? observation.observedDigest?.toLowerCase() ?? null
        : null;
      const bindingState = disposition.kind === "SDK_UPDATE_PR" && planStatus === "PR_OPEN"
        ? "UPDATE_PR_OPEN"
        : disposition.kind === "SDK_UPDATE_PR" && planStatus === "PR_MERGED"
          ? "PLATFORM_OBSERVATION_PENDING"
          : disposition.kind === "CONTRACT_ISSUE" && planStatus === "ISSUE_OPEN"
            ? "CONTRACT_ISSUE_OPEN"
            : disposition.kind === "CUSTOM_UNMANAGED" && planStatus === "ISSUE_OPEN"
              ? "CUSTOM_UNMANAGED_REMEDIATION_ISSUE_OPEN"
              : disposition.kind === "MISSING_UNMANAGED" && planStatus === "ISSUE_OPEN"
                ? "MISSING_UNMANAGED_REMEDIATION_ISSUE_OPEN"
            : disposition.bindingState;
      await tx.platformFleetBinding.upsert({
        where: { appId: app.id },
        create: {
          appId: app.id,
          platformReleaseId: release.id,
          observedVersion,
          observedDigest,
          approvedVersion: artifact.version,
          approvedDigest: artifact.digest.toLowerCase(),
          manifestDigest: release.manifestDigest,
          contractRevision: manifest.contractRevision.toLowerCase(),
          state: bindingState,
          sourceSha: discovery.sourceSha,
          latestPlanKind: disposition.kind,
        },
        update: {
          platformReleaseId: release.id,
          observedVersion,
          observedDigest,
          approvedVersion: artifact.version,
          approvedDigest: artifact.digest.toLowerCase(),
          manifestDigest: release.manifestDigest,
          contractRevision: manifest.contractRevision.toLowerCase(),
          state: bindingState,
          sourceSha: discovery.sourceSha,
          latestPlanKind: disposition.kind,
          pullRequestNumber: sameRelease ? currentBinding?.pullRequestNumber : null,
          pullRequestUrl: sameRelease ? currentBinding?.pullRequestUrl : null,
          issueNumber: sameRelease ? currentBinding?.issueNumber : null,
          issueUrl: sameRelease ? currentBinding?.issueUrl : null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorLogin: input.actor,
          action: "control-plane.platform-fleet.plan",
          entityType: "PlatformFleetPlan",
          entityId: plan.id,
          payload: {
            requestId: input.idempotencyKey,
            appId: app.id,
            repoId: consumerInput.repoId,
            sourceSha: discovery.sourceSha,
            manifestDigest: release.manifestDigest,
            discoveryObservationId: discovery.id,
            providerObservationId: observationRow.id,
            providerPayloadHash: observationRow.payloadHash,
            kind: disposition.kind,
            status: planStatus,
          },
        },
      });
      summaries.push({ repoId: consumerInput.repoId, planId: plan.id, kind: disposition.kind, status: planStatus });
    }
    const result = { releaseId: release.id, manifestDigest: release.manifestDigest, plans: summaries };
    await tx.platformFleetReconcileRun.update({
      where: { id: reconcileRun.id },
      data: { status: "COMPLETED", result: jsonInput(result), completedAt: new Date() },
    });
    return { ...result, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const concurrent = await prisma.platformFleetReconcileRun.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (!concurrent) throw error;
    return reconcilePlatformFleet(input);
  }
}

export interface PlatformGithubIssue {
  number: number;
  url: string;
  state: "open" | "closed";
  title: string;
  body: string;
  labels: string[];
}

export interface PlatformGithubPullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  baseSha: string;
  headRepoFullName: string;
}

export interface TrustedPlatformGithubAdapter {
  ensureLabels(repoFullName: string, labels: string[]): Promise<void>;
  findIssueByMarker(repoFullName: string, marker: string): Promise<PlatformGithubIssue | null>;
  createIssue(input: { repoFullName: string; title: string; body: string; labels: string[] }): Promise<number>;
  updateIssue(input: {
    repoFullName: string;
    issueNumber: number;
    title: string;
    body: string;
    labels: string[];
    state: "open";
  }): Promise<void>;
  readIssue(repoFullName: string, issueNumber: number): Promise<PlatformGithubIssue>;
  readPullRequest(repoFullName: string, pullRequestNumber: number): Promise<PlatformGithubPullRequest>;
}

function issueLabels(labels: Array<string | { name?: string | null }>): string[] {
  return labels.flatMap((label) => typeof label === "string" ? [label] : label.name ? [label.name] : []);
}

async function trustedGithubAdapter(): Promise<TrustedPlatformGithubAdapter> {
  const { getInstallationOctokit } = await import("@/lib/github/app");
  const client = await getInstallationOctokit();
  return {
    async ensureLabels(repoFullName, labels) {
      const { owner, repo } = repoParts(repoFullName);
      const existing = new Set<string>();
      for await (const response of client.paginate.iterator(client.rest.issues.listLabelsForRepo, {
        owner,
        repo,
        per_page: 100,
      })) {
        for (const label of response.data) existing.add(label.name.toLowerCase());
      }
      for (const label of labels) {
        if (existing.has(label.toLowerCase())) continue;
        const spec = PLATFORM_ISSUE_LABELS[label as keyof typeof PLATFORM_ISSUE_LABELS];
        if (!spec) {
          throw new ControlPlaneError("허용되지 않은 Platform Issue label입니다.", 409, "PLATFORM_ISSUE_LABEL_UNMANAGED");
        }
        try {
          await client.rest.issues.createLabel({ owner, repo, name: label, ...spec });
        } catch (error) {
          try {
            await client.rest.issues.getLabel({ owner, repo, name: label });
          } catch {
            throw error;
          }
        }
        existing.add(label.toLowerCase());
      }
    },
    async findIssueByMarker(repoFullName, marker) {
      const { owner, repo } = repoParts(repoFullName);
      let matched: PlatformGithubIssue | null = null;
      for await (const response of client.paginate.iterator(client.rest.issues.listForRepo, {
        owner,
        repo,
        state: "all",
        per_page: 100,
      })) {
        const found = response.data.filter((issue) => !issue.pull_request && (issue.body ?? "").includes(marker));
        for (const issue of found) {
          if (matched) {
            throw new ControlPlaneError("동일 Platform marker의 GitHub Issue가 중복되어 있습니다.", 409, "PLATFORM_ISSUE_DUPLICATE");
          }
          matched = {
            number: issue.number,
            url: issue.html_url,
            state: issue.state as "open" | "closed",
            title: issue.title,
            body: issue.body ?? "",
            labels: issueLabels(issue.labels),
          };
        }
      }
      return matched;
    },
    async createIssue(input) {
      const { owner, repo } = repoParts(input.repoFullName);
      const response = await client.rest.issues.create({
        owner,
        repo,
        title: input.title,
        body: input.body,
        labels: input.labels,
      });
      return response.data.number;
    },
    async updateIssue(input) {
      const { owner, repo } = repoParts(input.repoFullName);
      await client.rest.issues.update({
        owner,
        repo,
        issue_number: input.issueNumber,
        title: input.title,
        body: input.body,
        labels: input.labels,
        state: input.state,
      });
    },
    async readIssue(repoFullName, issueNumber) {
      const { owner, repo } = repoParts(repoFullName);
      const response = await client.rest.issues.get({ owner, repo, issue_number: issueNumber });
      if (response.data.pull_request) throw new Error("Platform contract marker points to a pull request");
      return {
        number: response.data.number,
        url: response.data.html_url,
        state: response.data.state as "open" | "closed",
        title: response.data.title,
        body: response.data.body ?? "",
        labels: issueLabels(response.data.labels),
      };
    },
    async readPullRequest(repoFullName, pullRequestNumber) {
      const { owner, repo } = repoParts(repoFullName);
      const response = await client.rest.pulls.get({ owner, repo, pull_number: pullRequestNumber });
      return {
        number: response.data.number,
        url: response.data.html_url,
        title: response.data.title,
        body: response.data.body ?? "",
        state: response.data.state as "open" | "closed",
        merged: response.data.merged,
        baseSha: response.data.base.sha.toLowerCase(),
        headRepoFullName: response.data.head.repo?.full_name ?? "",
      };
    },
  };
}

function assertContractIssueReadback(issue: PlatformGithubIssue, task: Extract<PlatformFleetTaskInput, { kind: "PLATFORM_CONTRACT_ISSUE" }>) {
  const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
  if (
    issue.title !== task.title
    || issue.body.trim() !== task.body.trim()
    || task.labels.some((label) => !labels.has(label.toLowerCase()))
  ) {
    throw new ControlPlaneError("GitHub Issue readback이 exact contract plan과 다릅니다.", 409, "PLATFORM_ISSUE_READBACK_MISMATCH");
  }
}

type PlatformRemediationIssueTask = Extract<
  PlatformFleetTaskInput,
  { kind: "PLATFORM_INTEGRATION_REMEDIATION_ISSUE" }
>;

function remediationIssueMatches(issue: PlatformGithubIssue, task: PlatformRemediationIssueTask): boolean {
  const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
  return issue.state === "open"
    && issue.title === task.title
    && issue.body.trim() === task.body.trim()
    && task.labels.every((label) => labels.has(label.toLowerCase()));
}

function assertRemediationIssueReadback(issue: PlatformGithubIssue, task: PlatformRemediationIssueTask) {
  if (!remediationIssueMatches(issue, task)) {
    throw new ControlPlaneError(
      "GitHub Issue readback이 exact Platform remediation plan과 다릅니다.",
      409,
      "PLATFORM_REMEDIATION_ISSUE_READBACK_MISMATCH",
    );
  }
}

async function applyPlatformIssuePlan(
  planId: string,
  mode: "contract" | "remediation",
  adapter?: TrustedPlatformGithubAdapter,
) {
  const planKinds = mode === "contract"
    ? ["CONTRACT_ISSUE"] as const
    : ["CUSTOM_UNMANAGED", "MISSING_UNMANAGED"] as const;
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const claimed = await prisma.platformFleetPlan.updateMany({
    where: {
      id: planId,
      kind: { in: [...planKinds] },
      OR: [
        { status: { in: ["PENDING", "READBACK_REQUIRED"] } },
        { status: "PROCESSING", updatedAt: { lte: staleBefore } },
      ],
    },
    data: { status: "PROCESSING", attempts: { increment: 1 }, lastError: null },
  });
  if (claimed.count !== 1) return { applied: false, skipped: true };
  const plan = await prisma.platformFleetPlan.findUnique({
    where: { id: planId },
    include: { app: { select: { repoId: true, repoFullName: true } }, platformRelease: { select: { id: true } } },
  });
  if (!plan) throw new ControlPlaneError("Platform Fleet plan을 찾을 수 없습니다.", 404, "PLATFORM_PLAN_NOT_FOUND");
  const task = platformFleetTaskInputSchema.parse(plan.desired);
  if (
    (task.kind !== "PLATFORM_CONTRACT_ISSUE" && task.kind !== "PLATFORM_INTEGRATION_REMEDIATION_ISSUE")
    || (mode === "contract" && task.kind !== "PLATFORM_CONTRACT_ISSUE")
    || (mode === "remediation" && task.kind !== "PLATFORM_INTEGRATION_REMEDIATION_ISSUE")
  ) {
    throw new ControlPlaneError("Platform Issue task kind가 plan과 다릅니다.", 409, "PLATFORM_PLAN_KIND_MISMATCH");
  }
  const issueTask = task;
  const registration = plan.app.repoId
    ? await prisma.repositoryRegistration.findUnique({ where: { repoId: plan.app.repoId } })
    : null;
  if (
    !registration
    || registration.classification !== "PRODUCT_APP"
    || !repositorySourceIsCurrent(registration, plan.sourceSha)
  ) {
    await prisma.$transaction(async (tx) => {
      await tx.platformFleetPlan.updateMany({
        where: { id: plan.id, status: "PROCESSING", desiredHash: plan.desiredHash },
        data: { status: "BLOCKED", lastError: "PLATFORM_SOURCE_STALE" },
      });
      await tx.platformFleetBinding.updateMany({
        where: { appId: plan.appId, platformReleaseId: plan.platformReleaseId },
        data: { state: "PLATFORM_SOURCE_STALE" },
      });
    });
    return { applied: false, skipped: false, blocked: true, reason: "PLATFORM_SOURCE_STALE" };
  }
  try {
    const client = adapter ?? await trustedGithubAdapter();
    await client.ensureLabels(plan.app.repoFullName, [...issueTask.labels]);
    let issue = await client.findIssueByMarker(plan.app.repoFullName, issueTask.issueMarker);
    let issueNumber = issue?.number ?? null;
    if (!issue) {
      try {
        issueNumber = await client.createIssue({
          repoFullName: plan.app.repoFullName,
          title: issueTask.title,
          body: issueTask.body,
          labels: [...issueTask.labels],
        });
      } catch (error) {
        issue = await client.findIssueByMarker(plan.app.repoFullName, issueTask.issueMarker);
        if (!issue) throw error;
        issueNumber = issue.number;
      }
    }
    if (!issueNumber) throw new Error("Platform issue readback missing");
    if (
      mode === "remediation"
      && issueTask.kind === "PLATFORM_INTEGRATION_REMEDIATION_ISSUE"
      && issue
      && !remediationIssueMatches(issue, issueTask)
    ) {
      await client.updateIssue({
        repoFullName: plan.app.repoFullName,
        issueNumber,
        title: issueTask.title,
        body: issueTask.body,
        labels: [...new Set([...issue.labels, ...issueTask.labels])],
        state: "open",
      });
    }
    const readback = await client.readIssue(plan.app.repoFullName, issueNumber);
    if (issueTask.kind === "PLATFORM_CONTRACT_ISSUE") assertContractIssueReadback(readback, issueTask);
    else assertRemediationIssueReadback(readback, issueTask);
    const bindingState = mode === "contract"
      ? "CONTRACT_ISSUE_OPEN"
      : `${plan.kind}_REMEDIATION_ISSUE_OPEN`;
    const auditAction = mode === "contract"
      ? "control-plane.platform-fleet.contract-issue.readback"
      : "control-plane.platform-fleet.remediation-issue.readback";
    await prisma.$transaction(async (tx) => {
      const completed = await tx.platformFleetPlan.updateMany({
        where: {
          id: plan.id,
          status: "PROCESSING",
          desiredHash: plan.desiredHash,
          sourceSha: plan.sourceSha,
        },
        data: {
          status: "ISSUE_OPEN",
          githubNumber: readback.number,
          githubUrl: readback.url,
          readbackRequestedAt: null,
          appliedAt: new Date(),
          lastError: null,
        },
      });
      if (completed.count !== 1) throw new ControlPlaneError("Issue plan completion CAS에 실패했습니다.", 409, "PLATFORM_PLAN_CAS_FAILED");
      await tx.platformFleetBinding.updateMany({
        where: { appId: plan.appId, platformReleaseId: plan.platformReleaseId },
        data: {
          state: bindingState,
          issueNumber: readback.number,
          issueUrl: readback.url,
          latestPlanKind: plan.kind,
        },
      });
      await tx.auditLog.create({
        data: {
          actorLogin: "system:platform-fleet-github-app",
          action: auditAction,
          entityType: "PlatformFleetPlan",
          entityId: plan.id,
          payload: {
            repoFullName: plan.app.repoFullName,
            issueNumber: readback.number,
            manifestDigest: issueTask.manifestDigest,
            sourceSha: issueTask.sourceSha,
            planKind: plan.kind,
          },
        },
      });
    });
    return { applied: true, skipped: false, issueNumber: readback.number, issueUrl: readback.url };
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      await tx.platformFleetPlan.updateMany({
        where: { id: plan.id, status: "PROCESSING" },
        data: {
          status: "READBACK_REQUIRED",
          readbackRequestedAt: new Date(),
          lastError: publicError(error),
        },
      });
      await tx.platformFleetBinding.updateMany({
        where: { appId: plan.appId, platformReleaseId: plan.platformReleaseId },
        data: {
          state: mode === "contract"
            ? "ISSUE_READBACK_REQUIRED"
            : "REMEDIATION_ISSUE_READBACK_REQUIRED",
        },
      });
    });
    throw error;
  }
}

export async function applyPlatformContractIssuePlan(
  planId: string,
  adapter?: TrustedPlatformGithubAdapter,
) {
  return applyPlatformIssuePlan(planId, "contract", adapter);
}

export async function applyPlatformRemediationIssuePlan(
  planId: string,
  adapter?: TrustedPlatformGithubAdapter,
) {
  return applyPlatformIssuePlan(planId, "remediation", adapter);
}

function pullRequestNumber(outcome: Prisma.JsonValue | null): number | null {
  const parsed = agentResultSchema.safeParse(outcome);
  return parsed.success && parsed.data.outcomeCode === "PR_READY"
    ? parsed.data.pullRequestNumber ?? null
    : null;
}

export async function refreshPlatformSdkUpdatePlans(
  adapter?: TrustedPlatformGithubAdapter,
  limit = 50,
) {
  const plans = await prisma.platformFleetPlan.findMany({
    where: {
      kind: "SDK_UPDATE_PR",
      status: { in: ["QUEUED", "PROCESSING", "PR_OPEN", "PR_MERGED", "READBACK_REQUIRED", "BLOCKED"] },
      agentRunId: { not: null },
    },
    include: {
      app: { select: { repoFullName: true } },
      agentRun: { select: { status: true, outcome: true, readbackRequestedAt: true, error: true } },
    },
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, Math.min(limit, 100)),
  });
  let updated = 0;
  let client = adapter;
  for (const plan of plans) {
    const run = plan.agentRun;
    if (!run) continue;
    let status = plan.status;
    let bindingState: string | null = null;
    let number = plan.githubNumber;
    let url = plan.githubUrl;
    let error: string | null = null;
    if (run.status === "PENDING") {
      status = "QUEUED";
      bindingState = "UPDATE_PR_QUEUED";
    } else if (run.status === "RUNNING") {
      status = "PROCESSING";
      bindingState = "UPDATE_PR_PROCESSING";
    } else if (run.status === "FAILED" && run.readbackRequestedAt) {
      status = "READBACK_REQUIRED";
      bindingState = "PR_READBACK_REQUIRED";
      error = run.error;
    } else if (run.status === "DEAD_LETTER" || run.status === "CANCELLED") {
      status = "BLOCKED";
      bindingState = "UPDATE_PR_BLOCKED";
      error = run.error;
    } else if (run.status === "SUCCEEDED") {
      const prNumber = pullRequestNumber(run.outcome);
      if (!prNumber) {
        status = "BLOCKED";
        bindingState = "UPDATE_PR_RESULT_INVALID";
        error = "PLATFORM_PR_RESULT_INVALID";
      } else {
        try {
          client ??= await trustedGithubAdapter();
          const task = platformFleetTaskInputSchema.parse(plan.desired);
          if (task.kind !== "PLATFORM_SDK_UPDATE") throw new Error("Platform SDK task mismatch");
          const readback = await client.readPullRequest(plan.app.repoFullName, prNumber);
          if (
            !readback.body.includes(task.pullRequestMarker)
            || readback.baseSha !== plan.sourceSha.toLowerCase()
            || readback.headRepoFullName.toLowerCase() !== plan.app.repoFullName.toLowerCase()
          ) {
            throw new ControlPlaneError("PR readback이 exact Platform plan과 다릅니다.", 409, "PLATFORM_PR_READBACK_MISMATCH");
          }
          number = readback.number;
          url = readback.url;
          if (readback.merged) {
            status = "PR_MERGED";
            bindingState = "PLATFORM_OBSERVATION_PENDING";
          } else if (readback.state === "open") {
            status = "PR_OPEN";
            bindingState = "UPDATE_PR_OPEN";
          } else {
            status = "BLOCKED";
            bindingState = "UPDATE_PR_CLOSED_UNMERGED";
            error = "PLATFORM_PR_CLOSED_UNMERGED";
          }
        } catch (readbackError) {
          status = "READBACK_REQUIRED";
          bindingState = "PR_READBACK_REQUIRED";
          error = publicError(readbackError);
        }
      }
    }
    const changed = await prisma.$transaction(async (tx) => {
      const planChanged = await tx.platformFleetPlan.updateMany({
        where: { id: plan.id, updatedAt: plan.updatedAt },
        data: {
          status,
          githubNumber: number,
          githubUrl: url,
          lastError: error ? publicError(error) : null,
          readbackRequestedAt: status === "READBACK_REQUIRED" ? new Date() : null,
          ...(status === "PR_OPEN" || status === "PR_MERGED" ? { appliedAt: new Date() } : {}),
        },
      });
      if (planChanged.count !== 1) return false;
      if (bindingState) {
        await tx.platformFleetBinding.updateMany({
          where: { appId: plan.appId, platformReleaseId: plan.platformReleaseId },
          data: {
            state: bindingState,
            pullRequestNumber: number,
            pullRequestUrl: url,
            latestPlanKind: "SDK_UPDATE_PR",
          },
        });
      }
      return true;
    });
    if (changed) updated += 1;
  }
  return { scanned: plans.length, updated };
}

export async function drainPlatformFleetPlans(limit = 20) {
  const refresh = await refreshPlatformSdkUpdatePlans(undefined, limit);
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const issuePlans = await prisma.platformFleetPlan.findMany({
    where: {
      kind: { in: ["CONTRACT_ISSUE", "CUSTOM_UNMANAGED", "MISSING_UNMANAGED"] },
      OR: [
        { status: { in: ["PENDING", "READBACK_REQUIRED"] } },
        { status: "PROCESSING", updatedAt: { lte: staleBefore } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, Math.min(limit, 100)),
    select: { id: true, kind: true },
  });
  let applied = 0;
  let failed = 0;
  const adapter = issuePlans.length > 0 ? await trustedGithubAdapter() : undefined;
  for (const plan of issuePlans) {
    try {
      const result = plan.kind === "CONTRACT_ISSUE"
        ? await applyPlatformContractIssuePlan(plan.id, adapter)
        : await applyPlatformRemediationIssuePlan(plan.id, adapter);
      if (result.applied) applied += 1;
    } catch {
      failed += 1;
    }
  }
  return { refresh, issues: { scanned: issuePlans.length, applied, failed } };
}
