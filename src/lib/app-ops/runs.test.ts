import assert from "node:assert/strict";
import test from "node:test";

import { AppOperationRunStatus } from "@prisma/client";

import { appOpsRunStatusForTest } from "./runs";

test("worker 큐 상태를 기존 UI 상태 계약으로 변환한다", () => {
  assert.deepEqual(appOpsRunStatusForTest(AppOperationRunStatus.PENDING), {
    status: "queued",
    conclusion: null,
  });
  assert.deepEqual(appOpsRunStatusForTest(AppOperationRunStatus.PROCESSING), {
    status: "in_progress",
    conclusion: null,
  });
  assert.deepEqual(appOpsRunStatusForTest(AppOperationRunStatus.SUCCEEDED), {
    status: "completed",
    conclusion: "success",
  });
  assert.deepEqual(appOpsRunStatusForTest(AppOperationRunStatus.FAILED), {
    status: "completed",
    conclusion: "failure",
  });
});
