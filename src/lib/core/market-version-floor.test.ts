import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTagAtOrAboveMarketFloor,
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

test("마켓 원장보다 낮은 명시 태그와 배포 태그를 거부한다", () => {
  assert.throws(
    () =>
      resolveReleaseTagWithMarketFloor({
        latestTag: "v0.0.2",
        marketFloor: "v1.0.3",
        explicitTag: "v0.0.3",
        bump: "patch",
      }),
    /v0\.0\.3.*마켓 원장 v1\.0\.3/s,
  );
  assert.throws(
    () => assertTagAtOrAboveMarketFloor("v0.0.2", "v1.0.3"),
    /v0\.0\.2.*v1\.0\.3/s,
  );
});

test("마켓 원장과 같은 명시 태그는 새 build를 위해 허용한다", () => {
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
