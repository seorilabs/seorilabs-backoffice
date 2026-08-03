import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILD_TARGET_DEFINITIONS,
  buildDispatchRequest,
  buildTargetsFromWorkflowFiles,
  isBuildTarget,
} from "@/lib/core/build-targets";

test("기본 브랜치에 실제 존재하는 build-only workflow만 노출한다", () => {
  assert.deepEqual(
    buildTargetsFromWorkflowFiles(["build-android.yml", "deploy-apps-in-toss.yml"]),
    ["ANDROID"],
  );
  assert.deepEqual(
    buildTargetsFromWorkflowFiles(["build-ait.yml", "build-android.yml"]),
    ["AIT", "ANDROID"],
  );
});

test("빌드 dispatch는 배포 workflow가 아닌 후보 workflow와 release_tag만 사용한다", () => {
  assert.deepEqual(buildDispatchRequest("AIT", "v1.2.3"), {
    workflowFile: "build-ait.yml",
    inputs: { release_tag: "v1.2.3" },
  });
  assert.deepEqual(buildDispatchRequest("ANDROID", "v2.0.0"), {
    workflowFile: "build-android.yml",
    inputs: { release_tag: "v2.0.0" },
  });
  assert.ok(
    Object.values(BUILD_TARGET_DEFINITIONS).every(
      ({ workflowFile }) => !workflowFile.startsWith("deploy-"),
    ),
  );
});

test("허용된 빌드 대상만 통과한다", () => {
  assert.equal(isBuildTarget("AIT"), true);
  assert.equal(isBuildTarget("ANDROID"), true);
  assert.equal(isBuildTarget("PLAY"), false);
  assert.equal(isBuildTarget("APPSTORE"), false);
});
