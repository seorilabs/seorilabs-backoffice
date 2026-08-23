import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSnapshotDefaultBranch,
  assertSnapshotShaUnchanged,
  assertSnapshotRegistryUnchanged,
  assertSnapshotTargetsUnchanged,
  buildSnapshotDeployInputs,
  buildSnapshotMarketInputs,
  SNAPSHOT_BRANCH,
  snapshotDeployTargetsFor,
  nextSnapshotCandidateTag,
  parseSnapshotCandidateTag,
  resolveSnapshotDeployDispatchRef,
  resolveSnapshotCandidateBase,
  selectSnapshotDeployTargets,
} from "@/lib/core/snapshot-candidate";

test("snapshot 소스 브랜치는 main으로 고정한다", () => {
  assert.equal(SNAPSHOT_BRANCH, "main");
  assert.doesNotThrow(() => assertSnapshotDefaultBranch("main"));
  assert.throws(() => assertSnapshotDefaultBranch("develop"), /기본 브랜치가 main이 아닙니다/);
});

test("확인 뒤 main HEAD나 내부 테스트 대상이 바뀌면 실행을 중단한다", () => {
  assert.doesNotThrow(() => assertSnapshotShaUnchanged("abc1234", "abc1234"));
  assert.throws(
    () => assertSnapshotShaUnchanged("abc1234", "def5678"),
    /main HEAD가 abc1234에서 def5678.*변경됐습니다/,
  );
  assert.doesNotThrow(() => {
    assertSnapshotTargetsUnchanged(
      ["AIT", "PLAY", "TESTFLIGHT"],
      ["AIT", "PLAY", "TESTFLIGHT"],
    );
  });
  assert.throws(
    () => assertSnapshotTargetsUnchanged(["AIT", "PLAY", "TESTFLIGHT"], ["AIT", "PLAY"]),
    /배포 대상이 변경됐습니다/,
  );
});

test("확인 뒤 저장소나 TestFlight bundle ID가 바뀌면 실행을 중단한다", () => {
  assert.doesNotThrow(() => assertSnapshotRegistryUnchanged({
    expectedRepoFullName: "seorilabs/saju-reader",
    currentRepoFullName: "seorilabs/saju-reader",
    expectedTargets: ["TESTFLIGHT"],
    expectedIosBundle: "com.seorilabs.ungeul",
    currentIosBundle: "com.seorilabs.ungeul",
  }));
  assert.throws(
    () => assertSnapshotRegistryUnchanged({
      expectedRepoFullName: "seorilabs/saju-reader",
      currentRepoFullName: "seorilabs/other",
      expectedTargets: ["PLAY"],
    }),
    /저장소가 변경/,
  );
  assert.throws(
    () => assertSnapshotRegistryUnchanged({
      expectedRepoFullName: "seorilabs/saju-reader",
      currentRepoFullName: "seorilabs/saju-reader",
      expectedTargets: ["TESTFLIGHT"],
      expectedIosBundle: "com.seorilabs.ungeul",
      currentIosBundle: "com.seorilabs.other",
    }),
    /bundle ID가 변경/,
  );
  assert.doesNotThrow(() => assertSnapshotRegistryUnchanged({
    expectedRepoFullName: "seorilabs/saju-reader",
    currentRepoFullName: "seorilabs/saju-reader",
    expectedTargets: ["PLAY"],
    expectedIosBundle: "com.seorilabs.ungeul",
    currentIosBundle: "com.seorilabs.other",
  }));
});

test("후보 태그는 마지막 stable SemVer에 snapshot 순번을 이어 붙인다", () => {
  assert.equal(
    nextSnapshotCandidateTag("v1.2.3", [
      "v1.2.3",
      "v1.2.3-snapshot.1",
      "v1.2.3-snapshot.3",
      "v1.2.2-snapshot.99",
      "legacy-10",
    ]),
    "v1.2.3-snapshot.4",
  );
  assert.deepEqual(parseSnapshotCandidateTag("v1.2.3-snapshot.4"), {
    baseTag: "v1.2.3",
    sequence: 4,
  });
  assert.equal(parseSnapshotCandidateTag("v1.2.3-snapshot.0"), null);
  assert.equal(parseSnapshotCandidateTag("v1.2.3-rc.1"), null);
});

test("workflow_run 추적을 위해 snapshot 후보 태그 ref에서 실행한다", () => {
  assert.equal(
    resolveSnapshotDeployDispatchRef("v1.2.3-snapshot.1"),
    "v1.2.3-snapshot.1",
  );
});

test("태그가 없으면 main package version을 쓰고 마켓 원장이 더 높으면 우선한다", () => {
  assert.equal(
    resolveSnapshotCandidateBase({ tags: [], packageVersion: "0.1.0" }),
    "v0.1.0",
  );
  assert.equal(
    resolveSnapshotCandidateBase({
      tags: ["v1.1.9", "legacy"],
      marketFloor: "v1.2.0",
      packageVersion: "1.0.0",
    }),
    "v1.2.0",
  );
  assert.throws(
    () => resolveSnapshotCandidateBase({ tags: ["legacy"], packageVersion: "next" }),
    /후보 버전/,
  );
});

test("표준·레거시 AIT caller에는 선언된 snapshot 배포 입력만 보낸다", () => {
  assert.deepEqual(
    buildSnapshotDeployInputs(
      new Set(["release_tag", "memo"]),
      "v1.2.3-snapshot.2",
      "1234567890abcdef",
    ),
    {
      release_tag: "v1.2.3-snapshot.2",
      memo: "snapshot candidate v1.2.3-snapshot.2 (1234567)",
    },
  );
  assert.deepEqual(
    buildSnapshotDeployInputs(
      new Set(["memo", "create_release_tag"]),
      "v0.1.0-snapshot.1",
      "abcdef0123456789",
    ),
    {
      memo: "snapshot candidate v0.1.0-snapshot.1 (abcdef0)",
      create_release_tag: "false",
    },
  );
});

test("Play 후보는 업로드를 강제하고 internal completed와 숫자 versionName만 보낸다", () => {
  assert.deepEqual(
    buildSnapshotMarketInputs(
      "PLAY",
      new Set([
        "release_tag",
        "upload",
        "track",
        "release_status",
        "version_name",
      ]),
      "v1.2.3-snapshot.2",
      "1234567890abcdef",
      {
        repoFullName: "seorilabs/example",
        workflowFile: "deploy-google-play.yml",
      },
    ),
    {
      release_tag: "v1.2.3-snapshot.2",
      upload: "true",
      track: "internal",
      release_status: "completed",
      version_name: "1.2.3",
    },
  );
});

test("등록된 마켓만 AIT·Play 내부·TestFlight 후보 대상으로 고정한다", () => {
  assert.deepEqual(
    snapshotDeployTargetsFor(["web", "appstore", "play", "ait"]),
    ["AIT", "PLAY", "TESTFLIGHT"],
  );
  assert.deepEqual(snapshotDeployTargetsFor(["web"]), []);
  assert.deepEqual(snapshotDeployTargetsFor(null), []);
});

test("deploy와 같은 선택값을 snapshot 내부 테스트 대상으로 변환한다", () => {
  const markets = ["web", "appstore", "play", "ait"];
  assert.deepEqual(selectSnapshotDeployTargets(markets, "AIT"), ["AIT"]);
  assert.deepEqual(selectSnapshotDeployTargets(markets, "PLAY"), ["PLAY"]);
  assert.deepEqual(selectSnapshotDeployTargets(markets, "APPSTORE"), ["TESTFLIGHT"]);
  assert.deepEqual(
    selectSnapshotDeployTargets(markets, "ALL"),
    ["AIT", "PLAY", "TESTFLIGHT"],
  );
});

test("선택한 snapshot 마켓만 등록 여부를 검사한다", () => {
  assert.deepEqual(selectSnapshotDeployTargets(["play"], "PLAY"), ["PLAY"]);
  assert.deepEqual(selectSnapshotDeployTargets(["play"], "ALL"), ["PLAY"]);
  assert.throws(
    () => selectSnapshotDeployTargets(["play"], "APPSTORE"),
    /TestFlight 내부 테스트가 등록되지 않아/,
  );
  assert.throws(
    () => selectSnapshotDeployTargets([], "ALL"),
    /등록 마켓이 없습니다/,
  );
});
