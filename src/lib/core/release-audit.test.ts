import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { recordReleaseAudit } from "@/lib/core/release-audit";

test("릴리스 감사는 JSON payload를 그대로 저장하고 실패 시 비밀 없는 오류 신호를 남긴다", async () => {
  const payload = { tag: "v1.2.3", ready: true, count: 2, items: ["a", null] };
  const options = { repoFullName: "seorilabs/test", tag: "v1.2.3", actorLabel: "test" };
  const calls: unknown[] = [];
  const create = mock.fn(async (input: unknown) => {
    calls.push(input);
    return {};
  });
  const errorLog = mock.method(console, "error", () => {});
  try {
    await recordReleaseAudit(options, "release.test", payload, create);
    assert.deepEqual(calls, [{
      actorLogin: "test", action: "release.test", entityType: "release",
      entityId: "seorilabs/test@v1.2.3", payload,
    }]);
    create.mock.mockImplementation(async () => { throw new Error("private-database-value"); });
    await recordReleaseAudit(options, "release.test", payload, create);
    assert.equal(errorLog.mock.callCount(), 1);
    assert.deepEqual(errorLog.mock.calls[0]?.arguments, ["[release-ops] 감사 기록 저장 실패", { action: "release.test" }]);
    assert.doesNotMatch(JSON.stringify(errorLog.mock.calls), /private-database-value/u);
  } finally {
    errorLog.mock.restore();
  }
});
