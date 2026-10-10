import assert from "node:assert/strict";
import test from "node:test";

import { platformSdkObservationFromDiscovery } from "@/lib/control-plane/platform-sdk-observation";

const SOURCE_SHA = "a".repeat(40);
const LOCK_INTEGRITY = `sha512-${"A".repeat(86)}==`;
const TREE_CHECKSUM = "b".repeat(64);

test("RN 소스의 exact SDK 버전과 lock 확인값을 그대로 보여 준다", () => {
  assert.deepEqual(platformSdkObservationFromDiscovery({
    platformConsumer: {
      schemaVersion: 1,
      sourceSha: SOURCE_SHA,
      integration: "SDK",
      artifactKind: "TYPESCRIPT",
      observedVersion: "0.6.5",
      observedDigest: null,
      contractRevision: null,
      evidenceDigest: "c".repeat(64),
      lockIntegrity: LOCK_INTEGRITY,
    },
  }), { integration: "SDK", artifactKind: "TYPESCRIPT", version: "0.6.5", checksum: LOCK_INTEGRITY });
});

test("Godot 애드온은 tree checksum을 확인값으로 쓴다", () => {
  assert.deepEqual(platformSdkObservationFromDiscovery({
    platformConsumer: {
      schemaVersion: 1,
      sourceSha: SOURCE_SHA,
      integration: "SDK",
      artifactKind: "GDSCRIPT",
      observedVersion: "0.7.8",
      observedDigest: null,
      contractRevision: null,
      evidenceDigest: "c".repeat(64),
      releaseAssetUrl: "https://github.com/seorilabs/platform/releases/download/v0.7.8/seorilabs-platform-gdscript-0.7.8.tar.gz",
      treeChecksum: TREE_CHECKSUM,
    },
  }), { integration: "SDK", artifactKind: "GDSCRIPT", version: "0.7.8", checksum: TREE_CHECKSUM });
});

test("버전을 확정할 수 없거나 SDK가 없으면 버전을 추측하지 않는다", () => {
  for (const integration of ["CUSTOM_HTTP", "MISSING"] as const) {
    assert.deepEqual(platformSdkObservationFromDiscovery({
      platformConsumer: { schemaVersion: 1, sourceSha: SOURCE_SHA, integration, evidenceDigest: "c".repeat(64) },
    }), { integration });
  }
});

test("탐지 전이거나 형식이 다른 payload는 null이다", () => {
  for (const payload of [
    null,
    [],
    {},
    { platformConsumer: null },
    { platformConsumer: { integration: "SDK", artifactKind: "TYPESCRIPT", observedVersion: "^0.6.0" } },
    { platformConsumer: { integration: "UNKNOWN" } },
  ]) {
    assert.equal(platformSdkObservationFromDiscovery(payload), null);
  }
});
