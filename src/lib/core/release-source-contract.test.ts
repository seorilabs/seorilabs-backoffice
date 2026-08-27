import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReleaseSourceContract,
  parseGodotConfigVersion,
  ReleaseSourceContractError,
  type ReleaseSourceFiles,
} from "@/lib/core/release-source-contract";

const SHA = "076e09e4b2c1d0a9f8e7d6c5b4a39281706f5e4d";

function godot(version: string): string {
  return [
    "[application]",
    "",
    'config/name="도마뱀 테라리움"',
    `config/version="${version}"`,
    'run/main_scene="res://scenes/Main.tscn"',
  ].join("\n");
}

/** lizard-tycoon 실제 구조: pinned-source 계약을 선언한 Godot repo. */
function pinnedFiles(input: {
  project: string;
  play: string;
  appStore: string;
}): ReleaseSourceFiles {
  return {
    sha: SHA,
    hasContractScript: true,
    hasTagDerivedScript: false,
    godotProject: { path: "project.godot", text: godot(input.project) },
    googlePlay: { packageName: "com.seorilabs.lizardtycoon", release: { versionName: input.play } },
    appStore: { bundleId: "com.seorilabs.lizardtycoon", release: { appleMarketingVersion: input.appStore } },
  };
}

function aligned(version: string): ReleaseSourceFiles {
  return pinnedFiles({ project: version, play: version, appStore: version });
}

function captureContractError(run: () => unknown): ReleaseSourceContractError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ReleaseSourceContractError);
    return error;
  }
  throw new assert.AssertionError({ message: "계약 위반이 감지되지 않았습니다." });
}

test("project.godot 의 config/version 은 정확히 하나만 인정한다", () => {
  assert.equal(parseGodotConfigVersion(godot("1.1.12")), "1.1.12");
  assert.throws(
    () => parseGodotConfigVersion("[application]\n"),
    /config\/version 이 정확히 하나여야/,
  );
  assert.throws(
    () => parseGodotConfigVersion(`${godot("1.1.12")}\nconfig/version="1.2.0"`),
    /config\/version 이 정확히 하나여야/,
  );
});

// 인수조건: 실제 장애(태그 v1.2.0 / 소스 1.1.12)를 계약 단계에서 막는다.
test("태그 버전과 소스 버전이 다르면 재시도 불가 오류로 막는다", () => {
  const error = captureContractError(() =>
    assertReleaseSourceContract({
      repoFullName: "seorilabs/lizard-tycoon",
      tag: "v1.2.0",
      files: aligned("1.1.12"),
    }),
  );

  assert.equal(error.retryable, false);
  assert.match(error.message, /tag=1\.2\.0/);
  assert.match(error.message, /source=1\.1\.12/);
  assert.match(error.message, /재시도로는 해결되지 않으니/);
});

// 인수조건: 세 원장이 서로 다르면 태그가 어느 값과 같아도 통과시키지 않는다.
test("원장 세 개가 서로 다르면 태그와 하나가 같아도 막는다", () => {
  const error = captureContractError(() =>
    assertReleaseSourceContract({
      repoFullName: "seorilabs/lizard-tycoon",
      tag: "v1.2.0",
      files: pinnedFiles({ project: "1.2.0", play: "1.1.12", appStore: "1.1.11" }),
    }),
  );

  assert.match(error.message, /소스 원장 버전이 서로 다릅니다/);
  assert.match(error.message, /project\.godot=1\.2\.0/);
  assert.match(error.message, /google-play\.config\.json=1\.1\.12/);
  assert.match(error.message, /app-store\.config\.json=1\.1\.11/);
});

test("세 원장이 태그와 모두 같으면 pinned-source 로 통과한다", () => {
  const contract = assertReleaseSourceContract({
    repoFullName: "seorilabs/lizard-tycoon",
    tag: "v1.1.12",
    files: aligned("1.1.12"),
  });

  assert.equal(contract.kind, "pinned-source");
  assert.equal(contract.tagVersion, "1.1.12");
  assert.equal(contract.sha, SHA);
  assert.deepEqual(contract.observed, {
    "project.godot": "1.1.12",
    "play-store/google-play.config.json": "1.1.12",
    "app-store/app-store.config.json": "1.1.12",
  });
});

test("계약을 선언했는데 원장이 없거나 stable SemVer 가 아니면 막는다", () => {
  const missingProject: ReleaseSourceFiles = { ...aligned("1.1.12"), godotProject: null };
  assert.throws(
    () =>
      assertReleaseSourceContract({
        repoFullName: "seorilabs/lizard-tycoon",
        tag: "v1.1.12",
        files: missingProject,
      }),
    /project\.godot 또는 godot\/project\.godot 가 없습니다/,
  );

  const missingPlay: ReleaseSourceFiles = { ...aligned("1.1.12"), googlePlay: { release: {} } };
  assert.throws(
    () =>
      assertReleaseSourceContract({
        repoFullName: "seorilabs/lizard-tycoon",
        tag: "v1.1.12",
        files: missingPlay,
      }),
    /release\.versionName 가 비어 있습니다/,
  );

  assert.throws(
    () =>
      assertReleaseSourceContract({
        repoFullName: "seorilabs/lizard-tycoon",
        tag: "v1.1.12",
        files: pinnedFiles({ project: "1.1.12-beta", play: "1.1.12", appStore: "1.1.12" }),
      }),
    /stable SemVer 여야 합니다/,
  );
});

// 인수조건: 기존 RN tag-derived 계약(버전이 태그의 순수 함수)은 그대로 통과한다.
test("RN tag-derived repo 는 마켓 config 값과 무관하게 통과한다", () => {
  const contract = assertReleaseSourceContract({
    repoFullName: "seorilabs/happy-farm",
    tag: "v1.8.6",
    files: {
      sha: SHA,
      hasContractScript: false,
      hasTagDerivedScript: true,
      godotProject: null,
      // 마켓 config 에 남아 있는 값은 원장이 아니라 기록이다. 빌드 버전은 태그에서 파생된다.
      googlePlay: { release: { versionName: "1.8.1" } },
      appStore: { release: { appleMarketingVersion: "1.8.1" } },
    },
  });

  assert.equal(contract.kind, "tag-derived");
  assert.deepEqual(contract.observed, {});
});

// 인수조건: 계약 스크립트가 없는 Godot caller repo 는 version_name 을 태그에서 받는다.
test("계약 스크립트가 없으면 tag-derived-caller 로 분류한다", () => {
  const contract = assertReleaseSourceContract({
    repoFullName: "seorilabs/jomul",
    tag: "v0.1.7",
    files: {
      sha: SHA,
      hasContractScript: false,
      hasTagDerivedScript: false,
      godotProject: { path: "project.godot", text: godot("0.1.2") },
      googlePlay: { release: { versionName: "0.1.5" } },
      appStore: null,
    },
  });

  assert.equal(contract.kind, "tag-derived-caller");
});
