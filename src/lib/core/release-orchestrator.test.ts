import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { DeployTarget } from "@/lib/core/deploy-targets";
import {
  createReleaseTagAtSource,
  dispatchMarketDeployAtTag,
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

function godot(version: string): string {
  return `[application]\n\nconfig/version="${version}"\n`;
}

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

/** 외부 write 를 한 번도 하지 않는지 세는 기록용 포트 묶음. */
function harness(files: ReleaseSourceFiles, sha = BRANCH_HEAD) {
  const calls: string[] = [];
  const createTagArgs: Array<{ tag: string; sha: string }> = [];
  const dispatched: Array<{ workflowFile: string; ref: string; inputs: Record<string, string> }> =
    [];

  const source: ReleaseSourcePort = {
    async resolveRefSha(ref) {
      calls.push(`resolveRefSha:${ref}`);
      return sha;
    },
    async readReleaseSourceFiles(readSha) {
      calls.push(`readReleaseSourceFiles:${readSha}`);
      return files;
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
    async getWorkflowDispatchInputNames() {
      calls.push("getWorkflowDispatchInputNames");
      return new Set(["release_tag", "memo", "upload", "track", "release_status", "version_name"]);
    },
    async dispatchWorkflow(input) {
      calls.push("dispatchWorkflow");
      dispatched.push(input);
    },
    async dispatchXcodeCloudRelease() {
      calls.push("dispatchXcodeCloudRelease");
      return { buildNumber: 15 };
    },
  };

  const writeCalls = () =>
    calls.filter((name) =>
      ["createTag", "createOrUpdateRelease", "dispatchWorkflow", "dispatchXcodeCloudRelease"].includes(
        name,
      ),
    );

  return { calls, writeCalls, createTagArgs, dispatched, source, writer, dispatcher };
}

async function createRelease(h: ReturnType<typeof harness>, tag: string) {
  return createReleaseTagAtSource({
    repoFullName: REPO,
    tag,
    targetRef: "main",
    releaseBody: (created) => `Release ${created}`,
    source: h.source,
    writer: h.writer,
  });
}

async function dispatchDeploy(
  h: ReturnType<typeof harness>,
  target: DeployTarget,
  tag: string,
  iosViaXcodeCloud = false,
) {
  return dispatchMarketDeployAtTag({
    repoFullName: REPO,
    target,
    tag,
    iosViaXcodeCloud,
    source: h.source,
    dispatcher: h.dispatcher,
  });
}

// 인수조건: 실제 장애 재현 — 태그 v1.2.0, 소스 1.1.12 면 태그도 Release 도 만들지 않는다.
test("태그가 소스 버전보다 앞서면 태그·Release write 가 0회다", async () => {
  const h = harness(alignedAt("1.1.12"));

  await assert.rejects(() => createRelease(h, "v1.2.0"), ReleaseSourceContractError);

  assert.deepEqual(h.writeCalls(), []);
});

// 인수조건: 원장 세 개가 어긋난 소스는 태그 생성 자체가 막힌다.
test("원장 세 개가 서로 다르면 태그·Release write 가 0회다", async () => {
  const h = harness(pinned({ project: "1.2.0", play: "1.1.12", appStore: "1.1.11" }));

  await assert.rejects(() => createRelease(h, "v1.2.0"), ReleaseSourceContractError);

  assert.deepEqual(h.writeCalls(), []);
});

// 인수조건: 태그는 승인된 소스 SHA 를 직접 가리키고 브랜치는 움직이지 않는다.
test("정합한 소스면 태그가 원본 SHA 를 직접 가리킨다", async () => {
  const h = harness(alignedAt("1.2.0"));

  const result = await createRelease(h, "v1.2.0");

  assert.equal(result.sha, BRANCH_HEAD);
  assert.equal(result.contract.kind, "pinned-source");
  assert.deepEqual(h.createTagArgs, [{ tag: "v1.2.0", sha: BRANCH_HEAD }]);
  // 검증 → 태그 → Release 순서이고 그 사이에 브랜치 write 가 없다.
  assert.deepEqual(h.calls, [
    "resolveRefSha:main",
    `readReleaseSourceFiles:${BRANCH_HEAD}`,
    "createTag",
    "createOrUpdateRelease",
  ]);
});

// 인수조건: branch HEAD 불변 — 릴리스 경로에 브랜치 ref 갱신/커밋 생성 코드가 없다.
test("릴리스 태그 경로는 브랜치 ref 를 갱신하지 않는다", () => {
  const sources = [
    "src/lib/core/release-orchestrator.ts",
    "src/lib/core/release-ops.ts",
    "src/lib/github/write.ts",
  ].map((path) => readFileSync(join(process.cwd(), path), "utf8"));

  for (const source of sources) {
    assert.equal(source.includes("git.updateRef"), false);
    assert.equal(source.includes("git.createCommit"), false);
    assert.equal(source.includes("pushReleaseMarkerCommit"), false);
  }
});

// 인수조건: 이미 만들어진 잘못된 태그로 재시도해도 dispatch 전에 막힌다.
for (const target of ["PLAY", "AIT", "ALL"] as const) {
  test(`잘못된 태그의 ${target} 재시도는 dispatch 전에 막힌다`, async () => {
    const h = harness(alignedAt("1.1.12"));

    await assert.rejects(() => dispatchDeploy(h, target, "v1.2.0"), ReleaseSourceContractError);

    assert.deepEqual(h.writeCalls(), []);
    assert.deepEqual(h.dispatched, []);
  });
}

// 인수조건: ALL 은 Xcode Cloud 트리거보다 소스 검증이 먼저다.
test("ALL preflight 실패면 Xcode Cloud 와 GitHub dispatch 가 모두 0회다", async () => {
  const h = harness(alignedAt("1.1.12"));

  await assert.rejects(
    () => dispatchDeploy(h, "ALL", "v1.2.0", true),
    ReleaseSourceContractError,
  );

  assert.equal(h.calls.includes("dispatchXcodeCloudRelease"), false);
  assert.equal(h.calls.includes("dispatchWorkflow"), false);
  assert.deepEqual(h.writeCalls(), []);
});

test("정합한 소스의 ALL 은 검증 뒤에 Xcode Cloud 와 dispatch 를 실행한다", async () => {
  const h = harness(alignedAt("1.2.0"));

  const result = await dispatchDeploy(h, "ALL", "v1.2.0", true);

  assert.equal(result.xcodeCloudBuild, 15);
  assert.equal(result.workflowFile, "deploy-all.yml");
  assert.ok(
    h.calls.indexOf(`readReleaseSourceFiles:${BRANCH_HEAD}`) <
      h.calls.indexOf("dispatchXcodeCloudRelease"),
  );
  assert.equal(h.dispatched[0].ref, "v1.2.0");
});

// 인수조건: 기존 RN tag-derived 배포 경로는 그대로 동작한다.
test("RN tag-derived repo 의 PLAY 배포는 기존대로 업로드 입력까지 채워 dispatch 한다", async () => {
  const h = harness({
    sha: BRANCH_HEAD,
    hasContractScript: false,
    hasTagDerivedScript: true,
    godotProject: null,
    googlePlay: { release: { versionName: "1.8.1" } },
    appStore: { release: { appleMarketingVersion: "1.8.1" } },
  });

  const result = await dispatchDeploy(h, "PLAY", "v1.8.6");

  assert.equal(result.contract.kind, "tag-derived");
  assert.equal(result.workflowFile, "deploy-google-play.yml");
  assert.deepEqual(h.dispatched[0].inputs, {
    release_tag: "v1.8.6",
    upload: "true",
    track: "internal",
    release_status: "completed",
    version_name: "1.8.6",
  });
});

test("RN tag-derived repo 의 태그 생성은 마켓 config 값과 무관하게 진행된다", async () => {
  const h = harness({
    sha: BRANCH_HEAD,
    hasContractScript: false,
    hasTagDerivedScript: true,
    godotProject: null,
    googlePlay: { release: { versionName: "1.8.1" } },
    appStore: { release: { appleMarketingVersion: "1.8.1" } },
  });

  const result = await createRelease(h, "v1.8.6");

  assert.equal(result.tag, "v1.8.6");
  assert.equal(result.sha, BRANCH_HEAD);
  assert.equal(result.contract.kind, "tag-derived");
});
