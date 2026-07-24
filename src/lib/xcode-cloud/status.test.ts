import assert from "node:assert/strict";
import test from "node:test";
import { mapXcodeCloudBuildStatus } from "@/lib/xcode-cloud/status-shape";

test("Xcode Cloud PENDING·RUNNING 진행 상태를 배포 레코드로 매핑한다", () => {
  assert.equal(mapXcodeCloudBuildStatus({ executionProgress: "PENDING" }).status, "PENDING");
  assert.equal(
    mapXcodeCloudBuildStatus({ executionProgress: "RUNNING" }).status,
    "IN_PROGRESS",
  );
});

test("Xcode Cloud 완료 결과는 성공과 모든 비성공을 구분한다", () => {
  const succeeded = mapXcodeCloudBuildStatus({
    executionProgress: "COMPLETE",
    completionStatus: "SUCCEEDED",
    number: 81,
    startedDate: "2026-07-24T01:00:00Z",
    finishedDate: "2026-07-24T01:05:00Z",
  });
  assert.equal(succeeded.status, "SUCCEEDED");
  assert.equal(succeeded.buildNumber, 81);
  assert.equal(succeeded.finishedAt?.toISOString(), "2026-07-24T01:05:00.000Z");

  for (const completionStatus of ["FAILED", "ERRORED", "CANCELED", "SKIPPED"]) {
    assert.equal(
      mapXcodeCloudBuildStatus({
        executionProgress: "COMPLETE",
        completionStatus,
      }).status,
      "FAILED",
    );
  }
});
