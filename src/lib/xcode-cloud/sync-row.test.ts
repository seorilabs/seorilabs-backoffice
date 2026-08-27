import assert from "node:assert/strict";
import test from "node:test";
import type { XcodeCloudBuildStatus } from "@/lib/xcode-cloud/status-shape";
import { syncXcodeCloudRow } from "@/lib/xcode-cloud/sync-row";

const RESULT: XcodeCloudBuildStatus = {
  status: "SUCCEEDED",
  buildNumber: 42,
  startedAt: new Date("2026-08-27T00:00:00Z"),
  finishedAt: new Date("2026-08-27T00:01:00Z"),
  completionStatus: "SUCCEEDED",
};

test("Xcode terminal 상태는 단일 persist 경계가 실패하면 완료로 처리하지 않는다", async () => {
  const calls: string[] = [];
  await assert.rejects(
    syncXcodeCloudRow(
      { id: "release-1", externalRunId: "run-1", status: "IN_PROGRESS" },
      {
        readStatus: async () => {
          calls.push("read");
          return RESULT;
        },
        persistStatus: async () => {
          calls.push("persist");
          throw new Error("transaction unavailable");
        },
      },
    ),
  );
  assert.deepEqual(calls, ["read", "persist"]);
});

test("Xcode 상태와 outbox를 하나의 persist 입력으로 전달한다", async () => {
  const calls: string[] = [];
  let persistedStatus: string | null = null;
  const result = await syncXcodeCloudRow(
    { id: "release-1", externalRunId: "run-1", status: "IN_PROGRESS" },
    {
      readStatus: async () => {
        calls.push("read");
        return RESULT;
      },
      persistStatus: async (input) => {
        calls.push("persist");
        assert.equal(input.statusChanged, true);
        assert.equal(input.terminal, true);
        assert.equal(input.row.externalRunId, "run-1");
        persistedStatus = input.result.status;
      },
    },
  );
  assert.deepEqual(calls, ["read", "persist"]);
  assert.equal(persistedStatus, "SUCCEEDED");
  assert.deepEqual(result, { terminal: true, status: "SUCCEEDED" });
});
