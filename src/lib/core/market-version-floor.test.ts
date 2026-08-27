import assert from "node:assert/strict";
import test from "node:test";

import {
  marketVersionFloorFromConfigs,
  resolveReleaseTagWithMarketFloor,
} from "@/lib/core/market-version-floor";

test("Google Play와 App Store config 중 높은 버전을 마켓 floor로 사용한다", () => {
  assert.equal(
    marketVersionFloorFromConfigs({
      googlePlay: { versionName: "1.0.3" },
      appStore: { build: { marketingVersion: "1.0" } },
    }),
    "v1.0.3",
  );
});

test("release.* 구조의 마켓 config도 floor로 읽는다", () => {
  // lizard-tycoon 실제 구조. 이전에는 두 값 모두 못 읽어 floor 가 null 이었다.
  assert.equal(
    marketVersionFloorFromConfigs({
      googlePlay: { release: { versionName: "1.0.11" } },
      appStore: { release: { appleMarketingVersion: "1.0" } },
    }),
    "v1.0.11",
  );
});

test("최상위 키와 release.* 키가 섞여 있어도 최댓값을 floor로 쓴다", () => {
  // lucid-chess 실제 구조: Play 는 release.versionName, App Store 는 build.marketingVersion.
  assert.equal(
    marketVersionFloorFromConfigs({
      googlePlay: { release: { versionName: "1.0.2" } },
      appStore: { build: { marketingVersion: "3.0.1" } },
    }),
    "v3.0.1",
  );
  // 같은 config 안에 두 위치가 다 있으면 더 높은 쪽을 쓴다.
  assert.equal(
    marketVersionFloorFromConfigs({
      googlePlay: { versionName: "1.0.10", release: { versionName: "1.2.0" } },
      appStore: null,
    }),
    "v1.2.0",
  );
});

test("마켓 버전이 어디에도 없으면 floor 가 없다", () => {
  assert.equal(
    marketVersionFloorFromConfigs({ googlePlay: { track: "internal" }, appStore: {} }),
    null,
  );
  assert.equal(marketVersionFloorFromConfigs({ googlePlay: null, appStore: null }), null);
});

test("release.* 값이 stable SemVer가 아니면 조용히 무시하지 않고 실패한다", () => {
  assert.throws(
    () =>
      marketVersionFloorFromConfigs({
        googlePlay: { release: { versionName: "1.0.0-beta" } },
        appStore: null,
      }),
    /release.versionName가 stable SemVer가 아닙니다/,
  );
});

test("태그 계보가 마켓 원장보다 낮으면 마켓 기준으로 bump한다", () => {
  assert.equal(
    resolveReleaseTagWithMarketFloor({
      latestTag: "v0.0.2",
      marketFloor: "v1.0.3",
      bump: "patch",
    }),
    "v1.0.4",
  );
});

// 인수조건: 마켓 floor 는 추천용이다. 배포 허가는 소스 계약이 판단한다.
test("명시 태그는 마켓 원장과 비교하지 않고 그대로 쓴다", () => {
  assert.equal(
    resolveReleaseTagWithMarketFloor({
      latestTag: "v0.0.2",
      marketFloor: "v1.0.3",
      explicitTag: "v0.0.3",
      bump: "patch",
    }),
    "v0.0.3",
  );
});

test("명시 태그는 정규화만 거친다", () => {
  assert.equal(
    resolveReleaseTagWithMarketFloor({
      latestTag: "v0.0.2",
      marketFloor: "v1.0.3",
      explicitTag: "1.0.3",
      bump: "patch",
    }),
    "v1.0.3",
  );
});
