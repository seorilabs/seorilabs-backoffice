import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPlatformPresenceSnapshot } from "./presence";

describe("platform presence snapshot", () => {
  it("앱별 최근 활성 세션을 합산하고 등록 이름을 붙인다", () => {
    const now = new Date("2026-08-26T12:00:00Z");
    const snapshot = buildPlatformPresenceSnapshot(
      now,
      [
        {
          appId: "happy-farm",
          _count: { _all: 3 },
          _max: { lastSeenAt: new Date("2026-08-26T11:59:59Z") },
        },
        {
          appId: "unregistered-app",
          _count: { _all: 1 },
          _max: { lastSeenAt: new Date("2026-08-26T11:59:58Z") },
        },
      ],
      [{ slug: "happy-farm", displayName: "해피 팜" }],
    );

    assert.equal(snapshot.totalActiveSessions, 4);
    assert.equal(snapshot.activeTtlSeconds, 150);
    assert.deepEqual(
      snapshot.apps.map((app) => [app.displayName, app.activeSessions]),
      [
        ["해피 팜", 3],
        ["unregistered-app", 1],
      ],
    );
  });

  it("정상 집계의 0명은 유효한 숫자로 보존한다", () => {
    const snapshot = buildPlatformPresenceSnapshot(
      new Date("2026-08-26T12:00:00Z"),
      [],
      [],
    );

    assert.equal(snapshot.totalActiveSessions, 0);
    assert.deepEqual(snapshot.apps, []);
  });
});
