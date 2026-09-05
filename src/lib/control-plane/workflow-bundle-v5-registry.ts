import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { Prisma } from "@prisma/client";
import { unzipSync } from "fflate";
import { z } from "zod";

import { contractCanonicalJson, jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";
import { prisma } from "@/lib/prisma";
import { WORKFLOW_BUNDLE_CANDIDATE_SOURCE } from "@/lib/control-plane/workflow-bundle-candidate-source";

const REGISTRY_ID = WORKFLOW_BUNDLE_CANDIDATE_SOURCE.registryId;
const REGISTRY_REPOSITORY = WORKFLOW_BUNDLE_CANDIDATE_SOURCE.repository;
const REGISTRY_REPOSITORY_ID = WORKFLOW_BUNDLE_CANDIDATE_SOURCE.repositoryId;
const CANDIDATE_WORKFLOW_PATH = WORKFLOW_BUNDLE_CANDIDATE_SOURCE.workflowPath;
const MAX_ARTIFACT_ARCHIVE_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

const shaSchema = z.string().regex(SHA);
const sha256Schema = z.string().regex(SHA256);
const requiredValueSchema = z.unknown().refine((value) => value !== undefined);
const digestMapSchema = z.record(sha256Schema).refine(
  (value) => Object.keys(value).length > 0,
  "digest map은 비어 있을 수 없습니다.",
);

const workflowBundleSourceSchema = z.object({
  repository: z.literal(REGISTRY_REPOSITORY),
  sha: shaSchema,
  workflowExecutionSha: shaSchema,
}).strict();

const approvalSignatureSchema = z.object({
  algorithm: z.literal("Ed25519"),
  keyId: z.string().regex(PUBLIC_ID),
  policyRevision: z.string().regex(PUBLIC_ID),
  value: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();

const evidenceBaseFields = {
  schemaVersion: z.literal(2),
  repositoryId: z.number().int().positive(),
  fullName: z.string().regex(/^seorilabs\/[A-Za-z0-9._-]+$/),
  sourceSha: shaSchema,
  workflowExecutionSha: shaSchema,
  workflowRef: z.string().regex(/^seorilabs\/\.github\/\.github\/workflows\/[a-z0-9-]+\.yml@[0-9a-f]{40}$/),
  runId: z.number().int().positive(),
  runAttempt: z.number().int().positive(),
  configRevisionId: z.string().regex(PUBLIC_ID),
  configRevision: z.number().int().positive(),
  configRevisionDigest: sha256Schema,
  signedSnapshotDigest: sha256Schema,
  snapshotSignatureKeyId: z.string().regex(PUBLIC_ID),
  snapshotSignaturePolicyRevision: z.string().regex(PUBLIC_ID),
  snapshotSignatureDigest: sha256Schema,
  artifactSha256: sha256Schema,
} as const;

const staticEvidenceSchema = z.object({
  ...evidenceBaseFields,
  target: z.literal("static"),
  profile: z.enum(["react-native", "godot", "capacitor", "ait-web"]),
  bindingSourceSha: shaSchema,
  callerWorkflowRef: z.string().regex(
    /^seorilabs\/[A-Za-z0-9._-]+\/\.github\/workflows\/org-contract\.yml@(?:refs\/heads\/main|refs\/pull\/[1-9][0-9]*\/merge)$/,
  ),
  manifestDigest: sha256Schema,
}).strict();

const buildEvidenceSchema = z.object({
  ...evidenceBaseFields,
  target: z.literal("build"),
  buildProfile: z.enum(["react-native-android", "godot-android"]),
  bindingSourceSha: shaSchema,
  callerWorkflowRef: z.string().regex(
    /^seorilabs\/(?:happy-farm|lizard-tycoon)\/\.github\/workflows\/android-build-only\.yml@refs\/pull\/[1-9][0-9]*\/merge$/,
  ),
  manifestDigest: sha256Schema,
  bundlePayloadDigest: sha256Schema,
  cloudBuildId: z.string().uuid(),
  builderImage: z.string().regex(/@sha256:[0-9a-f]{64}$/),
  cloudBuildConfigSha256: sha256Schema,
  marketUpload: z.literal(false),
}).strict();

const workflowBundleApprovalSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("CANDIDATE"),
    evidence: z.array(z.unknown()).length(0),
  }).strict(),
  z.object({
    state: z.literal("APPROVED"),
    // 필수 증거 수는 번들이 선언한 promotionScope에서 나온다. 여기서는 모양만 보고,
    // 정확한 집합은 assertApprovedEvidence가 그 범위와 대조한다.
    evidence: z.array(z.discriminatedUnion("target", [staticEvidenceSchema, buildEvidenceSchema]))
      .min(2)
      .max(16),
    signature: approvalSignatureSchema,
  }).strict(),
]);

const buildProfileSchema = z.object({
  target: z.literal("android"),
  executor: z.literal("cloud-build-x64"),
  workflow: z.enum([
    ".github/workflows/rn-build-android-cloud-v2.yml",
    ".github/workflows/godot-build-android-cloud-v2.yml",
  ]),
  artifactKind: z.literal("android-aab"),
  scriptPath: z.literal("scripts/build-android.sh"),
  builderImage: z.string().regex(/@sha256:[0-9a-f]{64}$/),
  sha: shaSchema,
}).strict();

const staticProfileSchema = z.object({
  path: z.enum([
    ".github/workflows/js-static-checks-v1.yml",
    ".github/workflows/godot-checks-v3.yml",
  ]),
  runtime: z.enum(["react-native", "godot", "capacitor", "ait-web"]),
  sha: shaSchema,
}).strict();

/**
 * Backoffice가 build 권한에 사용하는 v5 필드만 엄격히 해석한다. 나머지 필드도
 * top-level key와 integrity에 포함되므로 삭제/추가/변조는 payloadDigest가 막는다.
 */
export const workflowBundleV5RegistrySchema = z.object({
  schemaVersion: z.literal(2),
  bundleVersion: z.literal("5.0.0"),
  source: workflowBundleSourceSchema,
  quality: z.object({
    contractDigests: digestMapSchema,
    runtimeAssetDigests: digestMapSchema,
  }).passthrough(),
  promotionScope: z.object({
    staticProfiles: z.array(z.string()),
    buildProfiles: z.tuple([
      z.literal("react-native-android"),
      z.literal("godot-android"),
    ]),
  }).strict(),
  staticRuntimeBinding: requiredValueSchema,
  buildRuntimeBinding: requiredValueSchema,
  staticProfiles: z.object({
    "react-native": staticProfileSchema.refine((profile) => (
      profile.runtime === "react-native"
      && profile.path === ".github/workflows/js-static-checks-v1.yml"
    )),
    godot: staticProfileSchema.refine((profile) => (
      profile.runtime === "godot"
      && profile.path === ".github/workflows/godot-checks-v3.yml"
    )),
    capacitor: staticProfileSchema.refine((profile) => (
      profile.runtime === "capacitor"
      && profile.path === ".github/workflows/js-static-checks-v1.yml"
    )),
    "ait-web": staticProfileSchema.refine((profile) => (
      profile.runtime === "ait-web"
      && profile.path === ".github/workflows/js-static-checks-v1.yml"
    )),
  }).strict(),
  buildProfiles: z.object({
    "react-native-android": buildProfileSchema.refine(
      (profile) => profile.workflow === ".github/workflows/rn-build-android-cloud-v2.yml",
    ),
    "godot-android": buildProfileSchema.refine(
      (profile) => profile.workflow === ".github/workflows/godot-build-android-cloud-v2.yml",
    ),
  }).passthrough(),
  actions: requiredValueSchema,
  runners: requiredValueSchema,
  toolchains: requiredValueSchema,
  callerPolicies: requiredValueSchema,
  lifecyclePolicy: requiredValueSchema,
  approval: workflowBundleApprovalSchema,
  integrity: z.object({
    algorithm: z.literal("sha256"),
    payloadDigest: sha256Schema,
  }).strict(),
}).strict();

export type WorkflowBundleV5Registry = z.infer<typeof workflowBundleV5RegistrySchema>;
type ApprovedWorkflowBundleV5 = Omit<WorkflowBundleV5Registry, "approval"> & {
  approval: Extract<WorkflowBundleV5Registry["approval"], { state: "APPROVED" }>;
};

const trustedKeyRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  keys: z.array(z.object({
    algorithm: z.literal("Ed25519"),
    keyId: z.string().regex(PUBLIC_ID),
    policyRevision: z.string().regex(PUBLIC_ID),
    publicKeyPem: z.string().min(1).max(10_000),
    fingerprint: sha256Schema,
    status: z.enum(["ACTIVE", "REVOKED"]),
  }).strict()).min(1).max(100),
}).strict();

export const workflowBundleCandidateImportSchema = z.object({
  mode: z.literal("CANDIDATE"),
  sourceSha: shaSchema,
  runId: z.coerce.bigint().positive(),
  runAttempt: z.number().int().positive(),
  artifactId: z.coerce.bigint().positive(),
}).strict();

export const workflowBundleApprovedImportSchema = z.object({
  mode: z.literal("APPROVED"),
  bundle: z.record(z.unknown()),
}).strict();

export const workflowBundleImportSchema = z.discriminatedUnion("mode", [
  workflowBundleCandidateImportSchema,
  workflowBundleApprovedImportSchema,
]);

type CandidateArtifactReadback = {
  repository: string;
  repositoryId: string;
  sourceSha: string;
  workflowPath: string;
  eventName: string;
  headBranch: string;
  runId: bigint;
  runAttempt: number;
  runStatus: string;
  runConclusion: string | null;
  artifactId: bigint;
  artifactName: string;
  artifactDigest: string | null;
  artifactExpired: boolean;
  artifactWorkflowRunId: bigint | null;
  artifactWorkflowRepositoryId: string | null;
  artifactWorkflowHeadSha: string | null;
  archive: Buffer;
};

export type WorkflowBundleRegistryClient = Pick<
  typeof prisma,
  "workflowBundleRegistryRecord" | "$transaction"
>;

export interface WorkflowBundleRegistryDependencies {
  readCandidateArtifact(input: {
    sourceSha: string;
    runId: bigint;
    runAttempt: number;
    artifactId: bigint;
  }): Promise<CandidateArtifactReadback>;
  trustedApprovalKeysJson: string;
}

function fail(message: string, code: string, status = 409): never {
  throw new ControlPlaneError(message, status, code);
}

function sha256(value: string | Buffer | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function bundlePayload(bundle: WorkflowBundleV5Registry): JsonValue {
  const payload = { ...bundle } as Record<string, JsonValue>;
  delete payload.integrity;
  return payload as JsonValue;
}

function withCandidateApproval(bundle: WorkflowBundleV5Registry): WorkflowBundleV5Registry {
  const payload = {
    ...bundlePayload(bundle) as Record<string, JsonValue>,
    approval: { state: "CANDIDATE", evidence: [] },
  } as JsonValue;
  return workflowBundleV5RegistrySchema.parse({
    ...payload as Record<string, unknown>,
    integrity: {
      algorithm: "sha256",
      payloadDigest: sha256(contractCanonicalJson(payload)),
    },
  });
}

function assertBundleIntegrity(input: unknown): WorkflowBundleV5Registry {
  const bundle = workflowBundleV5RegistrySchema.parse(input);
  if (
    bundle.source.sha !== bundle.source.workflowExecutionSha
    || bundle.integrity.payloadDigest !== sha256(contractCanonicalJson(bundlePayload(bundle)))
  ) {
    fail("WorkflowBundle v5 source 또는 payload integrity가 일치하지 않습니다.", "WORKFLOW_BUNDLE_INTEGRITY_INVALID");
  }
  for (const profile of ["react-native-android", "godot-android"] as const) {
    if (bundle.buildProfiles[profile].sha !== bundle.source.workflowExecutionSha) {
      fail("WorkflowBundle v5 build workflow SHA가 source와 일치하지 않습니다.", "WORKFLOW_BUNDLE_PROFILE_SHA_MISMATCH");
    }
  }
  for (const profile of ["react-native", "godot", "capacitor", "ait-web"] as const) {
    if (bundle.staticProfiles[profile].sha !== bundle.source.workflowExecutionSha) {
      fail("WorkflowBundle v5 static workflow SHA가 source와 일치하지 않습니다.", "WORKFLOW_BUNDLE_PROFILE_SHA_MISMATCH");
    }
  }
  return bundle;
}

function digestMap(value: Record<string, string>): string {
  return sha256(contractCanonicalJson(value as JsonValue));
}

function approvalEnvelope(
  candidate: WorkflowBundleV5Registry,
  approved: ApprovedWorkflowBundleV5,
) {
  return {
    schemaVersion: 1,
    kind: "WORKFLOW_BUNDLE_V5_APPROVAL",
    registryId: REGISTRY_ID,
    subject: `workflow-bundle-v5:${approved.source.sha}`,
    bundleVersion: approved.bundleVersion,
    source: approved.source,
    candidateDigest: candidate.integrity.payloadDigest,
    evidenceDigest: sha256(contractCanonicalJson(approved.approval.evidence as JsonValue)),
    contractDigestsDigest: digestMap(approved.quality.contractDigests),
    runtimeAssetDigestsDigest: digestMap(approved.quality.runtimeAssetDigests),
  } as const;
}

function assertApprovedEvidence(
  approved: ApprovedWorkflowBundleV5,
  candidate: WorkflowBundleV5Registry,
): void {
  const identities = approved.approval.evidence.map((record) => (
    record.target === "static"
      ? `static:${record.profile}`
      : `build:${record.buildProfile}`
  )).sort();
  // 승인 범위와 필수 증거를 두 곳에 적으면 한쪽만 바뀌어도 조용히 어긋난다. 번들이
  // 선언한 범위에서 그대로 파생한다.
  const expectedIdentities = [
    ...approved.promotionScope.staticProfiles.map((profile) => `static:${profile}`),
    ...approved.promotionScope.buildProfiles.map((profile) => `build:${profile}`),
  ].sort();
  if (contractCanonicalJson(identities) !== contractCanonicalJson(expectedIdentities)) {
    fail("WorkflowBundle approval evidence set이 완전하지 않습니다.", "WORKFLOW_BUNDLE_EVIDENCE_INVALID");
  }
  for (const record of approved.approval.evidence) {
    if (record.workflowExecutionSha !== approved.source.workflowExecutionSha) {
      fail("WorkflowBundle evidence workflow SHA가 bundle과 다릅니다.", "WORKFLOW_BUNDLE_EVIDENCE_INVALID");
    }
    if (record.target === "static") {
      const profile = approved.staticProfiles[record.profile];
      if (record.workflowRef !== `seorilabs/.github/${profile.path}@${profile.sha}`) {
        fail("Static evidence workflow identity가 bundle profile과 다릅니다.", "WORKFLOW_BUNDLE_EVIDENCE_INVALID");
      }
      continue;
    }
    const expectedCanary = record.buildProfile === "react-native-android"
      ? {
          repositoryId: 1250442131,
          fullName: "seorilabs/happy-farm",
          workflow: ".github/workflows/rn-build-android-cloud-v2.yml",
          cloudBuildConfig: ".github/cloud-build/rn-android-build-only-v2.yaml",
        }
      : {
          repositoryId: 1265192029,
          fullName: "seorilabs/lizard-tycoon",
          workflow: ".github/workflows/godot-build-android-cloud-v2.yml",
          cloudBuildConfig: ".github/cloud-build/godot-android-build-only-v2.yaml",
        };
    const profile = approved.buildProfiles[record.buildProfile];
    // 번들이 그 Cloud Build 설정을 담고 있지 않으면 digest 비교가 undefined와의 대조로
    // 조용히 실패한다. 어떤 자산이 빠졌는지 바로 드러나게 먼저 확인한다.
    const expectedCloudBuildConfigDigest =
      approved.quality.runtimeAssetDigests[expectedCanary.cloudBuildConfig];
    if (expectedCloudBuildConfigDigest === undefined) {
      fail(
        `WorkflowBundle에 canary Cloud Build 설정이 없습니다: ${expectedCanary.cloudBuildConfig}`,
        "WORKFLOW_BUNDLE_EVIDENCE_INVALID",
      );
    }
    if (
      record.repositoryId !== expectedCanary.repositoryId
      || record.fullName !== expectedCanary.fullName
      || record.sourceSha !== record.bindingSourceSha
      || record.bundlePayloadDigest !== candidate.integrity.payloadDigest
      || record.workflowRef !== `seorilabs/.github/${expectedCanary.workflow}@${approved.source.workflowExecutionSha}`
      || record.builderImage !== profile.builderImage
      || record.cloudBuildConfigSha256 !== expectedCloudBuildConfigDigest
      || record.marketUpload !== false
    ) {
      fail("Build canary evidence가 exact source/bundle/runtime readback과 다릅니다.", "WORKFLOW_BUNDLE_EVIDENCE_INVALID");
    }
  }
}

function activeTrustedKeys(json: string): Map<string, { key: KeyObject; policyRevision: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    return fail("WorkflowBundle approval trust root JSON을 해석할 수 없습니다.", "WORKFLOW_BUNDLE_TRUST_ROOT_INVALID", 503);
  }
  const parsed = trustedKeyRegistrySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("WorkflowBundle approval trust root 계약이 유효하지 않습니다.", "WORKFLOW_BUNDLE_TRUST_ROOT_INVALID", 503);
  }
  const result = new Map<string, { key: KeyObject; policyRevision: string }>();
  const seen = new Set<string>();
  for (const entry of parsed.data.keys) {
    if (seen.has(entry.keyId)) {
      return fail("WorkflowBundle approval key ID가 중복되었습니다.", "WORKFLOW_BUNDLE_TRUST_ROOT_INVALID", 503);
    }
    seen.add(entry.keyId);
    const publicKeyPem = entry.publicKeyPem.trim().replace(/\r\n/g, "\n");
    let key: KeyObject;
    try {
      key = createPublicKey(publicKeyPem);
    } catch {
      return fail("WorkflowBundle approval 공개키를 해석할 수 없습니다.", "WORKFLOW_BUNDLE_TRUST_ROOT_INVALID", 503);
    }
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      return fail("WorkflowBundle approval 공개키는 Ed25519여야 합니다.", "WORKFLOW_BUNDLE_TRUST_ROOT_INVALID", 503);
    }
    const canonicalPem = key.export({ type: "spki", format: "pem" }).toString().trim();
    const fingerprint = sha256(key.export({ type: "spki", format: "der" }));
    if (
      canonicalPem !== publicKeyPem
      || publicKeyPem.includes("PRIVATE KEY")
      || fingerprint !== entry.fingerprint
    ) {
      return fail("WorkflowBundle approval 공개키 fingerprint가 등록 metadata와 다릅니다.", "WORKFLOW_BUNDLE_TRUST_ROOT_INVALID", 503);
    }
    if (entry.status === "ACTIVE") {
      result.set(entry.keyId, { key, policyRevision: entry.policyRevision });
    }
  }
  if (result.size === 0) {
    return fail("ACTIVE WorkflowBundle approval 공개키가 없습니다.", "WORKFLOW_BUNDLE_TRUST_ROOT_INVALID", 503);
  }
  return result;
}

export function verifyApprovedBundle(input: unknown, trustedKeysJson: string): {
  approved: ApprovedWorkflowBundleV5;
  candidate: WorkflowBundleV5Registry;
  envelope: ReturnType<typeof approvalEnvelope>;
  approvalPayloadDigest: string;
} {
  const parsed = assertBundleIntegrity(input);
  if (parsed.approval.state !== "APPROVED") {
    fail("APPROVED WorkflowBundle이 필요합니다.", "WORKFLOW_BUNDLE_NOT_APPROVED");
  }
  const approved = parsed as ApprovedWorkflowBundleV5;
  const candidate = withCandidateApproval(approved);
  assertApprovedEvidence(approved, candidate);
  const envelope = approvalEnvelope(candidate, approved);
  const approvalPayload = Buffer.from(contractCanonicalJson(envelope as unknown as JsonValue), "utf8");
  const trusted = activeTrustedKeys(trustedKeysJson).get(approved.approval.signature.keyId);
  const signature = Buffer.from(approved.approval.signature.value, "base64url");
  if (
    !trusted
    || trusted.policyRevision !== approved.approval.signature.policyRevision
    || signature.length !== 64
    || !verifySignature(null, approvalPayload, trusted.key, signature)
  ) {
    fail("WorkflowBundle approval 서명 또는 공개 identity를 검증할 수 없습니다.", "WORKFLOW_BUNDLE_APPROVAL_UNTRUSTED", 403);
  }
  return {
    approved,
    candidate,
    envelope,
    approvalPayloadDigest: sha256(approvalPayload),
  };
}

function bundleFromArchive(archive: Buffer): WorkflowBundleV5Registry {
  if (archive.length === 0 || archive.length > MAX_ARTIFACT_ARCHIVE_BYTES) {
    fail("WorkflowBundle candidate artifact 크기가 허용 범위를 벗어났습니다.", "WORKFLOW_BUNDLE_ARTIFACT_INVALID");
  }
  const entries: Array<{ name: string; size: number }> = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(archive), {
      filter(file) {
        entries.push({ name: file.name, size: file.originalSize });
        return file.name === "workflow-bundle-v5.json" && file.originalSize <= MAX_BUNDLE_BYTES;
      },
    });
  } catch {
    return fail("WorkflowBundle candidate artifact를 안전하게 해제할 수 없습니다.", "WORKFLOW_BUNDLE_ARTIFACT_INVALID");
  }
  if (
    entries.length !== 1
    || entries[0].name !== "workflow-bundle-v5.json"
    || entries[0].size <= 0
    || entries[0].size > MAX_BUNDLE_BYTES
    || Object.keys(files).length !== 1
  ) {
    fail("WorkflowBundle candidate artifact는 정확히 한 JSON만 포함해야 합니다.", "WORKFLOW_BUNDLE_ARTIFACT_INVALID");
  }
  const bytes = Buffer.from(files["workflow-bundle-v5.json"]);
  if (bytes.length !== entries[0].size) {
    fail("WorkflowBundle candidate JSON 크기 readback이 일치하지 않습니다.", "WORKFLOW_BUNDLE_ARTIFACT_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return fail("WorkflowBundle candidate JSON을 해석할 수 없습니다.", "WORKFLOW_BUNDLE_ARTIFACT_INVALID");
  }
  const bundle = assertBundleIntegrity(parsed);
  if (bundle.approval.state !== "CANDIDATE") {
    fail("GitHub candidate artifact가 CANDIDATE가 아닙니다.", "WORKFLOW_BUNDLE_NOT_CANDIDATE");
  }
  return bundle;
}

function bufferFromOctokitData(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

async function readCandidateArtifactFromGitHub(input: {
  sourceSha: string;
  runId: bigint;
  runAttempt: number;
  artifactId: bigint;
}): Promise<CandidateArtifactReadback> {
  if (!Number.isSafeInteger(Number(input.runId)) || !Number.isSafeInteger(Number(input.artifactId))) {
    fail("GitHub Actions ID가 안전한 정수 범위를 벗어났습니다.", "WORKFLOW_BUNDLE_ARTIFACT_INVALID");
  }
  // Registry validation/readback is pure. Load GitHub App auth only for a live
  // candidate import so tests and approved readback never initialize a secret client.
  const { withWorkflowBundleRegistryReadClient } = await import("@/lib/github/workflow-bundle-registry-client");
  return withWorkflowBundleRegistryReadClient(async (client) => {
    const owner = "seorilabs";
    const repo = ".github";
    const [runResponse, artifactResponse] = await Promise.all([
      client.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(input.runId) }),
      client.rest.actions.getArtifact({ owner, repo, artifact_id: Number(input.artifactId) }),
    ]);
    const download = await client.rest.actions.downloadArtifact({
      owner,
      repo,
      artifact_id: Number(input.artifactId),
      archive_format: "zip",
    });
    const archive = bufferFromOctokitData(download.data);
    if (!archive) {
      fail("GitHub candidate artifact bytes를 읽을 수 없습니다.", "WORKFLOW_BUNDLE_ARTIFACT_READ_FAILED", 503);
    }
    const run = runResponse.data;
    const artifact = artifactResponse.data;
    return {
      repository: run.repository.full_name,
      repositoryId: String(run.repository.id),
      sourceSha: run.head_sha.toLowerCase(),
      workflowPath: run.path,
      eventName: run.event,
      headBranch: run.head_branch ?? "",
      runId: BigInt(run.id),
      runAttempt: run.run_attempt ?? 0,
      runStatus: run.status ?? "",
      runConclusion: run.conclusion ?? null,
      artifactId: BigInt(artifact.id),
      artifactName: artifact.name,
      artifactDigest: artifact.digest ?? null,
      artifactExpired: artifact.expired,
      artifactWorkflowRunId: artifact.workflow_run?.id ? BigInt(artifact.workflow_run.id) : null,
      artifactWorkflowRepositoryId: artifact.workflow_run?.repository_id
        ? String(artifact.workflow_run.repository_id)
        : null,
      artifactWorkflowHeadSha: artifact.workflow_run?.head_sha?.toLowerCase() ?? null,
      archive,
    };
  });
}

function defaultDependencies(): WorkflowBundleRegistryDependencies {
  return {
    readCandidateArtifact: readCandidateArtifactFromGitHub,
    trustedApprovalKeysJson: process.env.WORKFLOW_BUNDLE_V5_APPROVAL_PUBLIC_KEYS_JSON ?? "",
  };
}

function assertReplayHash(stored: string, expected: string): void {
  if (stored !== expected) {
    fail("같은 idempotency key가 다른 WorkflowBundle import에 사용되었습니다.", "IDEMPOTENCY_CONFLICT");
  }
}

export async function importWorkflowBundleCandidate(input: {
  sourceSha: string;
  runId: bigint;
  runAttempt: number;
  artifactId: bigint;
  idempotencyKey: string;
  actor: string;
  assertWriteAllowed?: (tx: Prisma.TransactionClient) => Promise<void>;
}, client: WorkflowBundleRegistryClient = prisma, dependencies = defaultDependencies()) {
  const requestHash = jsonDigest({
    mode: "CANDIDATE",
    sourceSha: input.sourceSha,
    runId: input.runId.toString(),
    runAttempt: input.runAttempt,
    artifactId: input.artifactId.toString(),
  });
  const replay = await client.workflowBundleRegistryRecord.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (replay) {
    assertReplayHash(replay.requestHash, requestHash);
    return { record: replay, duplicate: true };
  }
  const readback = await dependencies.readCandidateArtifact(input);
  const expectedName = `workflow-bundle-v5-candidate-${input.sourceSha}`;
  if (
    readback.repository !== REGISTRY_REPOSITORY
    || readback.repositoryId !== REGISTRY_REPOSITORY_ID
    || readback.sourceSha !== input.sourceSha
    || readback.workflowPath !== CANDIDATE_WORKFLOW_PATH
    || !["push", "workflow_dispatch"].includes(readback.eventName)
    || readback.headBranch !== "main"
    || readback.runId !== input.runId
    || readback.runAttempt !== input.runAttempt
    || readback.runStatus !== "completed"
    || readback.runConclusion !== "success"
    || readback.artifactId !== input.artifactId
    || readback.artifactName !== expectedName
    || !SHA256.test(readback.artifactDigest ?? "")
    || readback.artifactDigest !== sha256(readback.archive)
    || readback.artifactExpired
    || readback.artifactWorkflowRunId !== input.runId
    || readback.artifactWorkflowRepositoryId !== REGISTRY_REPOSITORY_ID
    || readback.artifactWorkflowHeadSha !== input.sourceSha
  ) {
    fail("GitHub candidate run/artifact exact readback이 일치하지 않습니다.", "WORKFLOW_BUNDLE_CANDIDATE_UNTRUSTED");
  }
  const bundle = bundleFromArchive(readback.archive);
  if (bundle.source.sha !== input.sourceSha || bundle.integrity.payloadDigest === "") {
    fail("Candidate bundle source가 GitHub artifact identity와 다릅니다.", "WORKFLOW_BUNDLE_CANDIDATE_UNTRUSTED");
  }
  const subject = `workflow-bundle-v5:${bundle.source.sha}`;
  let record;
  try {
    record = await client.$transaction(async (tx) => {
      // 수집 worker는 provider 조회 뒤 같은 transaction에서 현재 generation을 잠근다.
      await input.assertWriteAllowed?.(tx);
      const created = await tx.workflowBundleRegistryRecord.create({
        data: {
          registryId: REGISTRY_ID,
          subject,
          approvalState: "CANDIDATE",
          sourceSha: bundle.source.sha,
          workflowExecutionSha: bundle.source.workflowExecutionSha,
          bundleVersion: bundle.bundleVersion,
          payloadDigest: bundle.integrity.payloadDigest,
          contractDigestsDigest: digestMap(bundle.quality.contractDigests),
          runtimeAssetDigestsDigest: digestMap(bundle.quality.runtimeAssetDigests),
          bundle: bundle as unknown as Prisma.InputJsonValue,
          artifactRepository: readback.repository,
          artifactRepositoryId: BigInt(readback.repositoryId),
          artifactWorkflowPath: readback.workflowPath,
          artifactRunId: readback.runId,
          artifactRunAttempt: readback.runAttempt,
          artifactId: readback.artifactId,
          artifactName: readback.artifactName,
          artifactDigest: readback.artifactDigest,
          requestHash,
          idempotencyKey: input.idempotencyKey,
          observedBy: input.actor,
        },
      });
      await tx.auditLog.create({
        data: {
          actorLogin: input.actor,
          action: "control-plane.workflow-bundle.candidate.import",
          entityType: "WorkflowBundleRegistryRecord",
          entityId: created.id,
          payload: {
            registryId: REGISTRY_ID,
            subject,
            sourceSha: bundle.source.sha,
            payloadDigest: bundle.integrity.payloadDigest,
            runId: readback.runId.toString(),
            artifactId: readback.artifactId.toString(),
            artifactDigest: readback.artifactDigest,
          },
        },
      });
      return created;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const concurrent = await client.workflowBundleRegistryRecord.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (concurrent) {
        assertReplayHash(concurrent.requestHash, requestHash);
        return { record: concurrent, duplicate: true };
      }
    }
    throw error;
  }
  return { record, duplicate: false };
}

export async function importWorkflowBundleApproval(input: {
  bundle: Record<string, unknown>;
  idempotencyKey: string;
  actor: string;
}, client: WorkflowBundleRegistryClient = prisma, dependencies = defaultDependencies()) {
  const verified = verifyApprovedBundle(input.bundle, dependencies.trustedApprovalKeysJson);
  const requestHash = jsonDigest({
    mode: "APPROVED",
    payloadDigest: verified.approved.integrity.payloadDigest,
    approvalPayloadDigest: verified.approvalPayloadDigest,
  });
  const replay = await client.workflowBundleRegistryRecord.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (replay) {
    assertReplayHash(replay.requestHash, requestHash);
    return { record: replay, duplicate: true };
  }
  const candidateRecord = await client.workflowBundleRegistryRecord.findFirst({
    where: {
      registryId: REGISTRY_ID,
      subject: verified.envelope.subject,
      approvalState: "CANDIDATE",
      sourceSha: verified.approved.source.sha,
      workflowExecutionSha: verified.approved.source.workflowExecutionSha,
      payloadDigest: verified.candidate.integrity.payloadDigest,
    },
  });
  if (
    !candidateRecord
    || candidateRecord.contractDigestsDigest !== verified.envelope.contractDigestsDigest
    || candidateRecord.runtimeAssetDigestsDigest !== verified.envelope.runtimeAssetDigestsDigest
    || candidateRecord.artifactRepository !== REGISTRY_REPOSITORY
    || candidateRecord.artifactWorkflowPath !== CANDIDATE_WORKFLOW_PATH
    || !candidateRecord.artifactDigest
  ) {
    fail("승인 대상 candidate의 durable GitHub artifact readback이 없습니다.", "WORKFLOW_BUNDLE_CANDIDATE_READBACK_MISSING");
  }
  const approvalSlot = jsonDigest({
    registryId: REGISTRY_ID,
    subject: verified.envelope.subject,
    state: "APPROVED",
  });
  let record;
  try {
    record = await client.$transaction(async (tx) => {
      const created = await tx.workflowBundleRegistryRecord.create({
        data: {
          registryId: REGISTRY_ID,
          subject: verified.envelope.subject,
          approvalState: "APPROVED",
          sourceSha: verified.approved.source.sha,
          workflowExecutionSha: verified.approved.source.workflowExecutionSha,
          bundleVersion: verified.approved.bundleVersion,
          payloadDigest: verified.approved.integrity.payloadDigest,
          candidateDigest: verified.candidate.integrity.payloadDigest,
          contractDigestsDigest: verified.envelope.contractDigestsDigest,
          runtimeAssetDigestsDigest: verified.envelope.runtimeAssetDigestsDigest,
          evidenceDigest: verified.envelope.evidenceDigest,
          approvalPayloadDigest: verified.approvalPayloadDigest,
          approvalKeyId: verified.approved.approval.signature.keyId,
          approvalPolicyRevision: verified.approved.approval.signature.policyRevision,
          bundle: verified.approved as unknown as Prisma.InputJsonValue,
          approvalSlot,
          requestHash,
          idempotencyKey: input.idempotencyKey,
          observedBy: input.actor,
        },
      });
      await tx.auditLog.create({
        data: {
          actorLogin: input.actor,
          action: "control-plane.workflow-bundle.approval.import",
          entityType: "WorkflowBundleRegistryRecord",
          entityId: created.id,
          payload: {
            registryId: REGISTRY_ID,
            subject: verified.envelope.subject,
            sourceSha: verified.approved.source.sha,
            payloadDigest: verified.approved.integrity.payloadDigest,
            candidateDigest: verified.candidate.integrity.payloadDigest,
            approvalPayloadDigest: verified.approvalPayloadDigest,
            keyId: verified.approved.approval.signature.keyId,
            policyRevision: verified.approved.approval.signature.policyRevision,
          },
        },
      });
      return created;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const concurrent = await client.workflowBundleRegistryRecord.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (concurrent) {
        assertReplayHash(concurrent.requestHash, requestHash);
        return { record: concurrent, duplicate: true };
      }
    }
    throw error;
  }
  return { record, duplicate: false };
}

export function verifyWorkflowBundleRegistryReadback(input: {
  approvalState: "CANDIDATE" | "APPROVED";
  registryId: string;
  subject: string;
  sourceSha: string;
  workflowExecutionSha: string;
  bundleVersion: string;
  payloadDigest: string;
  candidateDigest: string | null;
  contractDigestsDigest: string;
  runtimeAssetDigestsDigest: string;
  evidenceDigest: string | null;
  approvalPayloadDigest: string | null;
  approvalKeyId: string | null;
  approvalPolicyRevision: string | null;
  artifactRepository: string | null;
  artifactRepositoryId: bigint | null;
  artifactWorkflowPath: string | null;
  artifactRunId: bigint | null;
  artifactRunAttempt: number | null;
  artifactId: bigint | null;
  artifactName: string | null;
  artifactDigest: string | null;
  approvalSlot: string | null;
  requestHash: string;
  bundle: unknown;
}, trustedApprovalKeysJson: string): WorkflowBundleV5Registry {
  if (
    input.registryId !== REGISTRY_ID
    || input.subject !== `workflow-bundle-v5:${input.sourceSha}`
    || input.sourceSha !== input.workflowExecutionSha
  ) {
    fail("WorkflowBundle registry identity가 일치하지 않습니다.", "WORKFLOW_BUNDLE_REGISTRY_PROVENANCE_INVALID");
  }
  if (input.approvalState === "CANDIDATE") {
    const bundle = assertBundleIntegrity(input.bundle);
    const expectedRequestHash = jsonDigest({
      mode: "CANDIDATE",
      sourceSha: input.sourceSha,
      runId: input.artifactRunId?.toString() ?? "",
      runAttempt: input.artifactRunAttempt,
      artifactId: input.artifactId?.toString() ?? "",
    });
    if (
      bundle.approval.state !== "CANDIDATE"
      || bundle.source.sha !== input.sourceSha
      || bundle.bundleVersion !== input.bundleVersion
      || bundle.integrity.payloadDigest !== input.payloadDigest
      || digestMap(bundle.quality.contractDigests) !== input.contractDigestsDigest
      || digestMap(bundle.quality.runtimeAssetDigests) !== input.runtimeAssetDigestsDigest
      || input.candidateDigest !== null
      || input.evidenceDigest !== null
      || input.approvalPayloadDigest !== null
      || input.approvalKeyId !== null
      || input.approvalPolicyRevision !== null
      || input.artifactRepository !== REGISTRY_REPOSITORY
      || input.artifactRepositoryId !== BigInt(REGISTRY_REPOSITORY_ID)
      || input.artifactWorkflowPath !== CANDIDATE_WORKFLOW_PATH
      || !input.artifactRunId
      || input.artifactRunId <= 0n
      || !input.artifactRunAttempt
      || input.artifactRunAttempt <= 0
      || !input.artifactId
      || input.artifactId <= 0n
      || input.artifactName !== `workflow-bundle-v5-candidate-${input.sourceSha}`
      || !SHA256.test(input.artifactDigest ?? "")
      || input.approvalSlot !== null
      || input.requestHash !== expectedRequestHash
    ) {
      fail("Candidate registry artifact provenance가 일치하지 않습니다.", "WORKFLOW_BUNDLE_REGISTRY_PROVENANCE_INVALID");
    }
    return bundle;
  }
  const verified = verifyApprovedBundle(input.bundle, trustedApprovalKeysJson);
  const expectedApprovalSlot = jsonDigest({
    registryId: REGISTRY_ID,
    subject: verified.envelope.subject,
    state: "APPROVED",
  });
  const expectedRequestHash = jsonDigest({
    mode: "APPROVED",
    payloadDigest: verified.approved.integrity.payloadDigest,
    approvalPayloadDigest: verified.approvalPayloadDigest,
  });
  if (
    verified.approved.source.sha !== input.sourceSha
    || verified.approved.bundleVersion !== input.bundleVersion
    || verified.approved.integrity.payloadDigest !== input.payloadDigest
    || verified.candidate.integrity.payloadDigest !== input.candidateDigest
    || verified.envelope.contractDigestsDigest !== input.contractDigestsDigest
    || verified.envelope.runtimeAssetDigestsDigest !== input.runtimeAssetDigestsDigest
    || verified.envelope.evidenceDigest !== input.evidenceDigest
    || verified.approvalPayloadDigest !== input.approvalPayloadDigest
    || verified.approved.approval.signature.keyId !== input.approvalKeyId
    || verified.approved.approval.signature.policyRevision !== input.approvalPolicyRevision
    || input.artifactRepository !== null
    || input.artifactRepositoryId !== null
    || input.artifactWorkflowPath !== null
    || input.artifactRunId !== null
    || input.artifactRunAttempt !== null
    || input.artifactId !== null
    || input.artifactName !== null
    || input.artifactDigest !== null
    || input.approvalSlot !== expectedApprovalSlot
    || input.requestHash !== expectedRequestHash
  ) {
    fail("APPROVED registry 서명 provenance가 저장 readback과 일치하지 않습니다.", "WORKFLOW_BUNDLE_REGISTRY_PROVENANCE_INVALID");
  }
  return verified.approved;
}

export async function readWorkflowBundleRegistryRecords(
  sourceSha: string | null,
  client: WorkflowBundleRegistryClient = prisma,
) {
  return client.workflowBundleRegistryRecord.findMany({
    where: {
      registryId: REGISTRY_ID,
      ...(sourceSha === null ? {} : { sourceSha }),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export function publicWorkflowBundleRegistryRecord(record: {
  id: string;
  approvalState: "CANDIDATE" | "APPROVED";
  sourceSha: string;
  workflowExecutionSha: string;
  payloadDigest: string;
  candidateDigest: string | null;
  approvalKeyId: string | null;
  approvalPolicyRevision: string | null;
  artifactRunId: bigint | null;
  artifactId: bigint | null;
  artifactDigest: string | null;
  createdAt: Date;
}) {
  return {
    id: record.id,
    approvalState: record.approvalState,
    sourceSha: record.sourceSha,
    workflowExecutionSha: record.workflowExecutionSha,
    payloadDigest: record.payloadDigest,
    candidateDigest: record.candidateDigest,
    approvalKeyId: record.approvalKeyId,
    approvalPolicyRevision: record.approvalPolicyRevision,
    artifactRunId: record.artifactRunId?.toString() ?? null,
    artifactId: record.artifactId?.toString() ?? null,
    artifactDigest: record.artifactDigest,
    createdAt: record.createdAt.toISOString(),
  };
}

export const WORKFLOW_BUNDLE_V5_REGISTRY = {
  id: REGISTRY_ID,
  repository: REGISTRY_REPOSITORY,
  repositoryId: REGISTRY_REPOSITORY_ID,
  candidateWorkflowPath: CANDIDATE_WORKFLOW_PATH,
} as const;
