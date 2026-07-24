import assert from "node:assert/strict";
import test from "node:test";
import { releaseStatusOf } from "@/lib/sync/release-status";

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
