import assert from "node:assert/strict";
import test from "node:test";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  buildStaticRuntimeManifestReadback,
  StaticRuntimeManifestError,
  type StaticRuntimeManifestInput,
} from "@/lib/control-plane/static-runtime-manifest";

function input(overrides: Partial<StaticRuntimeManifestInput> = {}): StaticRuntimeManifestInput {
  return {
    lifecycleState: "ACTIVE",
    repositoryId: "7001",
    fullName: "seorilabs/runtime-canary",
    bindingSourceSha: "a".repeat(40),
    applicationSourceSha: "b".repeat(40),
    observationId: "observation-runtime-1",
    observationRequestHash: "1".repeat(64),
    configRevisionId: "config-runtime-1",
    configRevision: 7,
    configRevisionPayloadHash: "2".repeat(64),
    signedSnapshotDigest: "3".repeat(64),
    snapshotSignature: "4".repeat(64),
    snapshotSignatureKeyId: "control-plane-snapshot-v1",
    snapshotSignaturePolicyRevision: "snapshot-policy-v1",
    staticBinding: {
      profile: "capacitor",
      packageManager: "pnpm",
      workspaceRoot: "app",
      commandDirectory: "app",
    },
    ...overrides,
  };
}

test("runtime readback은 raw HMAC 없이 exact source/config/binding digest만 반환한다", () => {
  const result = buildStaticRuntimeManifestReadback(input());
  assert.equal(result.state, "VERIFIED");
  assert.equal(result.manifest.sourceSha, "a".repeat(40));
  assert.equal(result.applicationSourceSha, "b".repeat(40));
  assert.equal(result.manifest.observationDigest, `sha256:${"1".repeat(64)}`);
  assert.equal(result.manifest.configRevisionDigest, `sha256:${"2".repeat(64)}`);
  assert.equal(result.manifest.signedSnapshotDigest, `sha256:${"3".repeat(64)}`);
  assert.notEqual(result.manifest.snapshotSignature.digest, `sha256:${"4".repeat(64)}`);
  assert.doesNotMatch(JSON.stringify(result), /4444444444444444444444444444444444444444444444444444444444444444/);
  assert.equal(
    result.manifestDigest,
    `sha256:${jsonDigest(result.manifest as JsonValue)}`,
  );
});

test("공개 signer identity 또는 provenance digest가 없으면 fail-closed한다", () => {
  for (const invalid of [
    input({ snapshotSignatureKeyId: "" }),
    input({ snapshotSignaturePolicyRevision: "unsafe value" }),
    input({ observationRequestHash: "1".repeat(63) }),
    input({ snapshotSignature: "not-a-signature" }),
  ]) {
    assert.throws(
      () => buildStaticRuntimeManifestReadback(invalid),
      StaticRuntimeManifestError,
    );
  }
});
