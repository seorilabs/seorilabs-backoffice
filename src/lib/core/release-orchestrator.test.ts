import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { DeployTarget } from "@/lib/core/deploy-targets";
import {
  createReleaseTagAtSource,
  dispatchMarketDeployAtTag,
  planMarketDeploy,
  previewStableRelease,
  type MarketDispatchPort,
  type ReleaseAuthorityPort,
  type ReleaseTagPort,
} from "@/lib/core/release-orchestrator";
import { StableReleaseAuthorityError } from "@/lib/core/stable-release-authority";

const REPO = "seorilabs/lizard-tycoon";
const BRANCH_HEAD = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const TAG_HEAD = "2a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const MOVED_HEAD = "9f8e7d6c5b4a39281706f5e4d1a2b3c4d5e6f708";

// Lizard 재현 입력. 이 값들은 stable 권한에 관여하지 않으며 어떤 reader에도 전달하지 않는다.
const STALE_LIZARD_FILES = Object.freeze({
  "scripts/check_release_version.py": "present",
  "project.godot": "1.2.1",
  "play-store/google-play.config.json": "1.2.1",
  "app-store/app-store.config.json": "1.2.1",
});

const ALL_INPUTS = new Set([
  "release_tag",
  "memo",
  "upload",
  "track",
  "release_status",
  "version_name",
  "deploy_app_store",
]);

interface HarnessOptions {
  branchSha?: string;
  tagSha?: string;
  declared?: Set<string>;
  dispatchable?: boolean;
  failDispatchWith?: Error;
  failXcodeValidateWith?: Error;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const createTagArgs: Array<{ tag: string; sha: string }> = [];
  const dispatched: Array<{ workflowFile: string; ref: string; inputs: Record<string, string> }> = [];
  const xcodeRuns: string[] = [];

  const source: ReleaseAuthorityPort = {
    async resolveRefSha(ref) {
      calls.push(`resolveRefSha:${ref}`);
      return options.branchSha ?? BRANCH_HEAD;
    },
    async resolveTagSha(tag) {
      calls.push(`resolveTagSha:${tag}`);
      return options.tagSha ?? TAG_HEAD;
    },
  };

  const writer: ReleaseTagPort = {
    async createTag(input) {
      calls.push("createTag");
      createTagArgs.push(input);
      return { created: true };
    },
    async createOrUpdateRelease(input) {
      calls.push("createOrUpdateRelease");
      return { url: `https://github.com/${REPO}/releases/tag/${input.tag}`, id: 1 };
    },
  };

  const dispatcher: MarketDispatchPort = {
    async getWorkflowDispatchContract() {
      calls.push("getWorkflowDispatchContract");
      return {
        dispatchable: options.dispatchable ?? true,
        inputNames: options.declared ?? ALL_INPUTS,
      };
    },
    async dispatchWorkflow(input) {
      calls.push("dispatchWorkflow");
      if (options.failDispatchWith) throw options.failDispatchWith;
      dispatched.push(input);
    },
    async validateXcodeCloudRelease() {
      calls.push("validateXcodeCloudRelease");
      if (options.failXcodeValidateWith) throw options.failXcodeValidateWith;
    },
    async dispatchXcodeCloudRelease(input) {
      calls.push("dispatchXcodeCloudRelease");
      xcodeRuns.push(input.tag);
      return { buildNumber: 15 };
    },
  };

  const writes = () => calls.filter((name) => [
    "createTag",
    "createOrUpdateRelease",
    "dispatchWorkflow",
    "dispatchXcodeCloudRelease",
  ].includes(name));

  return { calls, writes, createTagArgs, dispatched, xcodeRuns, source, writer, dispatcher };
}

type Harness = ReturnType<typeof harness>;

function createRelease(h: Harness, tag: string, expectedSha?: string) {
  return createReleaseTagAtSource({
    repoFullName: REPO,
    tag,
    targetRef: "main",
    expectedSha,
    releaseBody: (created) => `Release ${created}`,
    source: h.source,
    writer: h.writer,
  });
}

function deploy(h: Harness, target: DeployTarget, tag: string, iosViaXcodeCloud = false) {
  return dispatchMarketDeployAtTag({
    repoFullName: REPO,
    target,
    tag,
    iosViaXcodeCloud,
    source: h.source,
    dispatcher: h.dispatcher,
  });
}

test("stable 태그는 확인한 branch SHA를 직접 가리키고 branch write가 없다", async () => {
  const h = harness();
  const result = await createRelease(h, "v1.2.2");

  assert.equal(result.sha, BRANCH_HEAD);
  assert.equal(result.authority.kind, "github-stable-tag");
  assert.deepEqual(h.createTagArgs, [{ tag: "v1.2.2", sha: BRANCH_HEAD }]);
  assert.deepEqual(h.calls, ["resolveRefSha:main", "createTag", "createOrUpdateRelease"]);
});

test("릴리스 경로에 branch 갱신·marker commit·repo-local version reader가 없다", () => {
  for (const path of [
    "src/lib/core/release-orchestrator.ts",
    "src/lib/core/release-ops.ts",
    "src/lib/github/write.ts",
  ]) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    assert.doesNotMatch(source, /git\.(updateRef|createCommit)|pushReleaseMarkerCommit/u, path);
    assert.doesNotMatch(source, /readReleaseSourceFiles|check_release_version|project\.godot/u, path);
  }
  for (const path of [
    "src/lib/core/release-source-contract.ts",
    "src/lib/core/release-source-files.ts",
    "src/lib/github/release-source.ts",
  ]) {
    assert.equal(existsSync(join(process.cwd(), path)), false, path);
  }
});

test("Lizard의 stale 1.2.1 파일과 무관하게 bump v1.2.2와 explicit v1.2.2가 통과한다", async () => {
  assert.deepEqual(new Set(Object.values(STALE_LIZARD_FILES)), new Set(["present", "1.2.1"]));
  const h = harness();
  let obsoleteSourceReads = 0;
  const source = {
    ...h.source,
    async readReleaseSourceFiles() {
      obsoleteSourceReads += 1;
      return STALE_LIZARD_FILES;
    },
  };
  const bumped = await previewStableRelease({
    repoFullName: REPO,
    targetRef: "main",
    latestTag: "v1.2.1",
    bumpedTag: "v1.2.2",
    source,
  });
  const explicit = await previewStableRelease({
    repoFullName: REPO,
    targetRef: "main",
    latestTag: "v1.2.1",
    explicitTag: "v1.2.2",
    bumpedTag: "v9.9.9",
    source,
  });

  assert.equal(bumped.tag, "v1.2.2");
  assert.equal(explicit.tag, "v1.2.2");
  assert.equal(bumped.authority, "github-stable-tag");
  assert.equal(obsoleteSourceReads, 0);
  assert.deepEqual(h.writes(), []);
});

test("확인 뒤 default branch HEAD가 움직이면 tag·release write가 0회다", async () => {
  const h = harness({ branchSha: MOVED_HEAD });
  await assert.rejects(
    () => createRelease(h, "v1.2.2", BRANCH_HEAD),
    StableReleaseAuthorityError,
  );
  assert.deepEqual(h.writes(), []);
});

test("stable이 아닌 태그는 GitHub read·write 전에 거부한다", async () => {
  const h = harness();
  await assert.rejects(() => deploy(h, "ALL", "v1.2.2-snapshot.1"), /SemVer\(vX\.Y\.Z\)/u);
  assert.deepEqual(h.calls, []);
});

test("배포는 이름이 같은 branch가 아니라 exact tag ref의 peeled commit을 권한으로 쓴다", async () => {
  const h = harness({ branchSha: BRANCH_HEAD, tagSha: TAG_HEAD });
  const plan = await planMarketDeploy({
    repoFullName: REPO,
    target: "ALL",
    tag: "v1.2.2",
    iosViaXcodeCloud: false,
    source: h.source,
    dispatcher: h.dispatcher,
  });
  assert.equal(plan.sha, TAG_HEAD);
  assert.equal(plan.authority.sha, TAG_HEAD);
  assert.deepEqual(h.calls, ["resolveTagSha:v1.2.2", "getWorkflowDispatchContract"]);
  assert.deepEqual(h.writes(), []);
});

test("workflow_dispatch 선언이 없으면 GitHub·Xcode write 0회로 막힌다", async () => {
  const h = harness({ dispatchable: false });
  await assert.rejects(() => deploy(h, "ALL", "v1.2.2", true), /workflow_dispatch 선언이 없습니다/u);
  assert.deepEqual(h.writes(), []);
});

test("caller가 요구 입력을 선언하지 않으면 dispatch 전에 막힌다", async () => {
  const h = harness({ declared: new Set(["release_tag"]) });
  await assert.rejects(() => deploy(h, "PLAY", "v1.2.2"), /업로드 토글 입력이 없습니다/u);
  assert.deepEqual(h.writes(), []);
});

test("Xcode Cloud 계약 검증 실패는 GitHub dispatch도 만들지 않는다", async () => {
  const h = harness({ failXcodeValidateWith: new Error("Xcode Cloud workflow 선택 실패") });
  await assert.rejects(() => deploy(h, "ALL", "v1.2.2", true), /Xcode Cloud workflow 선택 실패/u);
  assert.deepEqual(h.writes(), []);
});

test("ALL의 GitHub dispatch 실패는 Xcode Cloud write 0회로 남는다", async () => {
  const h = harness({ failDispatchWith: Object.assign(new Error("Unprocessable Entity"), { status: 422 }) });
  await assert.rejects(() => deploy(h, "ALL", "v1.2.2", true), /Unprocessable Entity/u);
  assert.deepEqual(h.xcodeRuns, []);
  assert.deepEqual(h.writes(), ["dispatchWorkflow"]);
});

test("정상 ALL은 preflight 뒤 GitHub 먼저, Xcode Cloud 마지막이다", async () => {
  const h = harness();
  const result = await deploy(h, "ALL", "v1.2.2", true);
  assert.equal(result.workflowFile, "deploy-all.yml");
  assert.equal(result.xcodeCloudBuild, 15);
  assert.equal(result.authority.kind, "github-stable-tag");
  assert.deepEqual(h.calls, [
    "resolveTagSha:v1.2.2",
    "getWorkflowDispatchContract",
    "validateXcodeCloudRelease",
    "dispatchWorkflow",
    "dispatchXcodeCloudRelease",
  ]);
});

test("APPSTORE 단독은 exact tag preflight 뒤에만 Xcode Cloud를 실행한다", async () => {
  const h = harness();
  const result = await deploy(h, "APPSTORE", "v1.2.2", true);
  assert.equal(result.workflowFile, undefined);
  assert.equal(result.xcodeCloudBuild, 15);
  assert.deepEqual(h.calls, [
    "resolveTagSha:v1.2.2",
    "validateXcodeCloudRelease",
    "dispatchXcodeCloudRelease",
  ]);
});

test("PLAY 배포는 tag 파생 version_name과 업로드 입력을 채운다", async () => {
  const h = harness();
  await deploy(h, "PLAY", "v1.8.6");
  assert.deepEqual(h.dispatched[0].inputs, {
    release_tag: "v1.8.6",
    upload: "true",
    track: "internal",
    release_status: "completed",
    version_name: "1.8.6",
  });
});
