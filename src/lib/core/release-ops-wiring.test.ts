import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

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

// 인수조건 AC-5: pushReleaseMarkerCommit 과 release-marker 모듈/테스트가 저장소에 남지 않는다.
test("release-marker 모듈과 테스트, 마커 push 함수가 저장소에 없다", () => {
  for (const path of [
    "src/lib/core/release-marker.ts",
    "src/lib/core/release-marker.test.ts",
  ]) {
    assert.equal(existsSync(join(process.cwd(), path)), false, `${path} 가 남아 있습니다`);
  }

  for (const path of [RELEASE_OPS, ORCHESTRATOR, "src/lib/github/write.ts", "src/lib/github/release.ts"]) {
    const text = source(path);
    assert.equal(text.includes("pushReleaseMarkerCommit"), false, path);
    assert.equal(text.includes("release-marker"), false, path);
    assert.equal(text.includes("excludeReleaseMarkers"), false, path);
  }
});

// 인수조건 AC-6: createReleaseTagWithNotes 는 SHA 확정·계약 검증·write 순서를 코어에 위임한다.
test("createReleaseTagWithNotes 는 계약 코어를 경유해서만 태그와 Release 를 만든다", () => {
  const body = bodyOf(source(RELEASE_OPS), "createReleaseTagWithNotes");

  assert.match(body, /await createReleaseTagAtSource\(\{/);
  // SHA 확정은 코어가 1회만 한다. 여기서 따로 잡으면 검증 대상과 태그 대상이 갈라진다.
  assert.equal(body.includes("await resolveRefSha("), false);
  // createTag / createOrUpdateRelease 는 코어에 주입되는 writer 포트로만 노출된다.
  assert.match(body, /createTag: \(input\) => createTag\(\{ repoFullName: opts\.repoFullName, \.\.\.input \}\)/);
  assert.match(body, /createOrUpdateRelease: \(input\) =>/);
  assert.match(body, /source: releaseSourcePort\(opts\.repoFullName\)/);

  const core = bodyOf(source(ORCHESTRATOR), "createReleaseTagAtSource");
  const resolve = core.indexOf("opts.source.resolveRefSha(");
  const read = core.indexOf("opts.source.readReleaseSourceFiles(sha)");
  const verify = core.indexOf("assertReleaseSourceContract({");
  const tag = core.indexOf("opts.writer.createTag(");
  const release = core.indexOf("opts.writer.createOrUpdateRelease(");
  assert.ok(resolve !== -1 && read !== -1 && verify !== -1 && tag !== -1 && release !== -1);
  assert.ok(resolve < read && read < verify && verify < tag && tag < release);
});

// 인수조건 AC-8: marketVersionFloor 는 다음 태그 추천 경로에만 남는다.
test("marketVersionFloor 는 추천 경로에만 쓰이고 배포 허가에는 쓰이지 않는다", () => {
  const text = source(RELEASE_OPS);

  // floor 기반 배포 가드는 제거됐다.
  assert.equal(text.includes("assertTagAtOrAboveMarketFloor"), false);
  assert.equal(source("src/lib/core/market-version-floor.ts").includes("assertTagAtOrAboveMarketFloor"), false);

  // 추천 경로(previewNextTag / 태그 계산)에만 남아 있다.
  assert.match(bodyOf(text, "previewNextTag"), /marketVersionFloor\(repoFullName\)/);
  assert.match(
    bodyOf(text, "createReleaseTagWithNotes"),
    /resolveReleaseTagWithMarketFloor\(\{/,
  );
  // 배포 dispatch 경로에는 floor 가 전혀 등장하지 않는다.
  const deploy = bodyOf(text, "dispatchMarketDeploy");
  assert.equal(deploy.includes("marketVersionFloor"), false);
  assert.equal(deploy.includes("MarketFloor"), false);
  assert.match(deploy, /await dispatchMarketDeployAtTag\(\{/);
});

// 인수조건 AC-12: 실패한 preflight 뒤에 부분 ReleaseRecord 가 남지 않는다.
test("ReleaseRecord 는 preflight 통과 뒤 Xcode Cloud 트리거 경로에서만 만들어진다", () => {
  for (const path of [RELEASE_OPS, ORCHESTRATOR]) {
    const text = source(path);
    assert.equal(text.includes("releaseRecord."), false, `${path} 가 ReleaseRecord 를 직접 쓴다`);
  }

  // 유일한 생성 지점은 Xcode Cloud dispatch 안이고, 오케스트레이터는 검증 뒤에만 그것을 호출한다.
  const xcode = source("src/lib/xcode-cloud/release.ts");
  assert.match(xcode, /prisma\.releaseRecord\.upsert\(/);

  const core = bodyOf(source(ORCHESTRATOR), "dispatchMarketDeployAtTag");
  const verify = core.indexOf("assertReleaseSourceContract({");
  const xcodeCall = core.indexOf("opts.dispatcher.dispatchXcodeCloudRelease(");
  const dispatch = core.indexOf("opts.dispatcher.dispatchWorkflow(");
  assert.ok(verify !== -1 && xcodeCall !== -1 && dispatch !== -1);
  assert.ok(verify < xcodeCall, "소스 검증이 Xcode Cloud 트리거보다 먼저여야 한다");
  assert.ok(verify < dispatch, "소스 검증이 workflow dispatch 보다 먼저여야 한다");
});
