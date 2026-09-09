import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  platformFleetDisposition,
  platformFleetPolicyRevision,
} from "@/lib/control-plane/platform-fleet-policy";
import { managementStatusLabel } from "@/lib/control-plane/presentation";

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
  assert.equal(result.bindingState, "AHEAD_UNMANAGED_REMEDIATION_PENDING");
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

test("정책 개정판이 reconcile 멱등 키에 들어간다", () => {
  // 멱등 키가 {platformReleaseId, consumers}뿐이면 이미 판정된 조합은 결과를 영원히
  // replay한다. 그러면 정책을 바꿔도 기존 소비자에는 적용되지 않고, 이 개정을 만든
  // ahead 소비자가 옛 SDK_UPDATE_PR 계획에 그대로 남는다.
  const producer = readFileSync(
    join(process.cwd(), "src/lib/control-plane/platform-fleet-producer.ts"),
    "utf8",
  );
  assert.match(producer, /policyRevision: platformFleetPolicyRevision,/u);
  assert.match(platformFleetPolicyRevision, /^platform-fleet-policy-v\d+-[a-z-]+$/u);
});

test("AHEAD 상태는 생성 직후와 후속 reconcile에서 같은 이름을 쓴다", () => {
  // applyPlatformIssuePlan은 `${plan.kind}_REMEDIATION_ISSUE_OPEN`으로 저장하고
  // reconcile 분기는 별도 상수를 저장한다. 두 값이 다르면 같은 상태가 시점마다 다르게 관측된다.
  const fleet = readFileSync(
    join(process.cwd(), "src/lib/control-plane/platform-fleet.ts"),
    "utf8",
  );
  assert.match(fleet, /\? "AHEAD_UNMANAGED_REMEDIATION_ISSUE_OPEN"/u);
  assert.equal(
    /AHEAD_OF_APPROVED_RELEASE_(?:PENDING|ISSUE_OPEN)/u.test(fleet),
    false,
    "보간식과 다른 이름이 남아 있다",
  );
});

test("새 상태와 계획 종류에 한국어 표시명이 있다", () => {
  // 라벨이 없으면 운영 화면에 내부 영문 식별자가 그대로 노출된다.
  for (const value of [
    "AHEAD_UNMANAGED_REMEDIATION_PENDING",
    "AHEAD_UNMANAGED_REMEDIATION_ISSUE_OPEN",
    "AHEAD_UNMANAGED",
  ]) {
    const label = managementStatusLabel(value);
    assert.notEqual(label, value, `${value}에 표시명이 없다`);
    assert.match(label, /[가-힣]/u, `${value} 표시명이 한국어가 아니다`);
  }
});
