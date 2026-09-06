import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blastRadiusAuditPayload, evaluateUpdateBlastRadius } from "./update-guard";
import type { UpdatePolicyPlatformInput } from "./update-policy";
import type { PlatformVersionDistribution } from "./version-distribution";

function distribution(
  rows: Array<{ version: string; android?: number; ios?: number }>,
  unknownSessions = 0,
): PlatformVersionDistribution {
  const versions = rows.map((row) => {
    const byPlatform = [
      ...(row.android ? [{ platform: "android", sessions: row.android }] : []),
      ...(row.ios ? [{ platform: "ios", sessions: row.ios }] : []),
    ];
    return {
      appVersion: row.version,
      sessions: byPlatform.reduce((total, entry) => total + entry.sessions, 0),
      share: 0,
      byPlatform,
      lastSeenAt: null,
      firstSeenAt: null,
      runtimes: [],
    };
  });
  const total =
    versions.reduce((sum, row) => sum + row.sessions, 0) + unknownSessions;
  return {
    appId: "happy-farm",
    displayName: "해피 팜",
    measuredAt: "2026-09-06T12:00:00Z",
    activeTtlSeconds: 150,
    totalSessions: total,
    unknownSessions,
    versions,
  };
}

function input(
  platform: "android" | "ios",
  blockedVersions: string[],
): UpdatePolicyPlatformInput {
  return { platform, blockedVersions, recommendOverride: "" };
}

describe("영향 범위", () => {
  it("강제 대상 버전의 해당 플랫폼 세션만 센다", () => {
    const radius = evaluateUpdateBlastRadius(
      distribution([
        { version: "1.4.0", android: 3, ios: 5 },
        { version: "1.5.0", android: 12 },
      ]),
      [input("android", ["1.4.0"])],
    );

    // iOS 5명은 android 정책의 대상이 아니다.
    assert.equal(radius.blockedSessions, 3);
    assert.deepEqual(radius.byPlatform, [{ platform: "android", sessions: 3 }]);
    assert.equal(radius.totalSessions, 20);
  });

  it("v 접두사가 달라도 같은 빌드로 센다", () => {
    const radius = evaluateUpdateBlastRadius(
      distribution([{ version: "1.4.0", android: 4 }]),
      [input("android", ["v1.4.0"])],
    );
    assert.equal(radius.blockedSessions, 4);
  });

  it("강제 대상이 없으면 0명이다", () => {
    const radius = evaluateUpdateBlastRadius(
      distribution([{ version: "1.5.0", android: 9 }]),
      [input("android", [])],
    );
    assert.equal(radius.blockedSessions, 0);
    assert.equal(radius.blockedShare, 0);
  });

  it("관측이 없으면 규모를 모른다고 경고한다", () => {
    const radius = evaluateUpdateBlastRadius(null, [input("android", ["1.4.0"])]);
    assert.equal(radius.totalSessions, 0);
    assert.ok(radius.warnings.some((warning) => warning.code === "no_observation"));
  });

  // 미상 비중이 크면 실제 차단 규모가 이 숫자보다 크다.
  it("버전 미보고 비중이 높으면 경고한다", () => {
    const radius = evaluateUpdateBlastRadius(
      distribution([{ version: "1.4.0", android: 5 }], 5),
      [input("android", ["1.4.0"])],
    );
    assert.ok(
      radius.warnings.some((warning) => warning.code === "unknown_share_high"),
    );
  });

  it("차단 비중이 크면 크게 경고한다", () => {
    const radius = evaluateUpdateBlastRadius(
      distribution([
        { version: "1.4.0", android: 7 },
        { version: "1.5.0", android: 3 },
      ]),
      [input("android", ["1.4.0"])],
    );
    assert.equal(radius.blockedShare, 0.7);
    assert.ok(radius.warnings.some((warning) => warning.code === "large_blast"));
  });

  // App Store 공개 여부는 이 DB로 증명할 수 없다.
  it("iOS 강제에는 증명 불가 경고를 붙인다", () => {
    const radius = evaluateUpdateBlastRadius(
      distribution([{ version: "1.4.0", ios: 2 }]),
      [input("ios", ["1.4.0"])],
    );
    assert.ok(
      radius.warnings.some((warning) => warning.code === "appstore_unprovable"),
    );
  });
});

describe("감사 payload", () => {
  it("세션 수와 버전 문자열만 남긴다", () => {
    const next = [input("android", ["1.4.1", "1.4.0"])];
    const radius = evaluateUpdateBlastRadius(
      distribution([{ version: "1.4.0", android: 2 }]),
      next,
    );
    const payload = blastRadiusAuditPayload(radius, next);

    assert.deepEqual(payload.platforms, {
      android: { blockedVersions: ["1.4.0", "1.4.1"], recommendOverride: "" },
    });
    const blast = payload.blastRadius as Record<string, unknown>;
    assert.equal(blast.blocked, 2);
    assert.equal(blast.total, 2);
    assert.deepEqual(payload.warnings, ["large_blast"]);
  });
});
