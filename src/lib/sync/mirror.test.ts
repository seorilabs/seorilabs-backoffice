import assert from "node:assert/strict";
import test from "node:test";
import {
  releaseStatusOf,
  releaseTrackForWorkflow,
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

test("develop Play 후보는 internal, 승격은 production 트랙으로 기록한다", () => {
  assert.equal(
    releaseTrackForWorkflow({
      market: "PLAY",
      promoted: false,
      version: "v1.2.3-develop.1",
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
      version: "v1.2.3-develop.1",
    }),
    null,
  );
});

test("정식 stable SemVer 배포 성공만 라이프사이클을 전이한다", () => {
  assert.equal(shouldAdvanceLifecycleForRelease("SUCCEEDED", "v1.2.3"), true);
  assert.equal(shouldAdvanceLifecycleForRelease("FAILED", "v1.2.3"), false);
  assert.equal(
    shouldAdvanceLifecycleForRelease("SUCCEEDED", "v1.2.3-develop.4"),
    false,
  );
  assert.equal(shouldAdvanceLifecycleForRelease("SUCCEEDED", "untagged"), false);
});
