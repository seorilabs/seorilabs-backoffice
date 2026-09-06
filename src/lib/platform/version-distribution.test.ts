import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  UNKNOWN_APP_VERSION,
  appVersionKey,
  buildPlatformVersionDistributions,
  compareVersionRows,
  readFirstSeenAttributes,
  type AppVersionFirstSeenRow,
  type PlatformVersionRow,
  type PresenceVersionGroup,
} from "./version-distribution";

const NOW = new Date("2026-09-06T12:00:00Z");

const APPS = [
  { slug: "happy-farm", platformAppId: "happy-farm", displayName: "해피 팜" },
  { slug: "saju-reader", platformAppId: "ungeul", displayName: "운글" },
  { slug: "quiet-app", platformAppId: null, displayName: "관측 없는 앱" },
];

function group(
  appId: string,
  platform: string,
  appVersion: string,
  sessions: number,
  lastSeenAt = "2026-09-06T11:59:30Z",
): PresenceVersionGroup {
  return {
    appId,
    platform,
    appVersion,
    _count: { _all: sessions },
    _max: { lastSeenAt: new Date(lastSeenAt) },
  };
}

function firstSeen(
  appId: string,
  appVersion: string,
  runtime: string,
  occurredAt: string,
): AppVersionFirstSeenRow {
  return {
    appId,
    occurredAt: new Date(occurredAt),
    attributes: { appVersion, runtime, sdk: "ts/0.4.0" },
  };
}

function row(appVersion: string): PlatformVersionRow {
  return {
    appVersion,
    sessions: 0,
    share: 0,
    byPlatform: [],
    lastSeenAt: null,
    firstSeenAt: null,
    runtimes: [],
  };
}

describe("앱 버전 분포", () => {
  it("플랫폼별 세션을 버전으로 합치고 비중을 계산한다", () => {
    const [distribution] = buildPlatformVersionDistributions(
      NOW,
      [APPS[0]],
      [
        group("happy-farm", "android", "1.5.0", 6),
        group("happy-farm", "ios", "1.5.0", 2),
        group("happy-farm", "android", "1.4.0", 2),
      ],
      [],
    );

    assert.equal(distribution.appId, "happy-farm");
    assert.equal(distribution.displayName, "해피 팜");
    assert.equal(distribution.totalSessions, 10);
    assert.equal(distribution.activeTtlSeconds, 150);
    assert.deepEqual(
      distribution.versions.map((version) => [version.appVersion, version.sessions]),
      [
        ["1.5.0", 8],
        ["1.4.0", 2],
      ],
    );
    assert.equal(distribution.versions[0]?.share, 0.8);
    assert.deepEqual(distribution.versions[0]?.byPlatform, [
      { platform: "android", sessions: 6 },
      { platform: "ios", sessions: 2 },
    ]);
  });

  it("버전을 보고하지 않은 세션을 미상 버킷으로 분리하고 맨 아래에 둔다", () => {
    const [distribution] = buildPlatformVersionDistributions(
      NOW,
      [APPS[0]],
      [
        group("happy-farm", "android", UNKNOWN_APP_VERSION, 3),
        group("happy-farm", "android", "1.5.0", 1),
      ],
      [],
    );

    assert.equal(distribution.unknownSessions, 3);
    assert.deepEqual(
      distribution.versions.map((version) => version.appVersion),
      ["1.5.0", UNKNOWN_APP_VERSION],
    );
  });

  it("세션이 없어도 첫 유입 기록만 있는 빌드를 남긴다", () => {
    const [distribution] = buildPlatformVersionDistributions(
      NOW,
      [APPS[0]],
      [group("happy-farm", "android", "1.5.0", 4)],
      [
        firstSeen("happy-farm", "1.4.0", "godot-native-android", "2026-09-01T00:00:00Z"),
        firstSeen("happy-farm", "1.5.0", "godot-native-android", "2026-09-05T00:00:00Z"),
      ],
    );

    const legacy = distribution.versions.find((version) => version.appVersion === "1.4.0");
    assert.ok(legacy, "유입 기록만 있는 버전이 사라지면 안 된다");
    assert.equal(legacy.sessions, 0);
    assert.equal(legacy.share, 0);
    assert.equal(legacy.firstSeenAt, "2026-09-01T00:00:00.000Z");
    assert.deepEqual(legacy.runtimes, ["godot-native-android"]);
  });

  it("v 접두사가 달라도 같은 빌드로 묶고 첫 유입은 가장 이른 시각을 쓴다", () => {
    const [distribution] = buildPlatformVersionDistributions(
      NOW,
      [APPS[0]],
      [group("happy-farm", "ios", "1.5.0", 2)],
      [
        firstSeen("happy-farm", "v1.5.0", "rn-ios", "2026-09-05T09:00:00Z"),
        firstSeen("happy-farm", "1.5.0", "godot-native-android", "2026-09-04T09:00:00Z"),
      ],
    );

    assert.equal(distribution.versions.length, 1);
    assert.equal(distribution.versions[0]?.firstSeenAt, "2026-09-04T09:00:00.000Z");
    assert.deepEqual(distribution.versions[0]?.runtimes, [
      "godot-native-android",
      "rn-ios",
    ]);
  });

  it("platformAppId가 slug와 다른 앱도 같은 키 공간에서 찾는다", () => {
    const [distribution] = buildPlatformVersionDistributions(
      NOW,
      [APPS[1]],
      [group("ungeul", "ios", "2.0.0", 5)],
      [],
    );

    assert.equal(distribution.appId, "ungeul");
    assert.equal(distribution.displayName, "운글");
  });

  it("관측이 하나도 없는 앱은 목록에 넣지 않는다", () => {
    const distributions = buildPlatformVersionDistributions(NOW, APPS, [], []);
    assert.deepEqual(distributions, []);
  });

  it("활성 세션이 많은 앱을 먼저 보여준다", () => {
    const distributions = buildPlatformVersionDistributions(
      NOW,
      APPS,
      [
        group("happy-farm", "android", "1.5.0", 2),
        group("ungeul", "ios", "2.0.0", 9),
      ],
      [],
    );

    assert.deepEqual(
      distributions.map((distribution) => distribution.appId),
      ["ungeul", "happy-farm"],
    );
  });
});

describe("버전 정렬", () => {
  it("안정 SemVer를 내림차순으로 두고 해석 불가·미상을 뒤로 보낸다", () => {
    const sorted = [
      row("1.4.0"),
      row(UNKNOWN_APP_VERSION),
      row("build-42"),
      row("1.10.0"),
      row("1.5.0"),
    ].sort(compareVersionRows);

    assert.deepEqual(
      sorted.map((version) => version.appVersion),
      ["1.10.0", "1.5.0", "1.4.0", "build-42", UNKNOWN_APP_VERSION],
    );
  });
});

describe("버전 키", () => {
  it("v 접두사와 공백만 걷어낸다", () => {
    assert.equal(appVersionKey(" v1.5.0 "), "1.5.0");
    assert.equal(appVersionKey("1.5.0"), "1.5.0");
    assert.equal(appVersionKey("1.5.0+12"), "1.5.0+12");
  });
});

describe("첫 유입 attributes", () => {
  it("appVersion이 없거나 형이 다르면 버린다", () => {
    assert.equal(readFirstSeenAttributes(null), null);
    assert.equal(readFirstSeenAttributes({}), null);
    assert.equal(readFirstSeenAttributes({ appVersion: "" }), null);
    assert.equal(readFirstSeenAttributes({ appVersion: 150 }), null);
    assert.equal(readFirstSeenAttributes([{ appVersion: "1.0.0" }]), null);
  });

  it("runtime이 없어도 버전은 읽는다", () => {
    assert.deepEqual(readFirstSeenAttributes({ appVersion: "1.0.0" }), {
      appVersion: "1.0.0",
      runtime: "",
    });
  });
});
