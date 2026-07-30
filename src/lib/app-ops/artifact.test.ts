import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";

import { parseAppOpsResultArtifact } from "./artifact";

const requestId = "86aa4c7c-bf75-4f38-a1c8-50ac398de7dc";

test("GitHub Actions artifact의 result.json을 검증해 복원한다", () => {
  const artifact = zipSync({
    "result.json": strToU8(
      JSON.stringify({
        version: 1,
        requestId,
        operation: "iap-ledger.recent-purchases",
        status: "success",
        summary: "4건 조회",
        data: { count: 4 },
        completedAt: "2026-07-30T02:30:00.000Z",
      }),
    ),
  });
  const result = parseAppOpsResultArtifact(artifact, requestId);
  assert.equal(result.status, "success");
  assert.deepEqual(result.data, { count: 4 });
});

test("요청 ID 불일치와 result.json 누락 artifact는 거부한다", () => {
  const artifact = zipSync({
    "result.json": strToU8(
      JSON.stringify({
        version: 1,
        requestId,
        operation: "iap-ledger.recent-purchases",
        status: "success",
        summary: "4건 조회",
        completedAt: "2026-07-30T02:30:00.000Z",
      }),
    ),
  });
  assert.throws(
    () =>
      parseAppOpsResultArtifact(
        artifact,
        "39d9d011-0dab-45f8-968f-bc1d3c630339",
      ),
    /요청 ID/,
  );
  assert.throws(
    () => parseAppOpsResultArtifact(zipSync({ "other.json": strToU8("{}") }), requestId),
    /result\.json/,
  );
});
