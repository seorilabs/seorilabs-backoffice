import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { transpileModule, ScriptTarget } from "typescript";
import {
  releaseStatusOf,
  releaseTrackForWorkflow,
  stableReleaseTagFromArtifactNames,
  shouldAdvanceLifecycleForRelease,
} from "@/lib/sync/release-status";

test("GitHub 마켓 workflow 완료는 성공 외 모든 conclusion을 실패로 수렴한다", () => {
  assert.equal(releaseStatusOf("completed", "success"), "SUCCEEDED");
  for (const conclusion of [
    "failure",
    "timed_out",
    "cancelled",
    "startup_failure",
    "action_required",
  ]) {
    assert.equal(releaseStatusOf("completed", conclusion), "FAILED");
  }
  assert.equal(releaseStatusOf("in_progress", null), "IN_PROGRESS");
});

test("snapshot Play 후보는 internal, 승격은 production 트랙으로 기록한다", () => {
  assert.equal(
    releaseTrackForWorkflow({
      market: "PLAY",
      promoted: false,
      version: "v1.2.3-snapshot.1",
    }),
    "internal",
  );
  assert.equal(
    releaseTrackForWorkflow({
      market: "PLAY",
      promoted: true,
      version: "v1.2.3",
    }),
    "production",
  );
  assert.equal(
    releaseTrackForWorkflow({
      market: "AIT",
      promoted: false,
      version: "v1.2.3-snapshot.1",
    }),
    null,
  );
});

test("정식 stable SemVer 배포 성공만 라이프사이클을 전이한다", () => {
  assert.equal(shouldAdvanceLifecycleForRelease("SUCCEEDED", "v1.2.3"), true);
  assert.equal(shouldAdvanceLifecycleForRelease("FAILED", "v1.2.3"), false);
  assert.equal(
    shouldAdvanceLifecycleForRelease("SUCCEEDED", "v1.2.3-snapshot.4"),
    false,
  );
  assert.equal(shouldAdvanceLifecycleForRelease("SUCCEEDED", "untagged"), false);
});

test("기본 브랜치 제어 실행은 표준 artifact 이름에서 유일한 stable 태그를 복원한다", () => {
  assert.equal(
    stableReleaseTagFromArtifactNames([
      "ait-jomul-v1.0.14-1001000014",
      "release-notes-v1.0.14",
    ]),
    "v1.0.14",
  );
  assert.equal(
    stableReleaseTagFromArtifactNames([
      "ait-jomul-v1.0.14-1001000014",
      "android-jomul-v1.0.15-1001000015",
    ]),
    null,
  );
  assert.equal(
    stableReleaseTagFromArtifactNames(["ait-jomul-v1.0.14-snapshot.2"]),
    null,
  );
  assert.equal(stableReleaseTagFromArtifactNames(["unversioned-artifact"]), null);
});

// DB/네트워크 경계만 대체하여 실제 webhook 미러 경로의 release 기록을 확인한다.
test("기본 브랜치 승격의 queued와 completed 기록은 제어 HEAD의 다른 태그를 쓰지 않는다", async () => {
  const source = readFileSync("src/lib/sync/mirror.ts", "utf8");
  const body = (name: string) => {
    const start = source.indexOf(`async function ${name}(`);
    assert.ok(start >= 0);
    const rest = source.slice(start);
    return rest.slice(0, rest.indexOf("\n}\n") + 2);
  };
  const compiled = transpileModule(`${body("resolveRunVersion")}\n${body("upsertWorkflowRun")}`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  for (const status of ["queued", "completed"]) {
    const recorded: Array<{ version: string; commitSha: string }> = [];
    const ports = {
      prisma: { workflowRunMirror: { findUnique: async () => null, upsert: async () => ({}) } },
      resolveAppId: async () => "app1", releaseStatusOf,
      marketFromWorkflowPath: () => "PLAY", marketFromWorkflowName: () => null,
      isPromoteGooglePlayWorkflow: () => true, releaseTrackForWorkflow,
      findTagForSha: async () => "v1.0.3", listWorkflowRunArtifactNames: async () => [], stableReleaseTagFromArtifactNames,
      resolveStableTagSha: async () => "1".repeat(40),
      resolvePromotionRunBinding: async () => ({ version: "v1.0.2", commitSha: "1".repeat(40) }),
      recordMarketRelease: async (input: { version: string; commitSha: string }) => { recorded.push(input); },
      shouldAdvanceLifecycleForRelease: () => false,
    };
    const upsert = new Function(...Object.keys(ports), `${compiled}; return upsertWorkflowRun;`)(...Object.values(ports));
    await upsert("seorilabs/bloomhand", {
      id: 1234, path: ".github/workflows/promote-google-play.yml", head_branch: "main", head_sha: "2".repeat(40),
      event: "workflow_dispatch", status, conclusion: status === "completed" ? "success" : null,
      updated_at: "2026-10-18T00:00:00Z",
    });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].version, "v1.0.2");
    assert.equal(recorded[0].commitSha, "1".repeat(40));
  }
});
