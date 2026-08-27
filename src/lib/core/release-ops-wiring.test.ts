import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  excludeHistoricalReleaseMarkers,
  isHistoricalReleaseMarker,
} from "@/lib/core/release-marker-history";

// release-ops 는 prisma/octokit 을 직접 잡고 있어 단위 실행 대상이 아니다. 대신 코어 계약
// (release-orchestrator / release-source-contract)을 실제로 경유하는지, 우회 경로가 남아 있지
// 않은지를 배선 수준에서 고정한다. 코어 자체의 동작은 release-orchestrator.test.ts 가 검증한다.

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function bodyOf(text: string, name: string): string {
  const start = text.indexOf(`export async function ${name}(`);
  assert.ok(start !== -1, `${name} 가 없습니다`);
  const rest = text.slice(start);
  const end = rest.indexOf("\n}\n");
  assert.ok(end !== -1, `${name} 본문 끝을 찾지 못했습니다`);
  return rest.slice(0, end);
}

const RELEASE_OPS = "src/lib/core/release-ops.ts";
const ORCHESTRATOR = "src/lib/core/release-orchestrator.ts";

// 인수조건: 마커 생성 코드는 없고, 과거 마커 읽기 호환만 남는다.
test("마커 생성 코드는 없고 과거 마커 읽기 호환만 남는다", () => {
  for (const path of [
    "src/lib/core/release-marker.ts",
    "src/lib/core/release-marker.test.ts",
  ]) {
    assert.equal(existsSync(join(process.cwd(), path)), false, `${path} 가 남아 있습니다`);
  }

  for (const path of [RELEASE_OPS, ORCHESTRATOR, "src/lib/github/write.ts"]) {
    const text = source(path);
    assert.equal(text.includes("pushReleaseMarkerCommit"), false, path);
    assert.equal(text.includes("releaseMarkerMessage"), false, path);
    assert.equal(text.includes("shouldPushReleaseMarker"), false, path);
  }

  // 읽기 호환 모듈은 제외 함수만 노출하고 마커 메시지를 만들지 않는다.
  const history = source("src/lib/core/release-marker-history.ts");
  assert.equal(history.includes("export function releaseMarkerMessage"), false);
  assert.match(history, /export function excludeHistoricalReleaseMarkers/);
});

// 인수조건: 과거 release marker 는 출시노트 집계에서 계속 제외된다.
test("과거 chore(release) 커밋은 출시노트 집계에서 계속 제외된다", () => {
  assert.equal(isHistoricalReleaseMarker("chore(release): v1.3.2"), true);
  // 제목이 아닌 본문에 접두사가 있으면 마커가 아니다.
  assert.equal(
    isHistoricalReleaseMarker("fix: 태그 정리\n\nchore(release): v1.0.0 참고"),
    false,
  );
  assert.equal(isHistoricalReleaseMarker("chore: 의존성 정리"), false);

  assert.deepEqual(
    excludeHistoricalReleaseMarkers([
      "환불 검토 운영 화면 추가 (#77)",
      "chore(release): v1.3.2",
      "fix: 태그 동기화 지연 대응 (#72)",
    ]),
    ["환불 검토 운영 화면 추가 (#77)", "fix: 태그 동기화 지연 대응 (#72)"],
  );

  // compareTags 읽기 경로에 실제로 연결돼 있다.
  const release = source("src/lib/github/release.ts");
  assert.match(
    bodyOf(release, "compareTags"),
    /excludeHistoricalReleaseMarkers\(/,
  );
});

// 인수조건: createReleaseTagWithNotes 는 SHA 확정·검증·write 순서를 코어에 위임한다.
test("createReleaseTagWithNotes 는 계약 코어를 경유해서만 태그와 Release 를 만든다", () => {
  const body = bodyOf(source(RELEASE_OPS), "createReleaseTagWithNotes");

  assert.match(body, /await previewStableRelease\(\{/);
  assert.match(body, /await createReleaseTagAtSource\(\{/);
  // default branch 는 하드코딩하지 않는다.
  assert.match(body, /getRepoDefaultBranch\(opts\.repoFullName\)/);
  // confirm 단계는 preview 가 고정한 SHA 를 다시 검증한다.
  assert.match(body, /expectedSha: opts\.expectedSha \?\? candidate\.sha/);
  // SHA 확정은 코어가 한다. 여기서 따로 잡으면 검증 대상과 태그 대상이 갈라진다.
  assert.equal(body.includes("await resolveRefSha("), false);
  assert.match(body, /createTag: \(input\) => createTag\(\{ repoFullName: opts\.repoFullName, \.\.\.input \}\)/);

  const core = bodyOf(source(ORCHESTRATOR), "createReleaseTagAtSource");
  const resolve = core.indexOf("opts.source.resolveRefSha(");
  const expected = core.indexOf("opts.expectedSha !== sha");
  const read = core.indexOf("opts.source.readReleaseSourceFiles(sha)");
  const verify = core.indexOf("assertReleaseSourceContract({");
  const tag = core.indexOf("opts.writer.createTag(");
  const release = core.indexOf("opts.writer.createOrUpdateRelease(");
  assert.ok([resolve, expected, read, verify, tag, release].every((index) => index !== -1));
  assert.ok(resolve < expected && expected < read && read < verify && verify < tag && tag < release);
});

// 인수조건: marketVersionFloor 는 다음 태그 추천 경로에만 남는다.
test("marketVersionFloor 는 추천 경로에만 쓰이고 배포 허가에는 쓰이지 않는다", () => {
  const text = source(RELEASE_OPS);

  assert.equal(text.includes("assertTagAtOrAboveMarketFloor"), false);
  assert.equal(
    source("src/lib/core/market-version-floor.ts").includes("assertTagAtOrAboveMarketFloor"),
    false,
  );

  // 추천 경로에만 남아 있다.
  assert.match(bodyOf(text, "previewNextTag"), /marketVersionFloor\(repoFullName\)/);
  const bumped = text.slice(text.indexOf("async function bumpedCandidateTag("));
  assert.ok(bumped.length > 0, "bumpedCandidateTag 가 없습니다");
  assert.match(bumped.slice(0, bumped.indexOf("\n}\n")), /resolveReleaseTagWithMarketFloor\(\{/);
  // 배포 dispatch 경로에는 floor 가 전혀 등장하지 않는다.
  const deploy = bodyOf(text, "dispatchMarketDeploy");
  assert.equal(deploy.includes("marketVersionFloor"), false);
  assert.equal(deploy.includes("MarketFloor"), false);
  assert.match(deploy, /await planMarketDeploy\(\{/);
  assert.match(deploy, /await executeMarketDeployPlan\(\{/);
});

// 인수조건: preflight 실패 뒤 부분 ReleaseRecord 가 남지 않고, Xcode Cloud 가 마지막이다.
test("ReleaseRecord 는 preflight 통과 뒤 마지막 Xcode Cloud 실행에서만 만들어진다", () => {
  for (const path of [RELEASE_OPS, ORCHESTRATOR]) {
    assert.equal(source(path).includes("releaseRecord."), false, `${path} 가 ReleaseRecord 를 직접 쓴다`);
  }

  const xcode = source("src/lib/xcode-cloud/release.ts");
  assert.match(xcode, /prisma\.releaseRecord\.upsert\(/);

  // 계획 수립(planMarketDeploy)에는 write 포트 호출이 없다.
  const plan = bodyOf(source(ORCHESTRATOR), "planMarketDeploy");
  assert.equal(plan.includes("dispatchWorkflow("), false);
  assert.equal(plan.includes("dispatchXcodeCloudRelease("), false);
  assert.match(plan, /validateXcodeCloudRelease\(/);
  assert.match(plan, /assertReleaseSourceContract\(\{/);

  // 실행은 GitHub 먼저, Xcode Cloud 마지막.
  const execute = bodyOf(source(ORCHESTRATOR), "executeMarketDeployPlan");
  const github = execute.indexOf("dispatchWorkflow(plan.github)");
  const xcodeCall = execute.indexOf("dispatchXcodeCloudRelease({ tag: plan.xcodeCloud.tag })");
  assert.ok(github !== -1 && xcodeCall !== -1);
  assert.ok(github < xcodeCall, "GitHub dispatch 가 Xcode Cloud 보다 먼저여야 한다");
});

// 인수조건: audit payload 에는 검증된 tag SHA 와 실제 dispatch 결과만 남는다.
test("배포 audit payload 는 검증된 SHA 와 실제 실행 결과만 기록한다", () => {
  const deploy = bodyOf(source(RELEASE_OPS), "dispatchMarketDeploy");
  const payload = deploy.slice(deploy.indexOf("payload: {"), deploy.indexOf("} as object"));

  assert.match(payload, /tag: result\.contract\.tag/);
  assert.match(payload, /sha: result\.sha/);
  assert.match(payload, /workflowFile: result\.workflowFile \?\? null/);
  assert.match(payload, /xcodeCloudBuild: result\.xcodeCloudBuild \?\? null/);
  // 요청값을 그대로 신뢰해 기록하지 않는다.
  assert.equal(payload.includes("tag: opts.tag"), false);
});
