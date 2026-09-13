import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveMarketTargets } from "./market-targets";

// marketTargets 는 표준 배포 워크플로우(deploy-google-play.yml / deploy-apps-in-toss.yml)
// 존재로 play/ait 를 판정한다. appstore 는 GitHub 워크플로가 dispatch 대상이 아니라
// Backoffice 가 ASC ciBuildRuns 로 직접 트리거하므로, App Store 설정과 실제 빌드 경로
// (Xcode Cloud 훅 또는 dispatch 가능한 워크플로)로 판정한다. web 은 web/ 디렉터리로 판정한다.
// 순서는 play → appstore → ait → web 로 결정적이어야 한다.

test("AIT + Play 워크플로우 존재 → [play, ait] (config 아닌 워크플로우 기반)", () => {
  assert.deepEqual(
    deriveMarketTargets({
      hasPlayWorkflow: true,
      hasAppStoreConfig: false,
      hasXcodeCloudScripts: false,
      hasAppStoreWorkflow: false,
      hasAitWorkflow: true,
      hasWeb: false,
    }),
    ["play", "ait"],
  );
});

test("모든 배포 워크플로우 + web 존재 → [play, appstore, ait, web] (결정적 순서)", () => {
  assert.deepEqual(
    deriveMarketTargets({
      hasPlayWorkflow: true,
      hasAppStoreConfig: true,
      hasXcodeCloudScripts: false,
      hasAppStoreWorkflow: true,
      hasAitWorkflow: true,
      hasWeb: true,
    }),
    ["play", "appstore", "ait", "web"],
  );
});

test("표준 배포 워크플로우 없음(Godot: config 만 있고 deploy-godot-pages.yml 뿐) → []", () => {
  // config 존재 여부와 무관하게, 표준 배포 워크플로우가 없으면 마켓 타겟에 포함되지 않는다.
  // 이 케이스가 /deploy 404 근본 원인(config→marketTargets)이었다.
  assert.deepEqual(
    deriveMarketTargets({
      hasPlayWorkflow: false,
      hasAppStoreConfig: false,
      hasXcodeCloudScripts: false,
      hasAppStoreWorkflow: false,
      hasAitWorkflow: false,
      hasWeb: false,
    }),
    [],
  );
});

test("web/ 디렉터리만 존재(마켓 워크플로우 없음) → [web]", () => {
  assert.deepEqual(
    deriveMarketTargets({
      hasPlayWorkflow: false,
      hasAppStoreConfig: false,
      hasXcodeCloudScripts: false,
      hasAppStoreWorkflow: false,
      hasAitWorkflow: false,
      hasWeb: true,
    }),
    ["web"],
  );
});

test("Play 워크플로우만 존재 → [play]", () => {
  assert.deepEqual(
    deriveMarketTargets({
      hasPlayWorkflow: true,
      hasAppStoreConfig: false,
      hasXcodeCloudScripts: false,
      hasAppStoreWorkflow: false,
      hasAitWorkflow: false,
      hasWeb: false,
    }),
    ["play"],
  );
});

test("App Store 워크플로우만 존재 → [appstore]", () => {
  assert.deepEqual(
    deriveMarketTargets({
      hasPlayWorkflow: false,
      hasAppStoreConfig: true,
      hasXcodeCloudScripts: false,
      hasAppStoreWorkflow: true,
      hasAitWorkflow: false,
      hasWeb: false,
    }),
    ["appstore"],
  );
});

// Xcode Cloud 로 이관해 deploy-app-store.yml 을 지운 저장소도 App Store 대상이어야 한다.
// 파일 존재로 판정하던 시절에는 이 경우 appstore 가 통째로 빠졌다.
test("App Store 설정 + Xcode Cloud 훅 존재(워크플로 없음) → [appstore]", () => {
  assert.deepEqual(
    deriveMarketTargets({
      hasPlayWorkflow: false,
      hasAppStoreConfig: true,
      hasXcodeCloudScripts: true,
      hasAppStoreWorkflow: false,
      hasAitWorkflow: false,
      hasWeb: false,
    }),
    ["appstore"],
  );
});

// 설정만 있고 빌드를 만들 수단이 없으면 노출하지 않는다. /deploy 404 의 근본 원인이었다.
test("App Store 설정만 있고 빌드 경로 없음 → []", () => {
  assert.deepEqual(
    deriveMarketTargets({
      hasPlayWorkflow: false,
      hasAppStoreConfig: true,
      hasXcodeCloudScripts: false,
      hasAppStoreWorkflow: false,
      hasAitWorkflow: false,
      hasWeb: false,
    }),
    [],
  );
});
