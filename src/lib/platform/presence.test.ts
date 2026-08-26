import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activePresenceWhere,
  buildPlatformPresenceSnapshot,
} from "./presence";

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
      [
        {
          slug: "happy-farm",
          platformAppId: "happy-farm",
          displayName: "해피 팜",
        },
      ],
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

  it("Platform app_id alias로 Backoffice 제품명을 찾는다", () => {
    const snapshot = buildPlatformPresenceSnapshot(
      new Date("2026-08-26T12:00:00Z"),
      [
        {
          appId: "ungeul",
          _count: { _all: 2 },
          _max: { lastSeenAt: new Date("2026-08-26T11:59:59Z") },
        },
      ],
      [
        {
          slug: "saju-reader",
          platformAppId: "ungeul",
          displayName: "운글",
        },
      ],
    );

    assert.equal(snapshot.apps[0]?.appId, "ungeul");
    assert.equal(snapshot.apps[0]?.displayName, "운글");
  });

  it("만료 시각이 현재보다 큰 heartbeat만 조회한다", () => {
    const now = new Date("2026-08-26T12:00:00Z");
    assert.deepEqual(activePresenceWhere(now), { expiresAt: { gt: now } });
  });
});
