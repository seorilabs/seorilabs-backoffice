import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadPresenceApiResult } from "./presence-api";

describe("presence API result", () => {
  it("정상 집계 0은 200 숫자 응답으로 보존한다", async () => {
    const result = await loadPresenceApiResult(async () => ({
      totalActiveSessions: 0,
      measuredAt: "2026-08-26T12:00:00Z",
      activeTtlSeconds: 150,
      apps: [],
    }));

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    if (result.body.ok) assert.equal(result.body.snapshot.totalActiveSessions, 0);
  });

  it("DB 집계 실패는 0이 아닌 503 unknown으로 반환한다", async () => {
    const result = await loadPresenceApiResult(async () => {
      throw new Error("DB unavailable");
    });

    assert.deepEqual(result, {
      status: 503,
      body: { ok: false, error: "presence 집계를 읽지 못했습니다." },
    });
  });
});
