import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseStableSemVerTag } from "@/lib/core/stable-semver";

import {
  assertSnapshotCandidateTagUnchanged,
  assertSnapshotDefaultBranch,
  assertSnapshotShaUnchanged,
  assertSnapshotRegistryUnchanged,
  assertSnapshotTargetsUnchanged,
  buildSnapshotDeployInputs,
  buildSnapshotMarketInputs,
  SNAPSHOT_BRANCH,
  SNAPSHOT_MAX_SEQUENCE,
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

test("확인 뒤 stable·snapshot 태그가 생겨 다음 후보가 바뀌면 실행을 중단한다", () => {
  assert.doesNotThrow(() => {
    assertSnapshotCandidateTagUnchanged(
      "v1.2.4-snapshot.1",
      "v1.2.4-snapshot.1",
    );
  });
  assert.throws(
    () => assertSnapshotCandidateTagUnchanged(
      "v1.2.4-snapshot.1",
      "v1.2.4-snapshot.2",
    ),
    /다음 snapshot 후보가 v1\.2\.4-snapshot\.1에서 v1\.2\.4-snapshot\.2.*다시 요청/,
  );
  assert.throws(
    () => assertSnapshotCandidateTagUnchanged(
      "v1.2.4-snapshot.1",
      "v1.2.5-snapshot.1",
    ),
    /v1\.2\.5-snapshot\.1/,
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

test("후보 태그는 선택된 다음 patch base의 snapshot 순번만 이어 붙인다", () => {
  assert.equal(
    nextSnapshotCandidateTag("v1.2.4", [
      "v1.2.3",
      "v1.2.3-snapshot.1",
      "v1.2.3-snapshot.3",
      "v1.2.4-snapshot.2",
      "legacy-10",
    ]),
    "v1.2.4-snapshot.3",
  );
  assert.deepEqual(parseSnapshotCandidateTag("v1.2.3-snapshot.4"), {
    baseTag: "v1.2.3",
    sequence: 4,
  });
  assert.equal(parseSnapshotCandidateTag("v1.2.3-snapshot.0"), null);
  assert.equal(parseSnapshotCandidateTag("v1.2.3-snapshot.100"), null);
  assert.equal(parseSnapshotCandidateTag("v1.2.3-rc.1"), null);
});

test("snapshot 순번은 99까지만 허용하고 소진된 base는 fail-closed한다", () => {
  assert.equal(SNAPSHOT_MAX_SEQUENCE, 99);
  assert.equal(
    nextSnapshotCandidateTag("v1.2.4", ["v1.2.4-snapshot.98"]),
    "v1.2.4-snapshot.99",
  );
  assert.throws(
    () => nextSnapshotCandidateTag("v1.2.4", ["v1.2.4-snapshot.99"]),
    /v1\.2\.4 snapshot 순번 1\.\.99를 모두 사용.*다음 stable base/s,
  );
});

test("workflow_run 추적을 위해 snapshot 후보 태그 ref에서 실행한다", () => {
  assert.equal(
    resolveSnapshotDeployDispatchRef("v1.2.3-snapshot.1"),
    "v1.2.3-snapshot.1",
  );
});

test("공개 stable의 다음 patch를 후보 base로 사용한다", () => {
  assert.equal(
    nextSnapshotCandidateTag(
      resolveSnapshotCandidateBase({
        tags: ["v1.2.3"],
        packageVersion: "1.2.3",
      }),
      ["v1.2.3"],
    ),
    "v1.2.4-snapshot.1",
  );
});

test("package가 다음 patch를 이미 선언하면 이중 증가시키지 않는다", () => {
  assert.equal(
    resolveSnapshotCandidateBase({
      tags: ["v1.2.3"],
      packageVersion: "1.2.4",
    }),
    "v1.2.4",
  );
});

test("package가 공개 floor보다 높은 minor를 선언하면 그 버전을 후보 base로 쓴다", () => {
  assert.equal(
    resolveSnapshotCandidateBase({
      tags: ["v1.2.3"],
      marketFloor: "v1.2.2",
      packageVersion: "1.3.0",
    }),
    "v1.3.0",
  );
});

test("공개 stable이나 마켓 floor가 없는 초기 앱은 package version을 그대로 쓴다", () => {
  assert.equal(
    resolveSnapshotCandidateBase({ tags: [], packageVersion: "0.1.0" }),
    "v0.1.0",
  );
});

test("태그와 마켓 원장 중 높은 공개 floor의 다음 patch를 사용한다", () => {
  assert.equal(
    resolveSnapshotCandidateBase({
      tags: ["v1.1.9", "legacy"],
      marketFloor: "v1.2.0",
      packageVersion: "1.0.0",
    }),
    "v1.2.1",
  );
  assert.throws(
    () => resolveSnapshotCandidateBase({ tags: ["legacy"], packageVersion: "next" }),
    /후보 버전/,
  );
});

test("지원 caller에는 snapshot 후보 모드를 명시하고 선언된 입력만 보낸다", () => {
  assert.deepEqual(
    buildSnapshotDeployInputs(
      new Set(["snapshot_candidate", "release_tag", "memo"]),
      "v1.2.3-snapshot.2",
      "1234567890abcdef",
    ),
    {
      snapshot_candidate: "true",
      release_tag: "v1.2.3-snapshot.2",
      memo: "snapshot candidate v1.2.3-snapshot.2 (1234567)",
    },
  );
  assert.deepEqual(
    buildSnapshotDeployInputs(
      new Set(["snapshot_candidate", "memo", "create_release_tag"]),
      "v0.1.0-snapshot.1",
      "abcdef0123456789",
    ),
    {
      snapshot_candidate: "true",
      memo: "snapshot candidate v0.1.0-snapshot.1 (abcdef0)",
      create_release_tag: "false",
    },
  );
});

test("AIT 후보는 선언된 upload만 true로 강제해 비공개 업로드한다", () => {
  const context = {
    repoFullName: "seorilabs/saju-reader",
    workflowFile: "deploy-apps-in-toss.yml",
  };
  assert.deepEqual(
    buildSnapshotMarketInputs(
      "AIT",
      new Set(["snapshot_candidate", "release_tag", "upload"]),
      "v1.2.4-snapshot.1",
      "1234567890abcdef",
      context,
    ),
    {
      snapshot_candidate: "true",
      release_tag: "v1.2.4-snapshot.1",
      upload: "true",
    },
  );
  assert.deepEqual(
    buildSnapshotMarketInputs(
      "AIT",
      new Set(["snapshot_candidate", "release_tag"]),
      "v1.2.4-snapshot.1",
      "1234567890abcdef",
      context,
    ),
    {
      snapshot_candidate: "true",
      release_tag: "v1.2.4-snapshot.1",
    },
  );
});

test("Play 후보는 업로드를 강제하고 internal completed와 숫자 versionName만 보낸다", () => {
  assert.deepEqual(
    buildSnapshotMarketInputs(
      "PLAY",
      new Set([
        "snapshot_candidate",
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
      snapshot_candidate: "true",
      release_tag: "v1.2.3-snapshot.2",
      upload: "true",
      track: "internal",
      release_status: "completed",
      version_name: "1.2.3",
    },
  );
});

test("snapshot capability가 없으면 입력 생성 단계에서 거부한다", () => {
  assert.throws(
    () => buildSnapshotDeployInputs(
      new Set(["release_tag", "memo"]),
      "v1.2.4-snapshot.1",
      "1234567890abcdef",
    ),
    /snapshot_candidate 입력이 없어/,
  );
});

test("snapshot 태그는 stable 릴리스로 해석되지 않는다", () => {
  const tag = nextSnapshotCandidateTag("v1.2.4", []);
  assert.deepEqual(parseSnapshotCandidateTag(tag), {
    baseTag: "v1.2.4",
    sequence: 1,
  });
  assert.equal(parseStableSemVerTag(tag), null);
});

test("preview와 confirm은 exact SHA capability를 태그 생성 전에 검사한다", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/core/snapshot-deploy.ts"),
    "utf8",
  );
  const candidateStart = source.indexOf("async function candidateBaseContext");
  const prepareStart = source.indexOf("async function prepareGithubDeployPlans");
  const previewStart = source.indexOf("export async function previewSnapshotDeploy");
  const confirmStart = source.indexOf("export async function createAndDispatchSnapshotDeploy");
  const confirmEnd = source.indexOf("async function recordSnapshotDispatch");
  const candidateBody = source.slice(candidateStart, prepareStart);
  const prepareBody = source.slice(prepareStart, previewStart);
  const previewBody = source.slice(previewStart, confirmStart);
  const confirmBody = source.slice(confirmStart, confirmEnd);

  for (const path of [
    "play-store/google-play.config.json",
    "app-store/app-store.config.json",
    "package.json",
  ]) {
    assert.ok(candidateBody.includes(
      `getRepoJsonFile(repoFullName, "${path}", sourceRef)`,
    ));
  }
  assert.match(
    prepareBody,
    /getWorkflowDispatchContract\(\s*opts\.repoFullName,\s*workflowFile,\s*opts\.sha,\s*\)/,
  );

  const resolveShaIndex = previewBody.indexOf("const sha = await resolveRefSha");
  const candidateContextIndex = previewBody.indexOf(
    "candidateBaseContext(repoFullName, sha)",
  );
  assert.ok(resolveShaIndex >= 0);
  assert.ok(candidateContextIndex > resolveShaIndex);
  assert.ok(previewBody.indexOf("await prepareGithubDeployPlans") >= 0);
  const mutableStateReadIndex = confirmBody.indexOf(
    "const [latestSha, candidateContext] = await Promise.all",
  );
  const mutableStateReadEnd = confirmBody.indexOf("]);", mutableStateReadIndex) + 3;
  const latestShaReadIndex = confirmBody.indexOf(
    "resolveRefSha(opts.repoFullName, SNAPSHOT_BRANCH)",
    mutableStateReadIndex,
  );
  const candidateReadIndex = confirmBody.indexOf(
    "candidateBaseContext(opts.repoFullName, opts.expectedSha)",
    mutableStateReadIndex,
  );
  const latestShaAssertIndex = confirmBody.indexOf(
    "assertSnapshotShaUnchanged(opts.expectedSha, latestSha)",
  );
  const freshnessIndex = confirmBody.indexOf(
    "const currentCandidateTag = nextSnapshotCandidateTag",
  );
  const freshnessAssertIndex = confirmBody.indexOf(
    "assertSnapshotCandidateTagUnchanged(opts.tag, currentCandidateTag)",
  );
  const preflightIndex = confirmBody.indexOf("await prepareGithubDeployPlans");
  const xcodePreflightIndex = confirmBody.indexOf("await validateXcodeCloudDeploy");
  const createTagIndex = confirmBody.indexOf("await createTag");
  assert.ok(preflightIndex >= 0);
  assert.ok(xcodePreflightIndex > preflightIndex);
  assert.ok(mutableStateReadIndex > xcodePreflightIndex);
  assert.ok(latestShaReadIndex > mutableStateReadIndex);
  assert.ok(candidateReadIndex > mutableStateReadIndex);
  assert.ok(latestShaReadIndex < mutableStateReadEnd);
  assert.ok(candidateReadIndex < mutableStateReadEnd);
  assert.ok(latestShaAssertIndex >= mutableStateReadEnd);
  assert.ok(freshnessIndex > latestShaAssertIndex);
  assert.ok(freshnessAssertIndex > freshnessIndex);
  assert.ok(createTagIndex > freshnessAssertIndex);
  assert.equal(
    confirmBody.slice(mutableStateReadEnd, createTagIndex).includes("await "),
    false,
  );
  assert.match(
    confirmBody,
    /assertSnapshotCandidateTagUnchanged\(opts\.tag, currentCandidateTag\);\s*const \{ created \} = await createTag/,
  );
  assert.ok(confirmBody.includes("sha: opts.expectedSha"));
  assert.equal(confirmBody.includes("createOrUpdateRelease"), false);
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
