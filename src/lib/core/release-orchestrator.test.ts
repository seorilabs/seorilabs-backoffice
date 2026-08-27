import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { DeployTarget } from "@/lib/core/deploy-targets";
import {
  createReleaseTagAtSource,
  dispatchMarketDeployAtTag,
  planMarketDeploy,
  previewStableRelease,
  type MarketDispatchPort,
  type ReleaseSourcePort,
  type ReleaseTagPort,
} from "@/lib/core/release-orchestrator";
import {
  ReleaseSourceContractError,
  type ReleaseSourceFiles,
} from "@/lib/core/release-source-contract";

const REPO = "seorilabs/lizard-tycoon";
const BRANCH_HEAD = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const MOVED_HEAD = "9f8e7d6c5b4a39281706f5e4d1a2b3c4d5e6f708";

function godot(version: string): string {
  return `[application]\n\nconfig/version="${version}"\n`;
}

/** lizard-tycoon 실제 구조: pinned-source 계약을 선언한 Godot repo. */
function pinned(input: {
  project: string;
  play: string;
  appStore: string;
  sha?: string;
}): ReleaseSourceFiles {
  return {
    sha: input.sha ?? BRANCH_HEAD,
    hasContractScript: true,
    hasTagDerivedScript: false,
    godotProject: { path: "project.godot", text: godot(input.project) },
    googlePlay: { release: { versionName: input.play } },
    appStore: { release: { appleMarketingVersion: input.appStore } },
  };
}

function alignedAt(version: string, sha = BRANCH_HEAD): ReleaseSourceFiles {
  return pinned({ project: version, play: version, appStore: version, sha });
}

/** 장애 fixture: 태그는 v1.2.0 인데 소스 세 원장은 모두 1.1.12. */
const LIZARD_DRIFT = alignedAt("1.1.12");

function rnTagDerived(sha = BRANCH_HEAD): ReleaseSourceFiles {
  return {
    sha,
    hasContractScript: false,
    hasTagDerivedScript: true,
    godotProject: null,
    googlePlay: { release: { versionName: "1.8.1" } },
    appStore: { release: { appleMarketingVersion: "1.8.1" } },
  };
}

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
  sha?: string;
  declared?: Set<string>;
  dispatchable?: boolean;
  failDispatchWith?: Error;
  failXcodeValidateWith?: Error;
}

/** 외부 write 호출을 이름과 인자로 모두 기록한다. */
function harness(files: ReleaseSourceFiles, options: HarnessOptions = {}) {
  const sha = options.sha ?? files.sha;
  const calls: string[] = [];
  const createTagArgs: Array<{ tag: string; sha: string }> = [];
  const dispatched: Array<{ workflowFile: string; ref: string; inputs: Record<string, string> }> =
    [];
  const xcodeRuns: string[] = [];

  const source: ReleaseSourcePort = {
    async resolveRefSha(ref) {
      calls.push(`resolveRefSha:${ref}`);
      return sha;
    },
    async readReleaseSourceFiles(readSha) {
      calls.push(`readReleaseSourceFiles:${readSha}`);
      return { ...files, sha: readSha };
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

  const WRITES = ["createTag", "createOrUpdateRelease", "dispatchWorkflow", "dispatchXcodeCloudRelease"];
  const writeCalls = () => calls.filter((name) => WRITES.includes(name));

  return { calls, writeCalls, createTagArgs, dispatched, xcodeRuns, source, writer, dispatcher };
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

// ── 1. stable tag 생성 ──

// 인수조건: 태그는 검증한 source SHA 를 직접 가리키고, branch update·marker commit 이 없다.
test("stable 태그는 source SHA 를 직접 가리키고 branch write 가 없다", async () => {
  const h = harness(alignedAt("1.2.0"));

  const result = await createRelease(h, "v1.2.0");

  assert.equal(result.sha, BRANCH_HEAD);
  assert.deepEqual(h.createTagArgs, [{ tag: "v1.2.0", sha: BRANCH_HEAD }]);
  assert.deepEqual(h.calls, [
    "resolveRefSha:main",
    `readReleaseSourceFiles:${BRANCH_HEAD}`,
    "createTag",
    "createOrUpdateRelease",
  ]);
});

test("릴리스 경로에 branch ref 갱신과 marker commit 생성 코드가 없다", () => {
  for (const path of [
    "src/lib/core/release-orchestrator.ts",
    "src/lib/core/release-ops.ts",
    "src/lib/github/write.ts",
  ]) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    assert.equal(source.includes("git.updateRef"), false, path);
    assert.equal(source.includes("git.createCommit"), false, path);
    assert.equal(source.includes("pushReleaseMarkerCommit"), false, path);
    assert.equal(source.includes("releaseMarkerMessage"), false, path);
  }
});

// 인수조건(장애 fixture): 태그 v1.2.0 / 소스 1.1.12 면 tag·release write 가 모두 0회.
test("Lizard v1.2.0 태그와 소스 1.1.12 는 tag·release write 0회로 막힌다", async () => {
  const h = harness(LIZARD_DRIFT);

  await assert.rejects(() => createRelease(h, "v1.2.0"), ReleaseSourceContractError);

  assert.deepEqual(h.writeCalls(), []);
  assert.equal(h.createTagArgs.length, 0);
});

test("소스 버전과 후보 태그가 다르면 오류 메시지에 두 값이 모두 담긴다", async () => {
  const h = harness(LIZARD_DRIFT);
  let message = "";
  try {
    await createRelease(h, "v1.2.0");
  } catch (error) {
    assert.ok(error instanceof ReleaseSourceContractError);
    message = error.message;
  }
  assert.match(message, /tag=1\.2\.0/);
  assert.match(message, /source=1\.1\.12/);
  assert.deepEqual(h.writeCalls(), []);
});

// 인수조건: preview 에서 고정한 SHA 가 confirm 시점에 달라지면 write 없이 중단한다.
test("확인 뒤 default branch HEAD 가 움직이면 tag·release write 가 0회다", async () => {
  const h = harness(alignedAt("1.2.0", MOVED_HEAD), { sha: MOVED_HEAD });

  await assert.rejects(
    () => createRelease(h, "v1.2.0", BRANCH_HEAD),
    ReleaseSourceContractError,
  );

  assert.deepEqual(h.writeCalls(), []);
});

// 인수조건: bump 로 source 에 없는 버전을 만들지 않는다.
test("pinned-source repo 는 bump 후보 대신 소스 버전을 후보 태그로 쓴다", async () => {
  const h = harness(alignedAt("1.1.12"));

  const candidate = await previewStableRelease({
    repoFullName: REPO,
    targetRef: "main",
    latestTag: "v1.1.12",
    bumpedTag: "v1.1.13",
    source: h.source,
  });

  assert.equal(candidate.tag, "v1.1.12");
  assert.equal(candidate.contract, "pinned-source");
  assert.equal(candidate.sourceVersion, "1.1.12");
  assert.equal(candidate.bumpIgnored, true);
  assert.equal(candidate.sha, BRANCH_HEAD);
  assert.deepEqual(h.writeCalls(), []);
});

test("pinned-source repo 에 소스와 다른 태그를 지정하면 후보 계산에서 막힌다", async () => {
  const h = harness(alignedAt("1.1.12"));

  await assert.rejects(
    () =>
      previewStableRelease({
        repoFullName: REPO,
        targetRef: "main",
        latestTag: "v1.1.12",
        explicitTag: "v1.2.0",
        bumpedTag: "v1.1.13",
        source: h.source,
      }),
    /지정한 태그가 소스 버전과 다릅니다/,
  );
  assert.deepEqual(h.writeCalls(), []);
});

test("소스 원장이 없는 repo 는 기존대로 bump 후보를 쓴다", async () => {
  const h = harness(rnTagDerived());

  const candidate = await previewStableRelease({
    repoFullName: "seorilabs/happy-farm",
    targetRef: "main",
    latestTag: "v1.8.5",
    bumpedTag: "v1.8.6",
    source: h.source,
  });

  assert.equal(candidate.tag, "v1.8.6");
  assert.equal(candidate.contract, "tag-derived");
  assert.equal(candidate.sourceVersion, null);
  assert.equal(candidate.bumpIgnored, false);
});

// ── 2. 배포 preflight ──

// 인수조건: preflight 실패 시 GitHub·Xcode write 가 모두 0회.
for (const target of ["PLAY", "AIT", "ALL", "APPSTORE"] as const) {
  test(`소스 불일치 태그의 ${target} 배포는 GitHub·Xcode write 0회로 막힌다`, async () => {
    const h = harness(LIZARD_DRIFT);

    await assert.rejects(() => deploy(h, target, "v1.2.0", true), ReleaseSourceContractError);

    assert.deepEqual(h.writeCalls(), []);
    assert.deepEqual(h.dispatched, []);
    assert.deepEqual(h.xcodeRuns, []);
  });
}

test("workflow_dispatch 선언이 없으면 GitHub·Xcode write 0회로 막힌다", async () => {
  const h = harness(alignedAt("1.2.0"), { dispatchable: false });

  await assert.rejects(() => deploy(h, "ALL", "v1.2.0", true), /workflow_dispatch 선언이 없습니다/);

  assert.deepEqual(h.writeCalls(), []);
});

test("caller 가 선언하지 않은 입력이 필요하면 dispatch 전에 막힌다", async () => {
  // Google Play 업로드 토글이 하나도 선언되지 않은 구버전 태그.
  const h = harness(alignedAt("1.2.0"), { declared: new Set(["release_tag"]) });

  await assert.rejects(() => deploy(h, "PLAY", "v1.2.0"), /업로드 토글 입력이 없습니다/);

  assert.deepEqual(h.writeCalls(), []);
});

// 인수조건: Xcode Cloud 계약 검증도 외부 write 앞이다.
test("Xcode Cloud workflow·태그 조건 검증이 실패하면 GitHub dispatch 도 하지 않는다", async () => {
  const h = harness(alignedAt("1.2.0"), {
    failXcodeValidateWith: new Error("Xcode Cloud workflow 선택 실패"),
  });

  await assert.rejects(() => deploy(h, "ALL", "v1.2.0", true), /Xcode Cloud workflow 선택 실패/);

  assert.deepEqual(h.writeCalls(), []);
  assert.equal(h.calls.includes("validateXcodeCloudRelease"), true);
});

// 인수조건: ALL 에서 GitHub dispatch 가 실패하면 Xcode Cloud write 가 0회.
test("ALL 에서 GitHub dispatch 가 422 로 거부되면 Xcode Cloud write 가 0회다", async () => {
  const rejected = Object.assign(new Error("Unprocessable Entity"), { status: 422 });
  const h = harness(alignedAt("1.2.0"), { failDispatchWith: rejected });

  await assert.rejects(() => deploy(h, "ALL", "v1.2.0", true), /Unprocessable Entity/);

  assert.deepEqual(h.xcodeRuns, []);
  assert.equal(h.calls.includes("dispatchXcodeCloudRelease"), false);
  assert.deepEqual(h.writeCalls(), ["dispatchWorkflow"]);
});

// 인수조건: 정상 ALL 은 모든 preflight 뒤 GitHub 먼저, Xcode Cloud 마지막.
test("정상 ALL 은 preflight 전부 → GitHub dispatch → Xcode Cloud 순서다", async () => {
  const h = harness(alignedAt("1.2.0"));

  const result = await deploy(h, "ALL", "v1.2.0", true);

  assert.equal(result.workflowFile, "deploy-all.yml");
  assert.equal(result.xcodeCloudBuild, 15);
  assert.deepEqual(h.calls, [
    "resolveRefSha:v1.2.0",
    `readReleaseSourceFiles:${BRANCH_HEAD}`,
    "getWorkflowDispatchContract",
    "validateXcodeCloudRelease",
    "dispatchWorkflow",
    "dispatchXcodeCloudRelease",
  ]);
  // 마지막 두 개가 write 이고, GitHub 이 Xcode Cloud 보다 앞이다.
  assert.deepEqual(h.writeCalls(), ["dispatchWorkflow", "dispatchXcodeCloudRelease"]);
});

// 인수조건: APPSTORE 단독도 preflight 통과 후에만 ciBuildRuns 를 만든다.
test("APPSTORE 단독은 preflight 전부 통과 후에만 Xcode Cloud 를 실행한다", async () => {
  const h = harness(alignedAt("1.2.0"));

  const result = await deploy(h, "APPSTORE", "v1.2.0", true);

  assert.equal(result.workflowFile, undefined);
  assert.equal(result.xcodeCloudBuild, 15);
  assert.deepEqual(h.calls, [
    "resolveRefSha:v1.2.0",
    `readReleaseSourceFiles:${BRANCH_HEAD}`,
    "validateXcodeCloudRelease",
    "dispatchXcodeCloudRelease",
  ]);
  assert.deepEqual(h.writeCalls(), ["dispatchXcodeCloudRelease"]);
});

test("planMarketDeploy 는 외부 write 없이 계획만 만든다", async () => {
  const h = harness(alignedAt("1.2.0"));

  const plan = await planMarketDeploy({
    repoFullName: REPO,
    target: "ALL",
    tag: "v1.2.0",
    iosViaXcodeCloud: true,
    source: h.source,
    dispatcher: h.dispatcher,
  });

  assert.deepEqual(h.writeCalls(), []);
  assert.equal(plan.sha, BRANCH_HEAD);
  assert.deepEqual(plan.github?.inputs, { release_tag: "v1.2.0", deploy_app_store: "false" });
  assert.deepEqual(plan.xcodeCloud, { tag: "v1.2.0" });
});

// 인수조건: 기존 RN tag-derived 배포 경로는 그대로 동작한다.
test("RN tag-derived repo 의 PLAY 배포는 업로드 입력까지 채워 dispatch 한다", async () => {
  const h = harness(rnTagDerived());

  const result = await deploy(h, "PLAY", "v1.8.6");

  assert.equal(result.contract.kind, "tag-derived");
  assert.deepEqual(h.dispatched[0].inputs, {
    release_tag: "v1.8.6",
    upload: "true",
    track: "internal",
    release_status: "completed",
    version_name: "1.8.6",
  });
});
