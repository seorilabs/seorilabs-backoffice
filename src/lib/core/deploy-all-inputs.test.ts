import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeployAllAppStoreInputs,
  buildDeployAllGooglePlayInputs,
} from "@/lib/core/deploy-all-inputs";

test("deploy-all 이 App Store 토글을 선언한 repo 만 그 입력을 받는다", () => {
  assert.deepEqual(
    buildDeployAllAppStoreInputs(new Set(["release_tag", "deploy_ait", "deploy_app_store"])),
    { deploy_app_store: "false" },
  );
});

test("App Store 를 deploy-all 에서 뺀 repo 에는 입력을 보내지 않는다", () => {
  // Xcode Cloud 이관 후 deploy-app-store.yml 을 지운 Godot repo 가 이 형태다.
  // 선언 안 된 입력을 보내면 GitHub 이 422 로 거부해 ALL 배포가 통째로 막힌다.
  assert.deepEqual(
    buildDeployAllAppStoreInputs(new Set(["release_tag", "deploy_google_play", "deploy_ait"])),
    {},
  );
  assert.deepEqual(buildDeployAllAppStoreInputs(new Set()), {});
});

test("Deploy All의 선언된 Play input은 internal upload completed로 고정한다", () => {
  assert.deepEqual(
    buildDeployAllGooglePlayInputs(new Set([
      "release_tag",
      "deploy_google_play",
      "google_play_upload",
      "google_play_track",
      "google_play_release_status",
    ])),
    {
      deploy_google_play: "true",
      google_play_upload: "true",
      google_play_track: "internal",
      google_play_release_status: "completed",
    },
  );
});

test("Play upload을 job에 고정한 Deploy All caller에는 미선언 input을 보내지 않는다", () => {
  assert.deepEqual(
    buildDeployAllGooglePlayInputs(new Set(["release_tag", "deploy_google_play"])),
    { deploy_google_play: "true" },
  );
  assert.deepEqual(buildDeployAllGooglePlayInputs(new Set(["release_tag"])), {});
});
