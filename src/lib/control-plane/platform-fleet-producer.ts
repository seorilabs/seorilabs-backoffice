import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";

import {
  platformCanaryEvidenceSchema,
  platformConsumerObservationPayloadSchema,
  platformReleaseManifestSchema,
  type PlatformConsumerObservationPayload,
  type PlatformReleaseManifest,
} from "@/lib/control-plane/contracts";
import { latestDiscoveryObservationOrder } from "@/lib/control-plane/discovery-order";
import { canonicalJson, jsonDigest, signSnapshot, type JsonValue } from "@/lib/control-plane/json";
import { recordPlatformRelease, reconcilePlatformFleet } from "@/lib/control-plane/platform-fleet";
import { repositorySourceIsCurrent } from "@/lib/control-plane/repository-registration";
import { ControlPlaneError, recordProviderObservation } from "@/lib/control-plane/service";
import type { Octokit } from "@/lib/github/app";
import { prisma } from "@/lib/prisma";

const PLATFORM_OWNER = "seorilabs";
const PLATFORM_REPO = "platform";
const PLATFORM_REPOSITORY = `${PLATFORM_OWNER}/${PLATFORM_REPO}`;
const RELEASE_MANIFEST_ASSET = "platform-release.json";
const RELEASE_APPROVAL_ASSET = "fleet-approved.json";
const APPROVAL_PURPOSE = "seorilabs-platform-fleet-approved-release-v2";
const MAX_METADATA_ASSET_BYTES = 1024 * 1024;
const MAX_SDK_ASSET_BYTES = 32 * 1024 * 1024;
const SHA_40 = /^[0-9a-f]{40}$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const SHA_256_REVISION = /^sha256:[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

const rawArtifactSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]+$/),
  sha256: z.string().regex(SHA_256),
  size: z.number().int().positive().max(MAX_SDK_ASSET_BYTES),
}).strict();

export const rawPlatformReleaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  release: z.object({
    tag: z.string().regex(RELEASE_TAG),
    sourceSha: z.string().regex(SHA_40),
    baseSourceSha: z.string().regex(SHA_40),
  }).strict(),
  sdk: z.object({
    typescript: z.object({
      package: z.literal("@seorilabs/platform-sdk"),
      version: z.string().regex(SEMVER),
      registry: z.literal("https://npm.pkg.github.com"),
      artifact: rawArtifactSchema,
    }).strict(),
    gdscript: z.object({
      version: z.string().regex(SEMVER),
      source: z.string().url(),
      treeChecksum: z.string().regex(SHA_256),
      artifact: rawArtifactSchema,
      checksumArtifact: rawArtifactSchema,
    }).strict(),
  }).strict(),
  contract: z.object({
    revision: z.string().regex(SHA_256_REVISION),
    baseRevision: z.string().regex(SHA_256_REVISION),
    classification: z.enum(["implementation-only", "contract-additive", "contract-breaking"]),
    supportedApiMajor: z.number().int().positive(),
    affectedTracks: z.array(z.enum(["gdscript", "typescript"])).min(1).max(2),
    affectedCapabilities: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/)).min(1).max(100),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const expectedTag = `v${manifest.sdk.gdscript.version}`;
  const gdscriptName = `seorilabs-platform-gdscript-${manifest.sdk.gdscript.version}.tar.gz`;
  const expectedSource = `https://github.com/${PLATFORM_REPOSITORY}/releases/download/${expectedTag}/${gdscriptName}`;
  if (
    manifest.release.sourceSha === manifest.release.baseSourceSha
    || manifest.release.tag !== expectedTag
    || manifest.sdk.gdscript.artifact.name !== gdscriptName
    || manifest.sdk.gdscript.checksumArtifact.name !== `${gdscriptName}.sha256`
    || manifest.sdk.gdscript.source !== expectedSource
    || manifest.sdk.typescript.artifact.name !== `seorilabs-platform-sdk-${manifest.sdk.typescript.version}.tgz`
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Platform release tag와 SDK artifact identity가 일치하지 않습니다.",
    });
  }
  for (const [path, values] of [
    ["affectedTracks", manifest.contract.affectedTracks],
    ["affectedCapabilities", manifest.contract.affectedCapabilities],
  ] as const) {
    const sorted = [...values].sort();
    if (new Set(values).size !== values.length || canonicalJson(values) !== canonicalJson(sorted)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contract", path],
        message: "영향 목록은 중복 없이 정렬되어야 합니다.",
      });
    }
  }
  if (
    manifest.contract.classification !== "implementation-only"
    && canonicalJson(manifest.contract.affectedTracks) !== canonicalJson(["gdscript", "typescript"])
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contract", "affectedTracks"],
      message: "계약 변경 release는 두 SDK track을 모두 포함해야 합니다.",
    });
  }
});

export const platformReleaseApprovalSchema = z.object({
  schemaVersion: z.literal(2),
  algorithm: z.literal("Ed25519"),
  keyId: z.string().regex(SAFE_ID),
  payload: z.object({
    purpose: z.literal(APPROVAL_PURPOSE),
    repository: z.literal(PLATFORM_REPOSITORY),
    manifestSha256: z.string().regex(SHA_256_REVISION),
    sourceSha: z.string().regex(SHA_40),
    releaseTag: z.string().regex(RELEASE_TAG),
    status: z.literal("fleet-approved"),
    canaryEvidence: platformCanaryEvidenceSchema,
  }).strict(),
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

const trustedReleaseKeyRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  keys: z.array(z.object({
    algorithm: z.literal("Ed25519"),
    keyId: z.string().regex(SAFE_ID),
    publicKeyPem: z.string().min(1).max(10_000),
    status: z.enum(["ACTIVE", "REVOKED"]),
  }).strict()).min(1).max(100),
}).strict();

export type RawPlatformReleaseManifest = z.infer<typeof rawPlatformReleaseManifestSchema>;
export type PlatformReleaseApproval = z.infer<typeof platformReleaseApprovalSchema>;

type PlatformReleaseAsset = {
  id: number;
  name: string;
  size: number;
  digest: string | null;
  createdAt: string;
  updatedAt: string;
};

type PlatformReleaseSource = {
  id: number;
  tagName: string;
  tagSourceSha: string;
  publishedAt: string;
  draft: boolean;
  prerelease: boolean;
  assets: PlatformReleaseAsset[];
};

type ManagedPlatformConsumer = {
  repoId: bigint;
  repoFullName: string;
  engine: "RN" | "GODOT";
  sourceSha: string;
  discoveryObservationId: string;
  discoveryObservedAt: Date;
  platformConsumer: PlatformConsumerObservationPayload;
};

export interface PlatformFleetProducerDependencies {
  latestRelease(): Promise<PlatformReleaseSource | null>;
  readAsset(asset: PlatformReleaseAsset, maxBytes: number): Promise<Buffer>;
  listConsumers(): Promise<ManagedPlatformConsumer[]>;
  recordObservation: typeof recordProviderObservation;
  recordRelease: typeof recordPlatformRelease;
  reconcile: typeof reconcilePlatformFleet;
  signingKey: string;
  trustedReleaseKeysJson: string;
}

export type PlatformFleetProducerResult =
  | { status: "WAITING_RELEASE"; recorded: 0; reconciled: false }
  | {
      status: "WAITING_APPROVAL";
      releaseId: string;
      releaseTag: string;
      rawManifestSha256: string;
      recorded: 0;
      reconciled: false;
    }
  | {
      status: "RECONCILED";
      releaseId: string;
      releaseTag: string;
      rawManifestSha256: string;
      normalizedManifestDigest: string;
      releaseDuplicate: boolean;
      observed: number;
      observationDuplicates: number;
      reconcileDuplicate: boolean;
      recorded: 1;
      reconciled: true;
    };

function fail(message: string, code: string, status = 409): never {
  throw new ControlPlaneError(message, status, code);
}

function parseJsonBytes(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return fail(`${label} JSON을 해석할 수 없습니다.`, "PLATFORM_RELEASE_JSON_INVALID");
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function uniqueAsset(source: PlatformReleaseSource, name: string, required: boolean): PlatformReleaseAsset | null {
  const matches = source.assets.filter((asset) => asset.name === name);
  if (matches.length === 0 && !required) return null;
  if (matches.length !== 1) {
    return fail(`GitHub Release asset ${name}의 identity가 유일하지 않습니다.`, "PLATFORM_RELEASE_ASSET_IDENTITY_INVALID");
  }
  return matches[0];
}

function assertAssetBytes(asset: PlatformReleaseAsset, bytes: Buffer, expected: {
  sha256?: string;
  size?: number;
}): void {
  const digest = sha256(bytes);
  if (
    asset.size !== bytes.length
    || (expected.size !== undefined && expected.size !== bytes.length)
    || (expected.sha256 !== undefined && expected.sha256 !== digest)
    || (asset.digest !== null && asset.digest !== `sha256:${digest}`)
  ) {
    fail(`GitHub Release asset ${asset.name}의 size 또는 digest가 다릅니다.`, "PLATFORM_RELEASE_ASSET_DIGEST_MISMATCH");
  }
}

function activeTrustedKeys(json: string): Map<string, KeyObject> {
  if (!json.trim()) {
    return fail(
      "Fleet approval 공개 trust root가 설정되지 않았습니다.",
      "PLATFORM_RELEASE_TRUST_ROOT_REQUIRED",
      503,
    );
  }
  let rawRegistry: unknown;
  try {
    rawRegistry = JSON.parse(json) as unknown;
  } catch {
    return fail("Fleet approval trust root JSON을 해석할 수 없습니다.", "PLATFORM_RELEASE_TRUST_ROOT_INVALID");
  }
  const registry = trustedReleaseKeyRegistrySchema.parse(rawRegistry);
  const result = new Map<string, KeyObject>();
  const seen = new Set<string>();
  for (const entry of registry.keys) {
    if (seen.has(entry.keyId)) fail("Fleet approval key ID가 중복되었습니다.", "PLATFORM_RELEASE_TRUST_ROOT_INVALID");
    seen.add(entry.keyId);
    const publicKeyPem = entry.publicKeyPem.trim().replace(/\r\n/g, "\n");
    if (
      !/^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/]{1,64}\n)*[A-Za-z0-9+/]{1,64}={0,2}\n-----END PUBLIC KEY-----$/.test(publicKeyPem)
      || publicKeyPem.includes("PRIVATE KEY")
    ) {
      fail("Fleet approval trust root에는 SPKI 공개키만 사용할 수 있습니다.", "PLATFORM_RELEASE_TRUST_ROOT_INVALID");
    }
    let key: KeyObject;
    try {
      key = createPublicKey(publicKeyPem);
    } catch {
      return fail("Fleet approval 공개키를 해석할 수 없습니다.", "PLATFORM_RELEASE_TRUST_ROOT_INVALID");
    }
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      fail("Fleet approval 공개키는 Ed25519여야 합니다.", "PLATFORM_RELEASE_TRUST_ROOT_INVALID");
    }
    const normalizedSpki = key.export({ type: "spki", format: "pem" }).toString().trim();
    if (normalizedSpki !== publicKeyPem) {
      fail("Fleet approval 공개키는 canonical SPKI PEM이어야 합니다.", "PLATFORM_RELEASE_TRUST_ROOT_INVALID");
    }
    if (entry.status === "ACTIVE") result.set(entry.keyId, key);
  }
  if (result.size === 0) fail("ACTIVE Fleet approval 공개키가 없습니다.", "PLATFORM_RELEASE_TRUST_ROOT_INVALID");
  return result;
}

export function verifyPlatformReleaseApproval(input: {
  manifestBytes: Buffer;
  approvalBytes: Buffer;
  trustedReleaseKeysJson: string;
}): { manifest: RawPlatformReleaseManifest; approval: PlatformReleaseApproval; rawManifestSha256: string; approvalSha256: string } {
  const manifest = rawPlatformReleaseManifestSchema.parse(parseJsonBytes(input.manifestBytes, RELEASE_MANIFEST_ASSET));
  const approval = platformReleaseApprovalSchema.parse(parseJsonBytes(input.approvalBytes, RELEASE_APPROVAL_ASSET));
  const rawManifestSha256 = sha256(input.manifestBytes);
  const expectedPayload = {
    purpose: APPROVAL_PURPOSE,
    repository: PLATFORM_REPOSITORY,
    manifestSha256: `sha256:${rawManifestSha256}`,
    sourceSha: manifest.release.sourceSha,
    releaseTag: manifest.release.tag,
    status: "fleet-approved",
    canaryEvidence: approval.payload.canaryEvidence,
  } as const;
  if (canonicalJson(approval.payload as JsonValue) !== canonicalJson(expectedPayload as JsonValue)) {
    fail("Fleet approval payload가 raw platform-release.json과 일치하지 않습니다.", "PLATFORM_RELEASE_APPROVAL_IDENTITY_MISMATCH");
  }
  const key = activeTrustedKeys(input.trustedReleaseKeysJson).get(approval.keyId);
  if (!key) fail("신뢰하지 않는 Fleet approval key입니다.", "PLATFORM_RELEASE_APPROVAL_KEY_UNTRUSTED", 403);
  const signature = Buffer.from(approval.signature, "base64");
  if (
    signature.length !== 64
    || !verifySignature(null, Buffer.from(canonicalJson(approval.payload as JsonValue), "utf8"), key, signature)
  ) {
    fail("Fleet approval 서명이 올바르지 않습니다.", "PLATFORM_RELEASE_APPROVAL_SIGNATURE_INVALID", 403);
  }
  return { manifest, approval, rawManifestSha256, approvalSha256: sha256(input.approvalBytes) };
}

function classification(
  value: RawPlatformReleaseManifest["contract"]["classification"],
): PlatformReleaseManifest["classification"] {
  if (value === "implementation-only") return "IMPLEMENTATION_ONLY";
  if (value === "contract-additive") return "CONTRACT_ADDITION";
  return "CONTRACT_CHANGE";
}

function normalizedReleaseManifest(input: {
  source: PlatformReleaseSource;
  raw: RawPlatformReleaseManifest;
  approval: PlatformReleaseApproval;
  rawManifestSha256: string;
  approvalSha256: string;
}): PlatformReleaseManifest {
  return platformReleaseManifestSchema.parse({
    schemaVersion: 1,
    approval: "FLEET_APPROVED",
    version: input.raw.release.tag.slice(1),
    sourceSha: input.raw.release.sourceSha,
    contractRevision: input.raw.contract.revision.slice("sha256:".length),
    classification: classification(input.raw.contract.classification),
    publishedAt: new Date(input.source.publishedAt).toISOString(),
    artifacts: [{
      kind: "TYPESCRIPT",
      version: input.raw.sdk.typescript.version,
      digest: input.raw.sdk.typescript.artifact.sha256,
      packageName: input.raw.sdk.typescript.package,
    }, {
      kind: "GDSCRIPT",
      version: input.raw.sdk.gdscript.version,
      digest: input.raw.sdk.gdscript.artifact.sha256,
      releaseAssetUrl: input.raw.sdk.gdscript.source,
      treeChecksum: input.raw.sdk.gdscript.treeChecksum,
    }],
    canaryEvidence: input.approval.payload.canaryEvidence,
    provenance: {
      repository: PLATFORM_REPOSITORY,
      releaseId: input.source.id.toString(),
      releaseTag: input.source.tagName,
      rawManifestSha256: input.rawManifestSha256,
      approvalSha256: input.approvalSha256,
      approvalKeyId: input.approval.keyId,
    },
  });
}

function integrityMatches(bytes: Buffer, integrity: string): boolean {
  const separator = integrity.indexOf("-");
  if (separator < 1) return false;
  const algorithm = integrity.slice(0, separator);
  if (algorithm !== "sha256" && algorithm !== "sha512") return false;
  return createHash(algorithm).update(bytes).digest("base64") === integrity.slice(separator + 1);
}

export function materializePlatformConsumerObservation(input: {
  discovery: PlatformConsumerObservationPayload;
  raw: RawPlatformReleaseManifest;
  /** Release의 exact npm pack asset. 현재 TS SDK를 검증할 때 필수다. */
  typescriptArtifact?: Buffer;
}): PlatformConsumerObservationPayload {
  const discovery = platformConsumerObservationPayloadSchema.parse(input.discovery);
  if (discovery.integration !== "SDK") return discovery;
  if (!discovery.evidenceDigest) {
    return fail("exact discovery에 Platform evidence digest가 없습니다.", "PLATFORM_DISCOVERY_EVIDENCE_INCOMPLETE");
  }
  const contractRevision = input.raw.contract.revision.slice("sha256:".length);
  if (discovery.artifactKind === "TYPESCRIPT") {
    if (discovery.observedVersion !== input.raw.sdk.typescript.version) return discovery;
    if (
      !discovery.lockIntegrity
      || !input.typescriptArtifact
      || !integrityMatches(input.typescriptArtifact, discovery.lockIntegrity)
    ) {
      return {
        schemaVersion: 1,
        sourceSha: discovery.sourceSha,
        integration: "CUSTOM_HTTP",
        evidenceDigest: jsonDigest({
          contractVersion: "platform-consumer-materialization/v1",
          discoveryEvidenceDigest: discovery.evidenceDigest,
          releaseManifestSha256: sha256(Buffer.from(canonicalJson(input.raw as JsonValue), "utf8")),
          reason: "CURRENT_ARTIFACT_INTEGRITY_MISMATCH",
        }),
      };
    }
    return {
      ...discovery,
      observedDigest: input.raw.sdk.typescript.artifact.sha256,
      contractRevision,
    };
  }
  if (discovery.observedVersion !== input.raw.sdk.gdscript.version) return discovery;
  if (
    discovery.releaseAssetUrl !== input.raw.sdk.gdscript.source
    || discovery.treeChecksum !== input.raw.sdk.gdscript.treeChecksum
  ) {
    return {
      schemaVersion: 1,
      sourceSha: discovery.sourceSha,
      integration: "CUSTOM_HTTP",
      evidenceDigest: jsonDigest({
        contractVersion: "platform-consumer-materialization/v1",
        discoveryEvidenceDigest: discovery.evidenceDigest,
        releaseManifestSha256: sha256(Buffer.from(canonicalJson(input.raw as JsonValue), "utf8")),
        reason: "CURRENT_GDSCRIPT_TREE_MISMATCH",
      }),
    };
  }
  return {
    ...discovery,
    observedDigest: input.raw.sdk.gdscript.artifact.sha256,
    contractRevision,
  };
}

function exactSourceMetadata(source: PlatformReleaseSource, raw: RawPlatformReleaseManifest): void {
  if (
    source.draft
    || source.prerelease
    || source.tagName !== raw.release.tag
    || source.tagSourceSha.toLowerCase() !== raw.release.sourceSha
    || !Number.isSafeInteger(source.id)
    || source.id <= 0
    || !Number.isFinite(Date.parse(source.publishedAt))
  ) {
    fail("GitHub Release 공개 identity가 raw manifest와 일치하지 않습니다.", "PLATFORM_RELEASE_GITHUB_IDENTITY_MISMATCH");
  }
}

function producerIdempotencyKey(scope: string, value: JsonValue): string {
  return `${scope}:${jsonDigest(value)}`;
}

async function recordObservationIdempotently(
  record: typeof recordProviderObservation,
  input: Parameters<typeof recordProviderObservation>[0],
) {
  try {
    return await record(input);
  } catch (error) {
    if ((error as { code?: unknown })?.code !== "P2002") throw error;
    // 같은 idempotency key의 concurrent create가 commit된 뒤 readback한다.
    return record(input);
  }
}

export async function producePlatformFleetRelease(
  dependencies: PlatformFleetProducerDependencies = defaultDependencies(),
): Promise<PlatformFleetProducerResult> {
  const source = await dependencies.latestRelease();
  if (!source) return { status: "WAITING_RELEASE", recorded: 0, reconciled: false };
  const manifestAsset = uniqueAsset(source, RELEASE_MANIFEST_ASSET, true)!;
  const manifestBytes = await dependencies.readAsset(manifestAsset, MAX_METADATA_ASSET_BYTES);
  assertAssetBytes(manifestAsset, manifestBytes, {});
  const raw = rawPlatformReleaseManifestSchema.parse(parseJsonBytes(manifestBytes, RELEASE_MANIFEST_ASSET));
  exactSourceMetadata(source, raw);
  const rawManifestSha256 = sha256(manifestBytes);
  const approvalAsset = uniqueAsset(source, RELEASE_APPROVAL_ASSET, false);
  if (!approvalAsset) {
    return {
      status: "WAITING_APPROVAL",
      releaseId: source.id.toString(),
      releaseTag: source.tagName,
      rawManifestSha256,
      recorded: 0,
      reconciled: false,
    };
  }

  const approvalBytes = await dependencies.readAsset(approvalAsset, MAX_METADATA_ASSET_BYTES);
  assertAssetBytes(approvalAsset, approvalBytes, {});
  const verified = verifyPlatformReleaseApproval({
    manifestBytes,
    approvalBytes,
    trustedReleaseKeysJson: dependencies.trustedReleaseKeysJson,
  });
  const sdkArtifacts = [
    verified.manifest.sdk.typescript.artifact,
    verified.manifest.sdk.gdscript.artifact,
    verified.manifest.sdk.gdscript.checksumArtifact,
  ];
  const artifactBytes = new Map<string, Buffer>();
  for (const expected of sdkArtifacts) {
    const asset = uniqueAsset(source, expected.name, true)!;
    const bytes = await dependencies.readAsset(asset, MAX_SDK_ASSET_BYTES);
    assertAssetBytes(asset, bytes, expected);
    artifactBytes.set(expected.name, bytes);
  }
  const checksumBytes = artifactBytes.get(verified.manifest.sdk.gdscript.checksumArtifact.name)!;
  const expectedChecksum = `${verified.manifest.sdk.gdscript.artifact.sha256}  ${verified.manifest.sdk.gdscript.artifact.name}\n`;
  if (!checksumBytes.equals(Buffer.from(expectedChecksum, "utf8"))) {
    fail("GDScript checksum asset 내용이 artifact와 일치하지 않습니다.", "PLATFORM_RELEASE_CHECKSUM_ASSET_INVALID");
  }

  const consumers = await dependencies.listConsumers();
  if (consumers.length === 0) {
    fail("ACTIVE Platform consumer cohort가 비어 있습니다.", "PLATFORM_DISCOVERY_COHORT_INCOMPLETE");
  }
  const normalized = normalizedReleaseManifest({
    source,
    raw: verified.manifest,
    approval: verified.approval,
    rawManifestSha256: verified.rawManifestSha256,
    approvalSha256: verified.approvalSha256,
  });
  const signed = signSnapshot(normalized as unknown as JsonValue, dependencies.signingKey);
  const releaseResult = await dependencies.recordRelease({
    manifest: normalized,
    manifestDigest: signed.digest,
    signature: signed.signature,
    actor: "scheduler:platform-fleet-producer",
    idempotencyKey: producerIdempotencyKey("platform-release-producer", {
      rawManifestSha256: verified.rawManifestSha256,
      approvalSha256: verified.approvalSha256,
    }),
    signingKey: dependencies.signingKey,
  });

  const reconcileConsumers: Array<{
    repoId: string;
    discoveryObservationId: string;
    providerObservationId: string;
  }> = [];
  let observed = 0;
  let observationDuplicates = 0;
  for (const consumer of consumers) {
    const observationTime = new Date(Math.max(
      new Date(approvalAsset.updatedAt).getTime(),
      consumer.discoveryObservedAt.getTime(),
    ));
    const payload = materializePlatformConsumerObservation({
      discovery: consumer.platformConsumer,
      raw: verified.manifest,
      typescriptArtifact: artifactBytes.get(verified.manifest.sdk.typescript.artifact.name),
    });
    const observation = await recordObservationIdempotently(dependencies.recordObservation, {
      repoId: consumer.repoId,
      provider: "platform",
      resourceType: "platform-consumer",
      resourceId: consumer.repoId.toString(),
      observedAt: observationTime,
      observedBy: "scheduler:platform-fleet-producer",
      idempotencyKey: producerIdempotencyKey("platform-consumer-producer", {
        repoId: consumer.repoId.toString(),
        sourceSha: consumer.sourceSha,
        rawManifestSha256: verified.rawManifestSha256,
        payload,
      }),
      payload,
    });
    if (observation.duplicate) observationDuplicates += 1;
    else observed += 1;
    reconcileConsumers.push({
      repoId: consumer.repoId.toString(),
      discoveryObservationId: consumer.discoveryObservationId,
      providerObservationId: observation.observation.id,
    });
  }
  const reconcileResult = await dependencies.reconcile({
    platformReleaseId: releaseResult.release.id,
    consumers: reconcileConsumers,
    actor: "scheduler:platform-fleet-producer",
    idempotencyKey: producerIdempotencyKey("platform-fleet-producer-reconcile", {
      platformReleaseId: releaseResult.release.id,
      consumers: reconcileConsumers,
    }),
    signingKey: dependencies.signingKey,
  });
  return {
    status: "RECONCILED",
    releaseId: source.id.toString(),
    releaseTag: source.tagName,
    rawManifestSha256: verified.rawManifestSha256,
    normalizedManifestDigest: signed.digest,
    releaseDuplicate: releaseResult.duplicate,
    observed,
    observationDuplicates,
    reconcileDuplicate: reconcileResult.duplicate === true,
    recorded: 1,
    reconciled: true,
  };
}

function bufferFromOctokitData(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return null;
}

async function latestReleaseFromGitHub(octokit: Octokit): Promise<PlatformReleaseSource | null> {
  let release: unknown;
  try {
    release = (await octokit.rest.repos.getLatestRelease({ owner: PLATFORM_OWNER, repo: PLATFORM_REPO })).data;
  } catch (error) {
    if ((error as { status?: unknown })?.status === 404) return null;
    return fail("Platform latest Release를 읽지 못했습니다.", "PLATFORM_RELEASE_READ_FAILED", 503);
  }
  const value = release as {
    id?: unknown;
    tag_name?: unknown;
    published_at?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    assets?: unknown;
  };
  if (
    !Number.isSafeInteger(value.id)
    || typeof value.tag_name !== "string"
    || typeof value.published_at !== "string"
    || !Array.isArray(value.assets)
  ) {
    return fail("GitHub latest release 응답이 올바르지 않습니다.", "PLATFORM_RELEASE_GITHUB_IDENTITY_MISMATCH");
  }
  let commit: Awaited<ReturnType<Octokit["rest"]["repos"]["getCommit"]>>;
  try {
    commit = await octokit.rest.repos.getCommit({
      owner: PLATFORM_OWNER,
      repo: PLATFORM_REPO,
      ref: value.tag_name,
    });
  } catch {
    return fail("Platform release tag commit을 읽지 못했습니다.", "PLATFORM_RELEASE_READ_FAILED", 503);
  }
  const tagSourceSha = typeof commit.data.sha === "string" ? commit.data.sha.toLowerCase() : "";
  if (!SHA_40.test(tagSourceSha)) {
    return fail("Platform release tag의 exact source SHA를 읽지 못했습니다.", "PLATFORM_RELEASE_GITHUB_IDENTITY_MISMATCH");
  }
  const assets: PlatformReleaseAsset[] = value.assets.map((asset) => {
    const entry = asset as {
      id?: unknown;
      name?: unknown;
      size?: unknown;
      digest?: unknown;
      created_at?: unknown;
      updated_at?: unknown;
    };
    if (
      !Number.isSafeInteger(entry.id)
      || typeof entry.name !== "string"
      || !Number.isSafeInteger(entry.size)
      || Number(entry.size) < 0
      || (entry.digest !== undefined && entry.digest !== null && typeof entry.digest !== "string")
      || typeof entry.created_at !== "string"
      || typeof entry.updated_at !== "string"
      || !Number.isFinite(Date.parse(entry.created_at))
      || !Number.isFinite(Date.parse(entry.updated_at))
    ) {
      return fail("GitHub Release asset metadata가 올바르지 않습니다.", "PLATFORM_RELEASE_ASSET_IDENTITY_INVALID");
    }
    return {
      id: Number(entry.id),
      name: entry.name,
      size: Number(entry.size),
      digest: typeof entry.digest === "string" ? entry.digest : null,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
    };
  });
  return {
    id: Number(value.id),
    tagName: value.tag_name,
    tagSourceSha,
    publishedAt: value.published_at,
    draft: value.draft === true,
    prerelease: value.prerelease === true,
    assets,
  };
}

async function listManagedConsumers(): Promise<ManagedPlatformConsumer[]> {
  const apps = await prisma.app.findMany({
    where: { status: "ACTIVE" },
    orderBy: [{ repoId: "asc" }, { id: "asc" }],
    select: {
      id: true,
      repoId: true,
      repoFullName: true,
      engine: true,
      discoveryObservations: {
        orderBy: latestDiscoveryObservationOrder(),
        take: 1,
        select: { id: true, sourceSha: true, payload: true, payloadHash: true, observedAt: true },
      },
    },
  });
  const missingRepository = apps.find((app) => app.repoId === null);
  if (missingRepository) {
    return fail(
      `ACTIVE app ${missingRepository.repoFullName}에 GitHub repository ID가 없습니다.`,
      "PLATFORM_ACTIVE_REPOSITORY_ID_REQUIRED",
    );
  }
  const repoIds = apps.flatMap((app) => app.repoId === null ? [] : [app.repoId]);
  const registrations = await prisma.repositoryRegistration.findMany({
    where: { repoId: { in: repoIds } },
    select: {
      repoId: true,
      repoFullName: true,
      archived: true,
      status: true,
      managementKind: true,
      lastDefaultPushSha: true,
      lastReconciledSha: true,
    },
  });
  const registrationByRepo = new Map(registrations.map((entry) => [entry.repoId.toString(), entry]));
  return apps.map((app) => {
    const repoId = app.repoId;
    const discovery = app.discoveryObservations[0];
    const registration = repoId === null ? undefined : registrationByRepo.get(repoId.toString());
    if (
      repoId === null
      || !registration
      || registration.repoFullName.toLowerCase() !== app.repoFullName.toLowerCase()
      || !discovery
      || !repositorySourceIsCurrent(registration, discovery.sourceSha)
      || jsonDigest(discovery.payload as JsonValue) !== discovery.payloadHash
    ) {
      return fail(
        `ACTIVE app ${app.repoFullName}의 exact discovery가 완료되지 않았습니다.`,
        "PLATFORM_DISCOVERY_COHORT_INCOMPLETE",
      );
    }
    const discoveryPayload = discovery.payload as Record<string, unknown>;
    const platformConsumer = platformConsumerObservationPayloadSchema.parse(discoveryPayload.platformConsumer);
    const expectedKind = app.engine === "GODOT" ? "GDSCRIPT" : "TYPESCRIPT";
    if (
      platformConsumer.sourceSha.toLowerCase() !== discovery.sourceSha.toLowerCase()
      || (platformConsumer.integration === "SDK" && platformConsumer.artifactKind !== expectedKind)
    ) {
      return fail(
        `ACTIVE app ${app.repoFullName}의 Platform discovery identity가 일치하지 않습니다.`,
        "PLATFORM_DISCOVERY_EVIDENCE_INVALID",
      );
    }
    return {
      repoId,
      repoFullName: app.repoFullName,
      engine: app.engine,
      sourceSha: discovery.sourceSha,
      discoveryObservationId: discovery.id,
      discoveryObservedAt: discovery.observedAt,
      platformConsumer,
    };
  });
}

function defaultDependencies(): PlatformFleetProducerDependencies {
  let octokitPromise: Promise<Octokit> | null = null;
  const octokit = () => {
    octokitPromise ??= import("@/lib/github/app").then(({ getInstallationOctokit }) => (
      getInstallationOctokit()
    ));
    return octokitPromise;
  };
  return {
    latestRelease: async () => latestReleaseFromGitHub(await octokit()),
    readAsset: async (asset, maxBytes) => {
      if (asset.size > maxBytes) {
        return fail(`GitHub Release asset ${asset.name}이 허용 크기를 넘었습니다.`, "PLATFORM_RELEASE_ASSET_TOO_LARGE");
      }
      let response: { data: unknown };
      try {
        response = await (await octokit()).request(
          "GET /repos/{owner}/{repo}/releases/assets/{asset_id}",
          {
            owner: PLATFORM_OWNER,
            repo: PLATFORM_REPO,
            asset_id: asset.id,
            headers: { accept: "application/octet-stream" },
          },
        );
      } catch {
        return fail(`GitHub Release asset ${asset.name}을 읽지 못했습니다.`, "PLATFORM_RELEASE_READ_FAILED", 503);
      }
      const bytes = bufferFromOctokitData(response.data);
      if (!bytes || bytes.length > maxBytes) {
        return fail(`GitHub Release asset ${asset.name}을 안전하게 읽지 못했습니다.`, "PLATFORM_RELEASE_ASSET_INVALID");
      }
      return bytes;
    },
    listConsumers: listManagedConsumers,
    recordObservation: recordProviderObservation,
    recordRelease: recordPlatformRelease,
    reconcile: reconcilePlatformFleet,
    signingKey: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "",
    trustedReleaseKeysJson: process.env.PLATFORM_FLEET_APPROVAL_PUBLIC_KEYS_JSON ?? "",
  };
}
