import assert from "node:assert/strict";
import test from "node:test";

import { AppOperationRunStatus } from "@prisma/client";

import {
  appOpsRunStatusForTest,
  platformOutcomeExpiredForTest,
  platformOutcomeUnknownForTest,
} from "./runs";

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

test("플랫폼 결과 불명은 일반 실패와 machine-readable하게 구분한다", () => {
  const now = new Date("2026-08-02T00:00:00.000Z");
  assert.equal(
    platformOutcomeUnknownForTest({
      repoFullName: "seorilabs/platform",
      error: "platform_outcome_unknown",
      expiresAt: new Date("2026-08-03T00:00:00.000Z"),
    }, now),
    true,
  );
  assert.equal(
    platformOutcomeUnknownForTest({
      repoFullName: "seorilabs/platform",
      error: "definitive failure",
      expiresAt: new Date("2026-08-03T00:00:00.000Z"),
    }, now),
    false,
  );
  assert.equal(
    platformOutcomeUnknownForTest({
      repoFullName: "seorilabs/lizard-tycoon",
      error: "platform_outcome_unknown",
      expiresAt: new Date("2026-08-03T00:00:00.000Z"),
    }, now),
    false,
  );
  assert.equal(
    platformOutcomeExpiredForTest(
      {
        repoFullName: "seorilabs/platform",
        error: "platform_outcome_unknown",
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      },
      now,
    ),
    true,
  );
});
