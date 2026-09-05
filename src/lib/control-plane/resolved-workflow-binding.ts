import { createHash } from "node:crypto";
import { z } from "zod";

import { contractCanonicalJson, type JsonValue } from "@/lib/control-plane/json";
import type { AndroidBuildBindingObservation } from "@/lib/control-plane/contracts";
import {
  sha256Prefix,
  signatureDigest,
  type StaticRuntimeBinding,
} from "@/lib/control-plane/static-runtime-manifest";

/**
 * 중앙 계약 `contracts/workflow-bundle-v5-resolved-binding.schema.json`이 정의하는 문서다.
 * 계약은 additionalProperties=false로 읽으므로 관측 fact를 그대로 넘기면 거부된다. 이
 * 모듈은 규칙을 새로 만들지 않고 이미 검증된 fact를 계약 문서 형태로 투영만 한다.
 */
export class ResolvedWorkflowBindingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ResolvedWorkflowBindingError";
  }
}

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/u;
const SHA40 = /^[0-9a-f]{40}$/u;
// 계약 schema는 기본 브랜치를 main으로 고정한다. 다른 브랜치는 caller를 만들 수 없다.
const RESOLVED_BINDING_SOURCE_REF = "refs/heads/main";

export type ResolvedWorkflowBindingState = "ACTIVE" | "PAUSED" | "DEPRECATED";

export interface ResolvedWorkflowBindingInput {
  state: ResolvedWorkflowBindingState;
  repositoryId: string;
  fullName: string;
  sourceSha: string;
  sourceRef: string;
  observationId: string;
  observationRequestHash: string;
  configRevisionId: string;
  configRevision: number;
  configRevisionPayloadHash: string;
  signedSnapshotDigest: string;
  snapshotSignature: string;
  snapshotSignatureKeyId: string;
  snapshotSignaturePolicyRevision: string;
  staticBinding: StaticRuntimeBinding;
  buildBindings: readonly AndroidBuildBindingObservation[];
  workflowBundleBinding: { sourceSha: string; payloadDigest: string };
}

/** 관측 build binding에는 계약 문서가 받지 않는 packageManager가 있다. 투영에서 떨어뜨린다. */
function projectBuildBinding(binding: AndroidBuildBindingObservation) {
  return {
    target: binding.target,
    buildProfile: binding.buildProfile,
    executionRoot: binding.executionRoot,
    dependencyRoot: binding.dependencyRoot,
    scriptPath: binding.scriptPath,
    artifactKind: binding.artifactKind,
  };
}

export function buildResolvedWorkflowBindingReadback(input: ResolvedWorkflowBindingInput) {
  if (input.sourceRef !== RESOLVED_BINDING_SOURCE_REF) {
    throw new ResolvedWorkflowBindingError("RESOLVED_BINDING_SOURCE_REF_UNSUPPORTED");
  }
  if (!SHA40.test(input.sourceSha) || !SHA40.test(input.workflowBundleBinding.sourceSha)) {
    throw new ResolvedWorkflowBindingError("RESOLVED_BINDING_SOURCE_INVALID");
  }
  if (
    !PUBLIC_ID.test(input.snapshotSignatureKeyId)
    || !PUBLIC_ID.test(input.snapshotSignaturePolicyRevision)
  ) {
    throw new ResolvedWorkflowBindingError("SNAPSHOT_SIGNATURE_IDENTITY_MISSING");
  }
  if (!PUBLIC_ID.test(input.observationId) || !PUBLIC_ID.test(input.configRevisionId)) {
    throw new ResolvedWorkflowBindingError("RESOLVED_BINDING_PUBLIC_ID_INVALID");
  }
  if (!SHA256_PREFIXED.test(input.workflowBundleBinding.payloadDigest)) {
    throw new ResolvedWorkflowBindingError("RESOLVED_BINDING_BUNDLE_DIGEST_INVALID");
  }
  const snapshotSignature = {
    keyId: input.snapshotSignatureKeyId,
    policyRevision: input.snapshotSignaturePolicyRevision,
    digest: signatureDigest(input.snapshotSignature),
  };
  const manifest = {
    schemaVersion: 1 as const,
    state: input.state,
    repositoryId: input.repositoryId,
    fullName: input.fullName,
    sourceSha: input.sourceSha,
    sourceRef: input.sourceRef,
    observationId: input.observationId,
    observationDigest: sha256Prefix(input.observationRequestHash),
    configRevisionId: input.configRevisionId,
    configRevision: input.configRevision,
    configRevisionDigest: sha256Prefix(input.configRevisionPayloadHash),
    signedSnapshotDigest: sha256Prefix(input.signedSnapshotDigest),
    snapshotSignature,
    staticBinding: input.staticBinding,
    workflowBundleBinding: {
      sourceSha: input.workflowBundleBinding.sourceSha,
      payloadDigest: input.workflowBundleBinding.payloadDigest,
    },
    buildBindings: input.buildBindings.map(projectBuildBinding),
  };
  // 계약은 envelope 최상위 값과 manifest 안의 값을 다시 대조한다. 두 곳을 따로 계산하지
  // 않도록 manifest 하나에서 끌어올린다.
  return {
    schemaVersion: 1 as const,
    state: "VERIFIED" as const,
    repositoryId: manifest.repositoryId,
    fullName: manifest.fullName,
    sourceSha: manifest.sourceSha,
    // 계약이 manifestDigest를 code unit 정렬 canonical JSON으로 다시 계산한다.
    // localeCompare 정렬(jsonDigest)을 쓰면 두 구현이 조용히 다른 digest를 만든다.
    manifestDigest: `sha256:${createHash("sha256")
      .update(contractCanonicalJson(manifest as unknown as JsonValue))
      .digest("hex")}`,
    configRevisionId: manifest.configRevisionId,
    configRevision: manifest.configRevision,
    configRevisionDigest: manifest.configRevisionDigest,
    signedSnapshotDigest: manifest.signedSnapshotDigest,
    snapshotSignatureKeyId: manifest.snapshotSignature.keyId,
    snapshotSignaturePolicyRevision: manifest.snapshotSignature.policyRevision,
    snapshotSignatureDigest: manifest.snapshotSignature.digest,
    manifest,
  };
}

export type ResolvedWorkflowBindingReadback =
  ReturnType<typeof buildResolvedWorkflowBindingReadback>;

const safeDirectory = z.string().regex(
  /^(?:\.|[A-Za-z0-9_@-]+(?:\.[A-Za-z0-9_@-]+)*(?:\/[A-Za-z0-9_@-]+(?:\.[A-Za-z0-9_@-]+)*)*)$/u,
);
const publicId = z.string().regex(PUBLIC_ID);
const prefixedDigest = z.string().regex(SHA256_PREFIXED);
const commitSha = z.string().regex(SHA40);

const resolvedStaticBindingSchema = z.union([
  z.object({
    profile: z.enum(["react-native", "capacitor", "ait-web"]),
    packageManager: z.enum(["npm", "pnpm"]),
    workspaceRoot: safeDirectory,
    commandDirectory: safeDirectory,
  }).strict(),
  z.object({
    profile: z.literal("godot"),
    packageManager: z.null(),
    workspaceRoot: safeDirectory,
    commandDirectory: safeDirectory,
  }).strict(),
]);

const resolvedBuildBindingSchema = z.object({
  target: z.literal("android"),
  buildProfile: z.enum(["react-native-android", "godot-android", "capacitor-android"]),
  executionRoot: safeDirectory,
  dependencyRoot: safeDirectory,
  scriptPath: z.literal("scripts/build-android.sh"),
  artifactKind: z.literal("android-aab"),
}).strict();

/**
 * 실행기가 계약에 넘기는 envelope의 경계 schema다. 계약이 다시 검증하지만, 신뢰 실행기에
 * 실어 보내기 전에 Backoffice가 만든 문서 형태 그대로인지 여기서 먼저 고정한다.
 */
export const resolvedWorkflowBindingEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.literal("VERIFIED"),
  repositoryId: z.string().regex(/^[1-9][0-9]{0,31}$/u),
  fullName: z.string().regex(/^seorilabs\/[A-Za-z0-9._-]+$/u),
  sourceSha: commitSha,
  manifestDigest: prefixedDigest,
  configRevisionId: publicId,
  configRevision: z.number().int().positive(),
  configRevisionDigest: prefixedDigest,
  signedSnapshotDigest: prefixedDigest,
  snapshotSignatureKeyId: publicId,
  snapshotSignaturePolicyRevision: publicId,
  snapshotSignatureDigest: prefixedDigest,
  manifest: z.object({
    schemaVersion: z.literal(1),
    state: z.enum(["ACTIVE", "PAUSED", "DEPRECATED"]),
    repositoryId: z.string().regex(/^[1-9][0-9]{0,31}$/u),
    fullName: z.string().regex(/^seorilabs\/[A-Za-z0-9._-]+$/u),
    sourceSha: commitSha,
    sourceRef: z.literal(RESOLVED_BINDING_SOURCE_REF),
    observationId: publicId,
    observationDigest: prefixedDigest,
    configRevisionId: publicId,
    configRevision: z.number().int().positive(),
    configRevisionDigest: prefixedDigest,
    signedSnapshotDigest: prefixedDigest,
    snapshotSignature: z.object({
      keyId: publicId,
      policyRevision: publicId,
      digest: prefixedDigest,
    }).strict(),
    staticBinding: resolvedStaticBindingSchema,
    workflowBundleBinding: z.object({
      sourceSha: commitSha,
      payloadDigest: prefixedDigest,
    }).strict(),
    buildBindings: z.array(resolvedBuildBindingSchema).max(3),
  }).strict(),
}).strict();

export type ResolvedWorkflowBindingEnvelope = z.infer<
  typeof resolvedWorkflowBindingEnvelopeSchema
>;
