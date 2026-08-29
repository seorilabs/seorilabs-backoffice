import crypto from "node:crypto";

import type { AndroidBuildBindingObservation } from "@/lib/control-plane/contracts";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";

const HEX_64 = /^[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

export class BuildRuntimeManifestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface BuildRuntimeManifestInput {
  mode: "CANDIDATE" | "APPROVED";
  lifecycleState: "ACTIVE" | "PAUSED" | "DEPRECATED";
  repositoryId: string;
  fullName: string;
  applicationSourceSha: string;
  sourceRef: string;
  eventSourceSha: string;
  observationId: string;
  observationRequestHash: string;
  configRevisionId: string;
  configRevision: number;
  configRevisionPayloadHash: string;
  signedSnapshotDigest: string;
  snapshotSignature: string;
  snapshotSignatureKeyId: string;
  snapshotSignaturePolicyRevision: string;
  workflowBundleSourceSha: string;
  workflowBundlePayloadDigest: string;
  buildBinding: AndroidBuildBindingObservation;
}

function sha256Prefix(value: string): string {
  if (!HEX_64.test(value)) throw new BuildRuntimeManifestError("INVALID_RUNTIME_DIGEST");
  return `sha256:${value}`;
}

function signatureDigest(value: string): string {
  if (!HEX_64.test(value)) throw new BuildRuntimeManifestError("INVALID_CONFIG_SIGNATURE");
  return `sha256:${crypto.createHash("sha256").update(Buffer.from(value, "hex")).digest("hex")}`;
}

export function buildRuntimeManifestReadback(input: BuildRuntimeManifestInput) {
  if (!input.sourceRef.startsWith("refs/heads/")) {
    throw new BuildRuntimeManifestError("INVALID_SOURCE_REF");
  }
  if (
    !PUBLIC_ID.test(input.snapshotSignatureKeyId)
    || !PUBLIC_ID.test(input.snapshotSignaturePolicyRevision)
  ) {
    throw new BuildRuntimeManifestError("SNAPSHOT_SIGNATURE_IDENTITY_MISSING");
  }
  if (!SHA256.test(input.workflowBundlePayloadDigest)) {
    throw new BuildRuntimeManifestError("WORKFLOW_BUNDLE_DIGEST_INVALID");
  }
  const manifest = {
    schemaVersion: 1 as const,
    lifecycleState: input.lifecycleState,
    repositoryId: input.repositoryId,
    fullName: input.fullName,
    sourceSha: input.applicationSourceSha,
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
    workflowBundle: {
      sourceSha: input.workflowBundleSourceSha,
      payloadDigest: input.workflowBundlePayloadDigest,
      approvalState: input.mode,
      buildProfiles: ["react-native-android", "godot-android"],
    },
    buildBinding: input.buildBinding,
  };
  return {
    schemaVersion: 1 as const,
    state: "VERIFIED" as const,
    mode: input.mode,
    repositoryId: input.repositoryId,
    fullName: input.fullName,
    applicationSourceSha: input.applicationSourceSha,
    eventSourceSha: input.eventSourceSha,
    manifestDigest: `sha256:${jsonDigest(manifest as unknown as JsonValue)}`,
    manifest,
  };
}
