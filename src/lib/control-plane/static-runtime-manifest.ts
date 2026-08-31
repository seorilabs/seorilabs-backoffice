import crypto from "node:crypto";
import type { DependencyAuditException } from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

const HEX_64 = /^[0-9a-f]{64}$/;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

export class StaticRuntimeManifestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type StaticRuntimeBinding = {
  profile: "react-native" | "capacitor" | "ait-web";
  packageManager: "npm" | "pnpm";
  workspaceRoot: string;
  commandDirectory: string;
} | {
  profile: "godot";
  packageManager: null;
  workspaceRoot: string;
  commandDirectory: string;
};

export interface StaticRuntimeManifestInput {
  lifecycleState: "ACTIVE" | "PAUSED" | "DEPRECATED";
  repositoryId: string;
  fullName: string;
  bindingSourceSha: string;
  sourceRef: string;
  applicationSourceSha: string;
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
  dependencyAuditException?: DependencyAuditException;
}

function sha256Prefix(value: string): string {
  if (!HEX_64.test(value)) {
    throw new StaticRuntimeManifestError("INVALID_RUNTIME_DIGEST");
  }
  return `sha256:${value}`;
}

function signatureDigest(value: string): string {
  if (!HEX_64.test(value)) {
    throw new StaticRuntimeManifestError("INVALID_CONFIG_SIGNATURE");
  }
  return `sha256:${crypto.createHash("sha256").update(Buffer.from(value, "hex")).digest("hex")}`;
}

export function buildStaticRuntimeManifestReadback(input: StaticRuntimeManifestInput) {
  if (
    !["react-native", "capacitor", "ait-web", "godot"].includes(input.staticBinding.profile)
    || (input.staticBinding.profile === "godot"
      ? input.staticBinding.packageManager !== null
      : !["npm", "pnpm"].includes(input.staticBinding.packageManager))
  ) {
    throw new StaticRuntimeManifestError("INVALID_STATIC_BINDING");
  }
  if (!input.sourceRef.startsWith("refs/heads/")) {
    throw new StaticRuntimeManifestError("INVALID_SOURCE_REF");
  }
  if (
    !PUBLIC_ID.test(input.snapshotSignatureKeyId)
    || !PUBLIC_ID.test(input.snapshotSignaturePolicyRevision)
  ) {
    throw new StaticRuntimeManifestError("SNAPSHOT_SIGNATURE_IDENTITY_MISSING");
  }
  const manifest = {
    schemaVersion: 1 as const,
    lifecycleState: input.lifecycleState,
    repositoryId: input.repositoryId,
    fullName: input.fullName,
    sourceSha: input.bindingSourceSha,
    sourceRef: input.sourceRef,
    observationId: input.observationId,
    observationDigest: sha256Prefix(input.observationRequestHash),
    configRevisionId: input.configRevisionId,
    configRevision: input.configRevision,
    configRevisionDigest: sha256Prefix(input.configRevisionPayloadHash),
    signedSnapshotDigest: sha256Prefix(input.signedSnapshotDigest),
    snapshotSignature: {
      keyId: input.snapshotSignatureKeyId,
      policyRevision: input.snapshotSignaturePolicyRevision,
      digest: signatureDigest(input.snapshotSignature),
    },
    staticBinding: input.staticBinding,
    ...(input.dependencyAuditException
      ? { dependencyAuditException: input.dependencyAuditException }
      : {}),
  };
  return {
    schemaVersion: 1 as const,
    state: "VERIFIED" as const,
    repositoryId: input.repositoryId,
    fullName: input.fullName,
    bindingSourceSha: input.bindingSourceSha,
    applicationSourceSha: input.applicationSourceSha,
    manifestDigest: `sha256:${jsonDigest(manifest as JsonValue)}`,
    manifest,
  };
}
