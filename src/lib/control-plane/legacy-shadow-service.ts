import { Prisma } from "@prisma/client";

import { createDraftRevisionInTransaction } from "@/lib/control-plane/config-revision-store";
import { latestDiscoveryObservationOrder } from "@/lib/control-plane/discovery-order";
import {
  compareLegacyShadow,
  transformLegacySources,
  type LegacyShadowParity,
  type LegacyTransformResult,
} from "@/lib/control-plane/legacy-shadow";
import {
  applyLegacyConfigResolution,
  legacyResolutionReasonCodes,
  legacyResolutionReasonCodesDigest,
} from "@/lib/control-plane/legacy-config-resolution";
import { findApplicableLegacyConfigResolution } from "@/lib/control-plane/legacy-config-resolution-service";
import {
  LEGACY_SOURCE_DEFINITIONS,
  LEGACY_TRANSFORM_VERSION,
  type LegacySourceInput,
  type LegacySourceKind,
} from "@/lib/control-plane/legacy-sources";
import {
  hashLegacyShadowIdempotencyKey,
  legacyShadowRequestHash,
} from "@/lib/control-plane/legacy-shadow-request";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  assertConfigRevisionPayload,
  assertIdempotentRequestHash,
  ControlPlaneError,
} from "@/lib/control-plane/service";
import type { Octokit } from "@/lib/github/app";
import {
  readExactSourceFile,
  toSourceMetadata,
  type SourceObservationResult,
  type SourcePersistenceMetadata,
} from "@/lib/github/source-observation";
import { prisma } from "@/lib/prisma";

const PLATFORM_REPOSITORY = "platform";
const FULL_PARITY_SCOPE = "FULL";
const SHA_40 = /^[0-9a-f]{40}$/i;

export type LegacyConfigImportStatus =
  | "DRAFT_CREATED"
  | "DRAFT_CREATED_WITH_INPUT"
  | "NEEDS_INPUT"
  | "RESOLUTION_REUSED";

export function planLegacyConfigImportPersistence(input: {
  transformStatus: LegacyTransformResult["status"];
  resolutionParityStatus: LegacyShadowParity["status"] | null;
}): { createDraft: boolean; status: LegacyConfigImportStatus } {
  if (input.resolutionParityStatus === "MATCH" && input.transformStatus !== "DRAFTABLE") {
    return { createDraft: false, status: "RESOLUTION_REUSED" };
  }
  if (input.transformStatus === "DRAFTABLE") {
    return { createDraft: true, status: "DRAFT_CREATED" };
  }
  if (input.transformStatus === "DRAFTABLE_WITH_INPUT") {
    return { createDraft: true, status: "DRAFT_CREATED_WITH_INPUT" };
  }
  return { createDraft: false, status: "NEEDS_INPUT" };
}

export function legacyConfigResolutionObservationBinding(input: {
  resolutionParityStatus: LegacyShadowParity["status"] | null;
  applicableResolution: {
    resolution: { id: string } | null;
    centralStateDigest: string;
  } | null;
}): { legacyConfigResolutionId: string | null; centralStateDigest: string | null } {
  const resolution = input.resolutionParityStatus === "MATCH"
    ? input.applicableResolution?.resolution ?? null
    : null;
  return {
    legacyConfigResolutionId: resolution?.id ?? null,
    centralStateDigest: resolution && input.applicableResolution
      ? input.applicableResolution.centralStateDigest
      : null,
  };
}

type PlatformSourceVector = {
  repoId: bigint;
  repoFullName: string;
  sourceSha: string;
};

type PlatformRegistrationVector = {
  repoId: bigint;
  repoFullName: string;
  status: "REGISTERED" | "NEEDS_INPUT" | "MANAGED" | "ARCHIVED";
  archived: boolean;
  managementKind: "UNCLASSIFIED" | "APP" | "PLATFORM_PRODUCER" | null;
  classification: "PRODUCT_APP" | "INFRA_REPO" | "PLATFORM_PRODUCER" | "EXCLUDED" | null;
  lastDefaultPushSha: string | null;
  lastReconciledSha: string | null;
};

type AppImportTarget = {
  id: string;
  slug: string;
  repoId: bigint;
  repoFullName: string;
  platformSource: PlatformSourceVector | null;
};

function configuredPlatformRepository(input: {
  organization: string;
  repositoryIdText: string;
}): { repoId: bigint; repoFullName: string } | null {
  if (!/^\d+$/.test(input.repositoryIdText)) return null;
  const repoId = BigInt(input.repositoryIdText);
  if (repoId <= 0n || repoId > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    repoId,
    repoFullName: `${input.organization}/${PLATFORM_REPOSITORY}`,
  };
}

export function resolveLegacyPlatformSourceVector(input: {
  configured: { repoId: bigint; repoFullName: string } | null;
  bindingSourceSha: string | null;
  registration: PlatformRegistrationVector | null;
}): PlatformSourceVector | null {
  if (!input.configured) return null;
  if (input.bindingSourceSha !== null) {
    if (!SHA_40.test(input.bindingSourceSha)) return null;
    return {
      ...input.configured,
      sourceSha: input.bindingSourceSha.toLowerCase(),
    };
  }
  const registration = input.registration;
  if (
    !registration
    || registration.repoId !== input.configured.repoId
    || registration.repoFullName.toLowerCase() !== input.configured.repoFullName.toLowerCase()
    || registration.status !== "MANAGED"
    || registration.archived
    || (
      registration.classification !== "PLATFORM_PRODUCER"
      && !(registration.classification === null && registration.managementKind === "PLATFORM_PRODUCER")
    )
    || !registration.lastDefaultPushSha
    || !registration.lastReconciledSha
    || registration.lastDefaultPushSha.toLowerCase() !== registration.lastReconciledSha.toLowerCase()
    || !SHA_40.test(registration.lastReconciledSha)
  ) return null;
  return {
    ...input.configured,
    sourceSha: registration.lastReconciledSha.toLowerCase(),
  };
}

type PersistableSource = {
  sourceKind: LegacySourceKind;
  repoId: bigint | null;
  repoFullName: string;
  sourceSha: string | null;
  sourceRef: string | null;
  path: string;
  blobSha: string | null;
  contentSha256: string | null;
  status: string;
  errorCode: string | null;
};

type CollectedLegacySources = {
  appSourceRef: string;
  transformInputs: LegacySourceInput[];
  persisted: PersistableSource[];
};

export type LegacyShadowServiceDependencies = {
  client: typeof prisma;
  getOctokit: () => Promise<Octokit>;
  now: () => Date;
};

const defaultDependencies: LegacyShadowServiceDependencies = {
  client: prisma,
  getOctokit: async () => {
    const { getInstallationOctokit } = await import("@/lib/github/app");
    return getInstallationOctokit();
  },
  now: () => new Date(),
};

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function githubStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function repositoryParts(fullName: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = fullName.split("/");
  if (
    !owner
    || !repo
    || rest.length > 0
    || !/^[A-Za-z0-9_.-]+$/.test(owner)
    || !/^[A-Za-z0-9_.-]+$/.test(repo)
  ) {
    throw new ControlPlaneError("등록된 repository identity가 올바르지 않습니다.", 409, "REPOSITORY_IDENTITY_INVALID");
  }
  return { owner, repo };
}

function transformInput(
  sourceKind: LegacySourceKind,
  observation: SourceObservationResult,
): LegacySourceInput {
  return {
    sourceKind,
    repository: observation.fullName,
    sourceSha: observation.sourceSha,
    path: observation.path,
    status: observation.status === "PRESENT"
      ? "PRESENT"
      : observation.status === "ABSENT"
        ? "ABSENT"
        : "UNREADABLE",
    ...(observation.status === "PRESENT" ? { text: observation.text } : {}),
  };
}

function persistableSource(
  sourceKind: LegacySourceKind,
  metadata: SourcePersistenceMetadata,
): PersistableSource {
  return {
    sourceKind,
    repoId: BigInt(metadata.repoId),
    repoFullName: metadata.fullName,
    sourceSha: metadata.sourceSha,
    sourceRef: metadata.sourceRef,
    path: metadata.path,
    blobSha: metadata.blobSha,
    contentSha256: metadata.contentSha256,
    status: metadata.status,
    errorCode: metadata.reason,
  };
}

function unavailablePlatformSource(input: {
  repoFullName: string;
  repoId?: number | null;
  sourceSha: string | null;
  path: string;
  status: "ACCESS_DENIED" | "IDENTITY_MISMATCH";
  errorCode: string;
}): { transform: LegacySourceInput; persisted: PersistableSource } {
  return {
    transform: {
      sourceKind: "PLATFORM_APP_REGISTRY",
      repository: input.repoFullName,
      sourceSha: input.sourceSha ?? "",
      path: input.path,
      status: "UNREADABLE",
    },
    persisted: {
      sourceKind: "PLATFORM_APP_REGISTRY",
      repoId: input.repoId ? BigInt(input.repoId) : null,
      repoFullName: input.repoFullName,
      sourceSha: input.sourceSha,
      sourceRef: null,
      path: input.path,
      blobSha: null,
      contentSha256: null,
      status: input.status,
      errorCode: input.errorCode,
    },
  };
}

async function collectPlatformSource(
  octokit: Octokit,
  app: AppImportTarget,
): Promise<{ transform: LegacySourceInput; persisted: PersistableSource }> {
  const org = process.env.GITHUB_ORG ?? "seorilabs";
  const repoFullName = `${org}/${PLATFORM_REPOSITORY}`;
  const path = `registry/apps/${app.slug}.json`;
  const sourceSha = app.platformSource?.sourceSha ?? null;
  if (!sourceSha) {
    return unavailablePlatformSource({
      repoFullName,
      sourceSha: null,
      path,
      status: "IDENTITY_MISMATCH",
      errorCode: "PLATFORM_SOURCE_SHA_MISSING",
    });
  }
  const expectedRepoId = Number(app.platformSource?.repoId ?? 0n);
  if (!Number.isSafeInteger(expectedRepoId) || expectedRepoId <= 0) {
    return unavailablePlatformSource({
      repoFullName,
      sourceSha,
      path,
      status: "IDENTITY_MISMATCH",
      errorCode: "PLATFORM_REPOSITORY_ID_NOT_CONFIGURED",
    });
  }
  if (app.platformSource?.repoFullName.toLowerCase() !== repoFullName.toLowerCase()) {
    return unavailablePlatformSource({
      repoFullName,
      repoId: expectedRepoId,
      sourceSha,
      path,
      status: "IDENTITY_MISMATCH",
      errorCode: "PLATFORM_REPOSITORY_IDENTITY_INVALID",
    });
  }

  let identity: { id: number; full_name: string };
  try {
    const response = await octokit.rest.repos.get({ owner: org, repo: PLATFORM_REPOSITORY });
    const data = response.data as { id?: unknown; full_name?: unknown };
    if (
      !Number.isSafeInteger(data.id)
      || data.id !== expectedRepoId
      || typeof data.full_name !== "string"
      || data.full_name.toLowerCase() !== repoFullName.toLowerCase()
    ) {
      return unavailablePlatformSource({
        repoFullName,
        sourceSha,
        path,
        status: "IDENTITY_MISMATCH",
        errorCode: "PLATFORM_REPOSITORY_IDENTITY_INVALID",
      });
    }
    identity = { id: data.id as number, full_name: data.full_name };
  } catch (error) {
    const status = githubStatus(error);
    if (status === 401 || status === 403 || status === 404) {
      return unavailablePlatformSource({
        repoFullName,
        sourceSha,
        path,
        status: "ACCESS_DENIED",
        errorCode: "PLATFORM_REPOSITORY_IDENTITY_UNAVAILABLE",
      });
    }
    throw error;
  }

  const observation = await readExactSourceFile(octokit, {
    repoId: identity.id,
    fullName: identity.full_name,
    sourceSha,
    path,
    allowedPaths: [path],
  });
  return {
    transform: transformInput("PLATFORM_APP_REGISTRY", observation),
    persisted: persistableSource("PLATFORM_APP_REGISTRY", toSourceMetadata(observation)),
  };
}

async function collectLegacySources(
  octokit: Octokit,
  app: AppImportTarget,
  sourceSha: string,
): Promise<CollectedLegacySources> {
  const appDefinitions = LEGACY_SOURCE_DEFINITIONS.filter((source) => source.repositoryScope === "APP");
  const allowedPaths = appDefinitions.map((source) => source.pathPattern);
  const appRepository = repositoryParts(app.repoFullName);
  const repositoryResponse = await octokit.rest.repos.get(appRepository);
  const repository = repositoryResponse.data as {
    id?: unknown;
    full_name?: unknown;
    default_branch?: unknown;
  };
  if (
    repository.id !== Number(app.repoId)
    || typeof repository.full_name !== "string"
    || repository.full_name.toLowerCase() !== app.repoFullName.toLowerCase()
    || typeof repository.default_branch !== "string"
    || repository.default_branch.length === 0
    || repository.default_branch.length > 244
    || /[\u0000-\u001f\u007f]/.test(repository.default_branch)
  ) {
    throw new ControlPlaneError(
      "GitHub default branch identity를 검증하지 못했습니다.",
      409,
      "REPOSITORY_IDENTITY_INVALID",
    );
  }
  const appSourceRef = `refs/heads/${repository.default_branch}`;
  const head = await octokit.rest.repos.getCommit({
    ...appRepository,
    ref: repository.default_branch,
  });
  if (
    typeof head.data.sha !== "string"
    || head.data.sha.toLowerCase() !== sourceSha.toLowerCase()
  ) {
    throw new ControlPlaneError(
      "현재 GitHub default branch HEAD와 일치하는 source SHA만 shadow import할 수 있습니다.",
      409,
      "SOURCE_SHA_NOT_DEFAULT_HEAD",
    );
  }

  const appObservations = await Promise.all(appDefinitions.map(async (definition) => {
    const observation = await readExactSourceFile(octokit, {
      repoId: app.repoId,
      fullName: app.repoFullName,
      sourceSha,
      sourceRef: appSourceRef,
      path: definition.pathPattern,
      allowedPaths,
    });
    return { definition, observation };
  }));
  const platform = await collectPlatformSource(octokit, app);
  const repositoryAfterReadResponse = await octokit.rest.repos.get(appRepository);
  const repositoryAfterRead = repositoryAfterReadResponse.data as {
    id?: unknown;
    full_name?: unknown;
    default_branch?: unknown;
  };
  if (
    repositoryAfterRead.id !== Number(app.repoId)
    || typeof repositoryAfterRead.full_name !== "string"
    || repositoryAfterRead.full_name.toLowerCase() !== app.repoFullName.toLowerCase()
    || repositoryAfterRead.default_branch !== repository.default_branch
  ) {
    throw new ControlPlaneError(
      "legacy source를 읽는 동안 GitHub default branch identity가 변경되었습니다.",
      409,
      "SOURCE_REF_CHANGED_DURING_READ",
    );
  }
  const headAfterRead = await octokit.rest.repos.getCommit({
    ...appRepository,
    ref: repositoryAfterRead.default_branch,
  });
  if (
    typeof headAfterRead.data.sha !== "string"
    || headAfterRead.data.sha.toLowerCase() !== sourceSha.toLowerCase()
  ) {
    throw new ControlPlaneError(
      "legacy source를 읽는 동안 GitHub default branch HEAD가 변경되었습니다.",
      409,
      "SOURCE_SHA_CHANGED_DURING_READ",
    );
  }

  return {
    appSourceRef,
    transformInputs: [
      ...appObservations.map(({ definition, observation }) => transformInput(definition.sourceKind, observation)),
      platform.transform,
    ],
    persisted: [
      ...appObservations.map(({ definition, observation }) => (
        persistableSource(definition.sourceKind, toSourceMetadata(observation))
      )),
      platform.persisted,
    ],
  };
}

function persistedDiff(
  transform: LegacyTransformResult,
  parity: LegacyShadowParity,
): Array<{ path: string; code: string }> {
  const items = new Map<string, { path: string; code: string }>();
  for (const diff of parity.diffs) {
    const key = `${diff.path}\u0000${diff.code}`;
    items.set(key, diff);
  }
  if (transform.status !== "DRAFTABLE") {
    // Legacy 문서의 임의 key는 path를 통해 비밀을 유출할 수 있어 저장하지 않는다.
    for (const reason of transform.reasons) {
      const item = { path: "$", code: reason.code };
      items.set(`${item.path}\u0000${item.code}`, item);
    }
  }
  return [...items.values()]
    .sort((left, right) => `${left.path}:${left.code}`.localeCompare(`${right.path}:${right.code}`))
    .slice(0, 100);
}

function persistedInputDigest(
  transform: LegacyTransformResult,
  sources: readonly PersistableSource[],
): string {
  if (transform.status === "DRAFTABLE") return transform.inputDigest;
  // 차단된 원문에는 낮은 엔트로피 secret이 있을 수 있다. raw text/blob/content
  // hash를 durable verifier로 남기지 않고 immutable commit/path와 reason만 묶는다.
  return jsonDigest({
    scope: "legacy-shadow-needs-input",
    transformVersion: LEGACY_TRANSFORM_VERSION,
    sources: sources.map((source) => ({
      sourceKind: source.sourceKind,
      repoId: source.repoId?.toString() ?? null,
      repoFullName: source.repoFullName,
      sourceSha: source.sourceSha,
      sourceRef: source.sourceRef,
      path: source.path,
      status: source.status,
      errorCode: source.errorCode,
    })).sort((left, right) => (
      `${left.sourceKind}:${left.repoFullName}:${left.path}`
        .localeCompare(`${right.sourceKind}:${right.repoFullName}:${right.path}`)
    )),
    reasonCodes: [...new Set(transform.reasons.map((reason) => reason.code))].sort(),
  } as JsonValue);
}

function importSelect() {
  return {
    id: true,
    appId: true,
    sourceSha: true,
    sourceRef: true,
    transformVersion: true,
    requestHash: true,
    inputDigest: true,
    reasonCodes: true,
    reasonCodesDigest: true,
    status: true,
    configRevisionId: true,
    observedBy: true,
    observedAt: true,
    createdAt: true,
    configRevision: { select: { id: true, revision: true, status: true, payloadHash: true } },
    sources: {
      orderBy: [{ sourceKind: "asc" as const }, { pathHash: "asc" as const }],
      select: {
        id: true,
        repoId: true,
        repoFullName: true,
        sourceSha: true,
        sourceRef: true,
        sourceKind: true,
        path: true,
        blobSha: true,
        contentSha256: true,
        status: true,
        transformVersion: true,
        parsedPayloadHash: true,
        errorCode: true,
        observedAt: true,
      },
    },
    parityObservations: {
      orderBy: [
        { observedAt: "desc" as const },
        { createdAt: "desc" as const },
        { id: "desc" as const },
      ],
      take: 1,
      select: {
        id: true,
        configRevisionId: true,
        sourceSha: true,
        scope: true,
        contractVersion: true,
        status: true,
        legacyDigest: true,
        centralDigest: true,
        diff: true,
        legacyConfigResolutionId: true,
        observedBy: true,
        observedAt: true,
      },
    },
  };
}

async function replayForKey(
  client: typeof prisma,
  idempotencyKey: string,
  requestHash: string,
) {
  const replay = await client.legacyConfigImport.findUnique({
    where: { idempotencyKey },
    select: importSelect(),
  });
  if (!replay) return null;
  assertIdempotentRequestHash(replay.requestHash, requestHash);
  return replay;
}

function publicImport(value: Prisma.LegacyConfigImportGetPayload<{
  select: ReturnType<typeof importSelect>;
}>) {
  const { requestHash, sources, ...safeValue } = value;
  void requestHash;
  return {
    ...safeValue,
    sources: sources.map((source) => ({
      ...source,
      repoId: source.repoId?.toString() ?? null,
    })),
  };
}

export async function recordLegacyShadowImport(input: {
  repoId: bigint;
  sourceSha: string;
  observedBy: string;
  idempotencyKey: string;
}, dependencies: LegacyShadowServiceDependencies = defaultDependencies) {
  const client = dependencies.client;
  const sourceSha = input.sourceSha.toLowerCase();
  const organization = process.env.GITHUB_ORG ?? "seorilabs";
  const configuredPlatform = configuredPlatformRepository({
    organization,
    repositoryIdText: process.env.PLATFORM_GITHUB_REPOSITORY_ID?.trim() ?? "",
  });
  const [app, platformRegistration] = await Promise.all([
    client.app.findUnique({
      where: { repoId: input.repoId },
      select: {
        id: true,
        slug: true,
        repoId: true,
        repoFullName: true,
        platformFleetBinding: { select: { sourceSha: true } },
        discoveryObservations: {
          orderBy: latestDiscoveryObservationOrder(),
          take: 1,
          select: { id: true, sourceSha: true },
        },
      },
    }),
    configuredPlatform
      ? client.repositoryRegistration.findUnique({
          where: { repoId: configuredPlatform.repoId },
          select: {
            repoId: true,
            repoFullName: true,
            status: true,
            archived: true,
            managementKind: true,
            classification: true,
            lastDefaultPushSha: true,
            lastReconciledSha: true,
          },
        })
      : Promise.resolve(null),
  ]);
  if (!app || !app.repoId) {
    throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
  }
  const platformSource = resolveLegacyPlatformSourceVector({
    configured: configuredPlatform,
    bindingSourceSha: app.platformFleetBinding?.sourceSha ?? null,
    registration: platformRegistration,
  });
  const importTarget: AppImportTarget = {
    id: app.id,
    slug: app.slug,
    repoId: app.repoId,
    repoFullName: app.repoFullName,
    platformSource,
  };
  const requestHash = legacyShadowRequestHash({
    repoId: input.repoId,
    sourceSha,
    observedBy: input.observedBy,
  });
  const storedIdempotencyKey = hashLegacyShadowIdempotencyKey(input.idempotencyKey);
  const replay = await replayForKey(client, storedIdempotencyKey, requestHash);
  if (replay) {
    const result = publicImport(replay);
    return {
      import: result,
      configRevision: result.configRevision,
      parity: result.parityObservations[0] ?? null,
      sourceCount: result.sources.length,
      duplicate: true,
    };
  }
  const latestDiscovery = app.discoveryObservations[0];
  if (!latestDiscovery || latestDiscovery.sourceSha.toLowerCase() !== sourceSha) {
    throw new ControlPlaneError(
      "가장 최근 DiscoveryObservation과 일치하는 source SHA만 shadow import할 수 있습니다.",
      409,
      "SOURCE_SHA_NOT_CURRENT",
    );
  }

  let collected: CollectedLegacySources;
  try {
    const octokit = await dependencies.getOctokit();
    collected = await collectLegacySources(octokit, importTarget, sourceSha);
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    // Octokit 오류 객체에는 request header가 붙을 수 있으므로 상위 HTTP logger로 넘기지 않는다.
    throw new ControlPlaneError(
      "GitHub exact-SHA source를 안전하게 관측하지 못했습니다.",
      503,
      "SOURCE_READ_UNAVAILABLE",
    );
  }
  const transformed = transformLegacySources(collected.transformInputs);
  const inputDigest = persistedInputDigest(transformed, collected.persisted);
  const reasonCodes = legacyResolutionReasonCodes(transformed);
  const reasonCodesDigest = legacyResolutionReasonCodesDigest(reasonCodes);
  const observedAt = dependencies.now();

  try {
    const created = await client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM app WHERE id = ${app.id} FOR UPDATE`;
      const lockedApp = await tx.app.findUniqueOrThrow({
        where: { id: app.id },
        select: {
          slug: true,
          repoId: true,
          repoFullName: true,
          platformFleetBinding: { select: { sourceSha: true } },
          discoveryObservations: {
            orderBy: latestDiscoveryObservationOrder(),
            take: 1,
            select: { id: true, sourceSha: true },
          },
        },
      });
      let lockedPlatformRegistration: PlatformRegistrationVector | null = null;
      if (configuredPlatform) {
        await tx.$queryRaw`SELECT repoId FROM repository_registration WHERE repoId = ${configuredPlatform.repoId} FOR UPDATE`;
        lockedPlatformRegistration = await tx.repositoryRegistration.findUnique({
          where: { repoId: configuredPlatform.repoId },
          select: {
            repoId: true,
            repoFullName: true,
            status: true,
            archived: true,
            managementKind: true,
            classification: true,
            lastDefaultPushSha: true,
            lastReconciledSha: true,
          },
        });
      }
      const lockedPlatformSource = resolveLegacyPlatformSourceVector({
        configured: configuredPlatform,
        bindingSourceSha: lockedApp.platformFleetBinding?.sourceSha ?? null,
        registration: lockedPlatformRegistration,
      });
      if (
        lockedApp.repoId !== input.repoId
        || lockedApp.slug !== app.slug
        || lockedApp.repoFullName.toLowerCase() !== app.repoFullName.toLowerCase()
        || lockedPlatformSource?.repoId !== platformSource?.repoId
        || lockedPlatformSource?.repoFullName.toLowerCase() !== platformSource?.repoFullName.toLowerCase()
        || lockedPlatformSource?.sourceSha !== platformSource?.sourceSha
        || lockedApp.discoveryObservations[0]?.id !== latestDiscovery.id
        || lockedApp.discoveryObservations[0]?.sourceSha.toLowerCase() !== sourceSha
      ) {
        throw new ControlPlaneError(
          "source vector를 읽는 동안 앱 identity 또는 Platform binding이 변경되었습니다.",
          409,
          "SOURCE_VECTOR_CHANGED",
        );
      }
      const afterLockReplay = await tx.legacyConfigImport.findUnique({
        where: { idempotencyKey: storedIdempotencyKey },
        select: importSelect(),
      });
      if (afterLockReplay) {
        assertIdempotentRequestHash(afterLockReplay.requestHash, requestHash);
        return { replay: afterLockReplay, created: null };
      }

      const active = await tx.configRevision.findFirst({
        where: { appId: app.id, status: "ACTIVE" },
        orderBy: { revision: "desc" },
        select: { id: true, payload: true, payloadHash: true },
      });
      const applicableResolution = active && transformed.status !== "DRAFTABLE"
        ? await findApplicableLegacyConfigResolution(tx, {
            appId: app.id,
            sourceSha,
            transformVersion: LEGACY_TRANSFORM_VERSION,
            inputDigest,
            reasonCodesDigest,
            configRevisionId: active.id,
          })
        : null;
      // 기존 resolution row의 존재만으로 재사용을 선언하지 않는다. 현재 ACTIVE의
      // representable subset까지 실제 MATCH한 경우에만 resolution을 재사용한다.
      const resolutionParity = applicableResolution
        ? applyLegacyConfigResolution({
            transform: transformed,
            persistedInputDigest: inputDigest,
            sourceSha,
            configRevisionId: active!.id,
            centralPayload: active!.payload,
            centralStateDigest: applicableResolution.centralStateDigest,
            resolution: applicableResolution.resolution,
          })
        : null;
      const resolutionBinding = legacyConfigResolutionObservationBinding({
        resolutionParityStatus: resolutionParity?.status ?? null,
        applicableResolution,
      });
      const parity = resolutionParity
        ?? compareLegacyShadow(transformed, active?.payload ?? null);
      const persistencePlan = planLegacyConfigImportPersistence({
        transformStatus: transformed.status,
        resolutionParityStatus: resolutionParity?.status ?? null,
      });
      let draft = null;
      if (persistencePlan.createDraft) {
        assertConfigRevisionPayload(transformed.payload);
        draft = await createDraftRevisionInTransaction(tx, {
          appId: app.id,
          payload: transformed.payload,
          payloadHash: transformed.payloadDigest,
          createdBy: `${input.observedBy}:legacy-shadow`,
          idempotencyKey: `legacy-shadow-draft:${storedIdempotencyKey}`,
        });
      }

      const legacyImport = await tx.legacyConfigImport.create({
        data: {
          appId: app.id,
          sourceSha,
          sourceRef: collected.appSourceRef,
          transformVersion: LEGACY_TRANSFORM_VERSION,
          requestHash,
          inputDigest,
          reasonCodes: jsonInput(reasonCodes),
          reasonCodesDigest,
          status: persistencePlan.status,
          idempotencyKey: storedIdempotencyKey,
          configRevisionId: draft?.id,
          observedBy: input.observedBy,
          observedAt,
        },
      });

      await tx.legacyConfigSource.createMany({
        data: collected.persisted.map((source) => ({
          importId: legacyImport.id,
          repoId: source.repoId,
          repoFullName: source.repoFullName,
          sourceSha: source.sourceSha,
          sourceRef: source.sourceRef,
          sourceKind: source.sourceKind,
          path: source.path,
          pathHash: jsonDigest({
            repoId: source.repoId?.toString() ?? null,
            sourceSha: source.sourceSha,
            sourceKind: source.sourceKind,
            path: source.path,
          } as JsonValue),
          // 검토 대기 partition에 credential 후보가 있을 수 있으므로 source
          // fingerprint도 완전 DRAFTABLE일 때만 보존한다.
          blobSha: transformed.status === "DRAFTABLE" ? source.blobSha : null,
          contentSha256: transformed.status === "DRAFTABLE" ? source.contentSha256 : null,
          status: source.status,
          transformVersion: LEGACY_TRANSFORM_VERSION,
          parsedPayloadHash: null,
          errorCode: source.errorCode,
          observedAt,
        })),
      });

      // Import가 생성한 DRAFT 자체와 비교하면 tautological MATCH가 되므로 금지한다.
      // 검토가 필요한 source는 exact source/input/reason/ACTIVE 중앙 상태에 묶인
      // append-only resolution이 있을 때만 MATCH로 승격한다.
      const diff = persistedDiff(transformed, parity);
      const dedupeKey = jsonDigest({
        appId: app.id,
        legacyImportId: legacyImport.id,
        sourceSha,
        inputDigest,
        transformVersion: LEGACY_TRANSFORM_VERSION,
        scope: FULL_PARITY_SCOPE,
        centralConfigRevisionId: active?.id ?? null,
        centralPayloadHash: active?.payloadHash ?? null,
        legacyConfigResolutionId: resolutionBinding.legacyConfigResolutionId,
        centralStateDigest: resolutionBinding.centralStateDigest,
      } as JsonValue);
      const parityObservation = await tx.shadowParityObservation.create({
        data: {
          appId: app.id,
          legacyImportId: legacyImport.id,
          configRevisionId: active?.id,
          legacyConfigResolutionId: resolutionBinding.legacyConfigResolutionId ?? undefined,
          sourceSha,
          scope: FULL_PARITY_SCOPE,
          contractVersion: LEGACY_TRANSFORM_VERSION,
          status: parity.status,
          legacyDigest: parity.legacyDigest,
          centralDigest: parity.centralDigest,
          diff: jsonInput(diff),
          dedupeKey,
          observedBy: input.observedBy,
          observedAt,
        },
      });
      await tx.auditLog.create({
        data: {
          actorLogin: input.observedBy,
          action: "control-plane.legacy-shadow.record",
          entityType: "LegacyConfigImport",
          entityId: legacyImport.id,
          payload: {
            appId: app.id,
            sourceSha,
            discoveryObservationId: latestDiscovery.id,
            transformVersion: LEGACY_TRANSFORM_VERSION,
            inputDigest,
            importStatus: legacyImport.status,
            configRevisionId: draft?.id ?? null,
            parityStatus: parity.status,
            parityObservationId: parityObservation.id,
            sourceCount: collected.persisted.length,
            sourceStatuses: collected.persisted.map((source) => ({
              sourceKind: source.sourceKind,
              status: source.status,
              errorCode: source.errorCode,
            })),
            reasonCodes: transformed.status !== "DRAFTABLE"
              ? [...new Set(transformed.reasons.map((reason) => reason.code))].sort()
              : [],
            reasonCodesDigest,
            legacyConfigResolutionId: resolutionBinding.legacyConfigResolutionId,
          },
        },
      });

      const result = await tx.legacyConfigImport.findUniqueOrThrow({
        where: { id: legacyImport.id },
        select: importSelect(),
      });
      return { replay: null, created: result };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    const result = publicImport(created.replay ?? created.created!);
    return {
      import: result,
      configRevision: result.configRevision,
      parity: result.parityObservations[0] ?? null,
      sourceCount: result.sources.length,
      duplicate: Boolean(created.replay),
    };
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "P2002") {
      const replayAfterRace = await replayForKey(client, storedIdempotencyKey, requestHash);
      if (replayAfterRace) {
        const result = publicImport(replayAfterRace);
        return {
          import: result,
          configRevision: result.configRevision,
          parity: result.parityObservations[0] ?? null,
          sourceCount: result.sources.length,
          duplicate: true,
        };
      }
    }
    throw error;
  }
}

export async function listLegacyShadowImports(input: {
  repoId: bigint;
  sourceSha?: string;
}) {
  const app = await prisma.app.findUnique({
    where: { repoId: input.repoId },
    select: { id: true },
  });
  if (!app) throw new ControlPlaneError("관리 대상 앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
  const imports = await prisma.legacyConfigImport.findMany({
    where: {
      appId: app.id,
      ...(input.sourceSha ? { sourceSha: input.sourceSha.toLowerCase() } : {}),
    },
    orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: importSelect(),
  });
  return { imports: imports.map(publicImport) };
}
