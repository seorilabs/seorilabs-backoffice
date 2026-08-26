import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadPlatformPresencePipelineSnapshot } from "./presence-pipeline";

const zeroSnapshot = {
  totalActiveSessions: 0,
  measuredAt: "2026-08-26T12:00:00Z",
  activeTtlSeconds: 150,
  apps: [],
};

describe("presence pipeline health", () => {
  it("Edge·ingest·DB가 모두 정상일 때 정상 0을 반환한다", async () => {
    const snapshot = await loadPlatformPresencePipelineSnapshot({
      checkEdge: async () => undefined,
      checkIngest: async () => undefined,
      loadSnapshot: async () => zeroSnapshot,
    });
    assert.equal(snapshot.totalActiveSessions, 0);
  });

  it("ingest만 실패해도 DB의 0을 현재값으로 읽지 않는다", async () => {
    let dbCalled = false;
    await assert.rejects(
      loadPlatformPresencePipelineSnapshot({
        checkEdge: async () => undefined,
        checkIngest: async () => {
          throw new Error("ingest unavailable");
        },
        loadSnapshot: async () => {
          dbCalled = true;
          return zeroSnapshot;
        },
      }),
      /ingest unavailable/,
    );
    assert.equal(dbCalled, false);
  });

  it("Edge만 실패해도 DB의 0을 현재값으로 읽지 않는다", async () => {
    let dbCalled = false;
    await assert.rejects(
      loadPlatformPresencePipelineSnapshot({
        checkEdge: async () => {
          throw new Error("edge unavailable");
        },
        checkIngest: async () => undefined,
        loadSnapshot: async () => {
          dbCalled = true;
          return zeroSnapshot;
        },
      }),
      /edge unavailable/,
    );
    assert.equal(dbCalled, false);
  });
});
