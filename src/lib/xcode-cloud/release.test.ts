import assert from "node:assert/strict";
import test from "node:test";

import { resolveXcodeCloudReleaseBinding } from "./release";

const app = {
  id: "app-saju-reader",
  repoFullName: "seorilabs/saju-reader",
  iosBundle: "com.seorilabs.ungeul",
};

test("snapshot Xcode Cloud 실행은 확인한 app·repo·bundle에 고정된다", () => {
  assert.deepEqual(
    resolveXcodeCloudReleaseBinding({
      app,
      repoFullName: app.repoFullName,
      expectedAppId: app.id,
      expectedIosBundle: app.iosBundle,
    }),
    { appId: app.id, iosBundle: app.iosBundle },
  );
});

test("확인 후 app·repo·bundle readback이 달라지면 mutation 전에 중단한다", () => {
  assert.throws(
    () => resolveXcodeCloudReleaseBinding({
      app,
      repoFullName: app.repoFullName,
      expectedAppId: "app-other",
      expectedIosBundle: app.iosBundle,
    }),
    /앱 ID가 변경/,
  );
  assert.throws(
    () => resolveXcodeCloudReleaseBinding({
      app: { ...app, repoFullName: "seorilabs/other" },
      repoFullName: app.repoFullName,
      expectedAppId: app.id,
      expectedIosBundle: app.iosBundle,
    }),
    /저장소가 변경/,
  );
  assert.throws(
    () => resolveXcodeCloudReleaseBinding({
      app: { ...app, iosBundle: "com.seorilabs.other" },
      repoFullName: app.repoFullName,
      expectedAppId: app.id,
      expectedIosBundle: app.iosBundle,
    }),
    /bundle ID가 변경/,
  );
});

test("stable Xcode Cloud 경로는 기존 repo readback 계약을 유지한다", () => {
  assert.deepEqual(
    resolveXcodeCloudReleaseBinding({ app, repoFullName: app.repoFullName }),
    { appId: app.id, iosBundle: app.iosBundle },
  );
  assert.throws(
    () => resolveXcodeCloudReleaseBinding({
      app: { ...app, iosBundle: null },
      repoFullName: app.repoFullName,
    }),
    /iosBundle 미설정/,
  );
});
