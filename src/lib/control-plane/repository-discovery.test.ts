import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  discoverRepository,
  readExactRepositoryTree,
  repositoryDiscoverySloState,
  REPOSITORY_DISCOVERY_TERMINAL_SLO_MS,
  type RepositoryTreeSnapshot,
} from "@/lib/control-plane/repository-discovery";
import type { SourceObservationResult } from "@/lib/github/source-observation";

const REPO_ID = 42;
const SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);

function snapshot(
  paths: string[],
  overrides: Partial<RepositoryTreeSnapshot> = {},
): RepositoryTreeSnapshot {
  return {
    repoId: REPO_ID,
    fullName: "seorilabs/sample-app",
    name: "sample-app",
    sourceSha: SHA,
    sourceRef: "refs/heads/main",
    defaultBranch: "main",
    private: true,
    archived: false,
    paths,
    ...overrides,
  };
}

function sourceReader(files: Record<string, string>) {
  return async (path: string): Promise<SourceObservationResult> => {
    const text = files[path];
    if (text === undefined) {
      return {
        status: "ABSENT",
        reason: "PATH_NOT_FOUND",
        repoId: REPO_ID,
        fullName: "seorilabs/sample-app",
        sourceSha: SHA,
        sourceRef: "refs/heads/main",
        path,
        blobSha: null,
        contentSha256: null,
        size: null,
      };
    }
    return {
      status: "PRESENT",
      reason: null,
      repoId: REPO_ID,
      fullName: "seorilabs/sample-app",
      sourceSha: SHA,
      sourceRef: "refs/heads/main",
      path,
      blobSha: createHash("sha1").update(path).digest("hex"),
      contentSha256: createHash("sha256").update(text).digest("hex"),
      size: Buffer.byteLength(text),
      text,
    };
  };
}

test("RN monorepo의 exact package manager, workingDirectory와 세 market target을 탐지한다", async () => {
  const canary = "discovery-secret-canary-must-not-persist";
  const files = {
    "package.json": JSON.stringify({
      name: "sample-root",
      packageManager: "pnpm@11.3.0",
      scripts: { test: "pnpm --dir apps/mobile test" },
      unsafeCustomField: canary,
    }),
    "apps/mobile/package.json": JSON.stringify({
      name: "sample-mobile",
      dependencies: { "react-native": "0.81.0" },
    }),
    "apps/ait/package.json": JSON.stringify({
      name: "sample-ait",
      dependencies: { "react-native": "0.81.0" },
    }),
    "apps/mobile/android/app/build.gradle": 'android { defaultConfig { applicationId "com.seorilabs.sample" } }',
    "apps/mobile/ios/Sample.xcodeproj/project.pbxproj": "PRODUCT_BUNDLE_IDENTIFIER = com.seorilabs.sample;",
    "apps/ait/granite.config.ts": "export default { appName: 'sample-ait' };",
  };
  const paths = [...Object.keys(files), "pnpm-lock.yaml"];
  const result = await discoverRepository(snapshot(paths), sourceReader(files));

  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.deepEqual(result.workflowCaller, {
    profile: "react-native",
    packageManager: "pnpm",
    workingDirectory: "apps/mobile",
  });
  assert.deepEqual(result.buildTargets, [
    {
      targetKey: "ait",
      stack: "react-native",
      market: "apps-in-toss",
      configuration: { appName: "sample-ait" },
    },
    {
      targetKey: "android",
      stack: "react-native",
      market: "google-play",
      packageId: "com.seorilabs.sample",
    },
    {
      targetKey: "ios",
      stack: "react-native",
      market: "app-store",
      bundleId: "com.seorilabs.sample",
    },
  ]);
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(result.sourceMetadata.every((source) => !("text" in source)), true);
});

test("Godot production preset은 debug identity를 제외하고 npm caller와 target을 만든다", async () => {
  const files = {
    "package.json": JSON.stringify({
      name: "sample-game",
      scripts: { test: "npm run test:core" },
    }),
    "project.godot": "[application]\nconfig/name=\"Sample\"\n",
    "export_presets.cfg": [
      "[preset.0]",
      'name="Android"',
      'platform="Android"',
      "[preset.0.options]",
      'package/unique_name="com.seorilabs.game"',
      "[preset.1]",
      'name="Android Debug"',
      'platform="Android"',
      "[preset.1.options]",
      'package/unique_name="com.seorilabs.game.debug"',
      "[preset.2]",
      'name="iOS"',
      'platform="iOS"',
      "[preset.2.options]",
      'application/bundle_identifier="com.seorilabs.game"',
    ].join("\n"),
    "apps/ait/granite.config.ts": "export default { appName: `sample-game` };",
  };
  const result = await discoverRepository(snapshot(Object.keys(files)), sourceReader(files));

  assert.equal(result.status, "ACTIVE");
  if (result.status !== "ACTIVE") return;
  assert.deepEqual(result.workflowCaller, {
    profile: "godot",
    packageManager: "npm",
    workingDirectory: ".",
  });
  assert.deepEqual(
    result.buildTargets.map((target) => [target.targetKey, target.packageId ?? target.bundleId ?? null]),
    [["ait", null], ["android", "com.seorilabs.game"], ["ios", "com.seorilabs.game"]],
  );
});

test("RN과 Godot 후보가 함께 있으면 추측하지 않고 MULTIPLE_CANDIDATES다", async () => {
  const files = {
    "package.json": JSON.stringify({
      name: "mixed",
      packageManager: "pnpm@11.3.0",
      dependencies: { "react-native": "0.81.0" },
    }),
    "project.godot": "[application]\n",
  };
  const result = await discoverRepository(
    snapshot([...Object.keys(files), "pnpm-lock.yaml"]),
    sourceReader(files),
  );
  assert.equal(result.status, "NEEDS_INPUT");
  assert.equal(result.reasonCode, "MULTIPLE_CANDIDATES");
  assert.equal(result.candidates.length, 2);
});

test("platform SDK producer는 앱 profile로 위장하지 않고 명시적으로 제외한다", async () => {
  const files = {
    "package.json": JSON.stringify({ name: "seorilabs-platform", packageManager: "pnpm@11.3.0" }),
    "sdk-gdscript/project.godot": "[application]\n",
  };
  const result = await discoverRepository(snapshot(
    [...Object.keys(files), "spec/openapi.yaml", "pnpm-lock.yaml"],
    { fullName: "seorilabs/platform", name: "platform" },
  ), sourceReader(files));
  assert.equal(result.status, "EXCLUDED");
  assert.equal(result.managementKind, "PLATFORM_PRODUCER");
  assert.equal(result.reasonCode, "PLATFORM_SDK_PRODUCER");
  assert.equal(result.candidates.length, 0);
});

test("tree에 있던 source가 exact SHA에서 읽히지 않으면 SOURCE_FILE_UNREADABLE이다", async () => {
  const result = await discoverRepository(
    snapshot(["package.json"]),
    sourceReader({}),
  );
  assert.equal(result.status, "NEEDS_INPUT");
  assert.equal(result.reasonCode, "SOURCE_FILE_UNREADABLE");
  assert.equal(result.sourceMetadata[0]?.status, "ABSENT");
});

test("앱 후보에 마켓 build target이 없으면 추측 등록하지 않는다", async () => {
  const files = {
    "package.json": JSON.stringify({
      name: "incomplete-app",
      packageManager: "pnpm@11.3.0",
      dependencies: { "react-native": "0.81.0" },
    }),
  };
  const result = await discoverRepository(
    snapshot([...Object.keys(files), "pnpm-lock.yaml"]),
    sourceReader(files),
  );
  assert.equal(result.status, "NEEDS_INPUT");
  assert.equal(result.reasonCode, "BUILD_TARGET_MISSING");
});

test("마켓 설정에서 공개 build identity를 확정하지 못하면 fail-closed한다", async () => {
  const files = {
    "package.json": JSON.stringify({
      name: "incomplete-app",
      packageManager: "pnpm@11.3.0",
      dependencies: { "react-native": "0.81.0" },
    }),
    "android/app/build.gradle": "android { defaultConfig { applicationId providers.gradleProperty('appId') } }",
  };
  const result = await discoverRepository(
    snapshot([...Object.keys(files), "pnpm-lock.yaml"]),
    sourceReader(files),
  );
  assert.equal(result.status, "NEEDS_INPUT");
  assert.equal(result.reasonCode, "BUILD_IDENTITY_MISSING");
});

test("GitHub numeric identity, exact default HEAD와 non-truncated tree를 검증한다", async (t) => {
  const calls: Array<Record<string, unknown>> = [];
  const fake = (overrides: {
    repo?: Record<string, unknown>;
    commit?: Record<string, unknown>;
    tree?: Record<string, unknown>;
  } = {}) => ({
    rest: {
      repos: {
        async get(args: Record<string, unknown>) {
          calls.push({ kind: "repo", ...args });
          return { data: overrides.repo ?? {
            id: REPO_ID,
            full_name: "seorilabs/sample-app",
            name: "sample-app",
            default_branch: "main",
            private: true,
            archived: false,
          } };
        },
        async getCommit(args: Record<string, unknown>) {
          calls.push({ kind: "commit", ...args });
          return { data: overrides.commit ?? { sha: SHA, commit: { tree: { sha: TREE_SHA } } } };
        },
      },
      git: {
        async getTree(args: Record<string, unknown>) {
          calls.push({ kind: "tree", ...args });
          return { data: overrides.tree ?? {
            sha: TREE_SHA,
            truncated: false,
            tree: [{ path: "package.json", type: "blob" }],
          } };
        },
      },
    },
  });

  await t.test("ready", async () => {
    const result = await readExactRepositoryTree(fake() as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/sample-app",
      expectedSourceSha: SHA.toUpperCase(),
    });
    assert.equal(result.status, "READY");
    if (result.status === "READY") assert.deepEqual(result.snapshot.paths, ["package.json"]);
    assert.equal(calls.some((call) => call.kind === "commit" && call.ref === "main"), true);
    assert.equal(calls.some((call) => call.kind === "tree" && call.tree_sha === TREE_SHA), true);
  });

  await t.test("numeric ID mismatch", async () => {
    const result = await readExactRepositoryTree(fake({ repo: {
      id: REPO_ID + 1,
      full_name: "seorilabs/sample-app",
      name: "sample-app",
      default_branch: "main",
      private: true,
      archived: false,
    } }) as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/sample-app",
      expectedSourceSha: SHA,
    });
    assert.equal(result.status, "NEEDS_INPUT");
    assert.equal(result.reasonCode, "REPOSITORY_ID_MISMATCH");
  });

  await t.test("source drift", async () => {
    const newer = "c".repeat(40);
    const result = await readExactRepositoryTree(fake({
      commit: { sha: newer, commit: { tree: { sha: TREE_SHA } } },
    }) as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/sample-app",
      expectedSourceSha: SHA,
    });
    assert.deepEqual(result, { status: "STALE", reasonCode: "SOURCE_DRIFT", actualHeadSha: newer });
  });

  await t.test("truncated tree", async () => {
    const result = await readExactRepositoryTree(fake({
      tree: { sha: TREE_SHA, truncated: true, tree: [] },
    }) as never, {
      repoId: REPO_ID,
      fullName: "seorilabs/sample-app",
      expectedSourceSha: SHA,
    });
    assert.equal(result.status, "NEEDS_INPUT");
    assert.equal(result.reasonCode, "TREE_TRUNCATED");
  });
});

test("10분 안에 끝나지 않은 non-terminal run만 OVERDUE로 분류한다", () => {
  const createdAt = new Date("2026-08-28T00:00:00.000Z");
  assert.equal(repositoryDiscoverySloState({
    createdAt,
    now: new Date(createdAt.getTime() + REPOSITORY_DISCOVERY_TERMINAL_SLO_MS - 1),
    status: "QUEUED",
  }), "WITHIN_SLO");
  assert.equal(repositoryDiscoverySloState({
    createdAt,
    now: new Date(createdAt.getTime() + REPOSITORY_DISCOVERY_TERMINAL_SLO_MS),
    status: "RUNNING",
  }), "OVERDUE");
  assert.equal(repositoryDiscoverySloState({
    createdAt,
    now: new Date(createdAt.getTime() + REPOSITORY_DISCOVERY_TERMINAL_SLO_MS * 2),
    status: "NEEDS_INPUT",
  }), "TERMINAL");
});
