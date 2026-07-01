import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveMarketTargets } from "./market-targets";

// marketTargets 는 표준 배포 워크플로우(deploy-google-play.yml / deploy-app-store.yml /
// deploy-apps-in-toss.yml) 존재로만 play/appstore/ait 를 판정하고, web 은 web/ 디렉터리로 판정한다.
// 순서는 play → appstore → ait → web 로 결정적이어야 한다.

test("AIT + Play 워크플로우 존재 → [play, ait] (config 아닌 워크플로우 기반)", () => {
  assert.deepEqual(
    deriveMarketTargets({
      hasPlayWorkflow: true,
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
      hasAppStoreWorkflow: true,
      hasAitWorkflow: false,
      hasWeb: false,
    }),
    ["appstore"],
  );
});
