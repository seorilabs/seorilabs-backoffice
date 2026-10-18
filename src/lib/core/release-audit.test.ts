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


test("실행 ID 결합의 필수 감사 실패는 재요청 금지의 결과 미확인으로 전파한다", async () => {
  const log = mock.method(console, "error", () => {});
  let writes = 0;
  try {
    await assert.rejects(() => recordReleaseAudit({ repoFullName: "seorilabs/bloomhand", tag: "v1.0.2", required: true },
      "release.promote.dispatch", { workflowRunId: "1234" }, async () => { writes += 1; throw new Error("private-db-value"); }),
      /RELEASE_DISPATCH_AUDIT_UNKNOWN/);
    assert.equal(writes, 1);
    assert.doesNotMatch(JSON.stringify(log.mock.calls), /private-db-value/);
  } finally { log.mock.restore(); }
});
