import assert from "node:assert/strict";
import test from "node:test";

import { platformFleetDisposition } from "@/lib/control-plane/platform-fleet-policy";

const CONTRACT_REVISION = `sha256:${"1".repeat(64)}`;

function artifact(version: string) {
  return {
    kind: "GDSCRIPT" as const,
    version,
    digest: `sha256:${"2".repeat(64)}`,
    treeChecksum: "3".repeat(64),
    releaseAssetUrl: `https://github.com/seorilabs/platform/releases/download/v${version}/a.tar.gz`,
  };
}

function observation(observedVersion: string) {
  return {
    schemaVersion: 1 as const,
    sourceSha: "4".repeat(40),
    integration: "SDK" as const,
    artifactKind: "GDSCRIPT" as const,
    observedVersion,
    observedDigest: `sha256:${"9".repeat(64)}`,
    contractRevision: CONTRACT_REVISION,
    treeChecksum: "8".repeat(64),
    releaseAssetUrl: "https://example.invalid/a.tar.gz",
    evidenceDigest: "5".repeat(64),
  };
}

function dispose(observedVersion: string, approvedVersion: string) {
  return platformFleetDisposition({
    classification: "IMPLEMENTATION_ONLY",
    contractRevision: CONTRACT_REVISION,
    artifact: artifact(approvedVersion),
    observation: observation(observedVersion) as never,
  });
}

test("승인본보다 앞선 저장소는 SDK 갱신이 아니라 remediation으로 간다", () => {
  // 미발행 draft를 벤더링하면 이 상태가 된다. SDK_UPDATE_PR로 두면 더 낮은 버전으로
  // 갱신하라고 지시하게 되고, 실제 조치(릴리스 발행 또는 되돌리기)가 드러나지 않는다.
  const result = dispose("0.7.8", "0.7.6");
  assert.equal(result.kind, "AHEAD_UNMANAGED");
  assert.equal(result.status, "PENDING");
  assert.equal(result.bindingState, "AHEAD_OF_APPROVED_RELEASE_PENDING");
});

test("뒤처진 저장소는 그대로 SDK 갱신이다", () => {
  const result = dispose("0.7.3", "0.7.6");
  assert.equal(result.kind, "SDK_UPDATE_PR");
  assert.equal(result.bindingState, "UPDATE_PR_QUEUED");
});

test("major·minor 자리도 자릿수가 아니라 수로 비교한다", () => {
  // 문자열 비교면 "0.10.0" < "0.9.0"이 되어 앞선 저장소를 놓친다.
  assert.equal(dispose("0.10.0", "0.9.0").kind, "AHEAD_UNMANAGED");
  assert.equal(dispose("0.9.0", "0.10.0").kind, "SDK_UPDATE_PR");
  assert.equal(dispose("1.0.0", "0.99.99").kind, "AHEAD_UNMANAGED");
});

test("같은 버전이면서 내용이 다르면 앞섰다고 보지 않는다", () => {
  // digest·treeChecksum 불일치는 갱신 대상이지 승인본을 앞선 상태가 아니다.
  assert.equal(dispose("0.7.6", "0.7.6").kind, "SDK_UPDATE_PR");
});

test("해석할 수 없는 버전은 앞섰다고 단정하지 않는다", () => {
  // 판정 불가를 앞섬으로 취급하면 정상 갱신 대상이 remediation으로 새어 나간다.
  for (const version of ["0.7", "0.7.6-rc.1", "", "abc"]) {
    assert.equal(dispose(version, "0.7.6").kind, "SDK_UPDATE_PR", version);
  }
});

test("계약 추가 릴리스는 버전 비교보다 먼저 계약 이슈로 간다", () => {
  const result = platformFleetDisposition({
    classification: "CONTRACT_ADDITION" as never,
    contractRevision: CONTRACT_REVISION,
    artifact: artifact("0.7.6"),
    observation: observation("0.7.8") as never,
  });
  assert.equal(result.kind, "CONTRACT_ISSUE");
});
