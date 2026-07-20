import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReleaseDeployButtons,
  deployTargetFromCode,
  resolveDeployButtonStates,
  type DeployButtonState,
  type DeployButtonStates,
  type PlatformDeployTarget,
} from "@/lib/telegram/release-deploy-buttons";

const targets: PlatformDeployTarget[] = ["AIT", "PLAY", "APPSTORE"];
const labels = { AIT: "AppsInToss", PLAY: "Google Play", APPSTORE: "App Store" };

test("플랫폼 버튼은 상태별 라벨과 독립 callback 을 유지한다", () => {
  const states: DeployButtonStates & Record<PlatformDeployTarget, DeployButtonState> = {
    AIT: "TRIGGERED",
    PLAY: "READY",
    APPSTORE: "FAILED",
  };
  const appId = "cm12345678901234567890123";
  const rows = buildReleaseDeployButtons(appId, "v1.2.3", targets, states, labels);

  assert.deepEqual(rows.flat(), [
    { text: "☑️ AppsInToss", callback_data: `ds:${appId}:v1.2.3:a:t` },
    { text: "🚀 Google Play", callback_data: `dq:${appId}:v1.2.3:p:r` },
    { text: "↻ App Store", callback_data: `dq:${appId}:v1.2.3:s:f` },
  ]);
  assert.ok(Buffer.byteLength(rows[1][0].callback_data) <= 64);
  assert.equal(deployTargetFromCode("p"), "PLAY");
  assert.equal(deployTargetFromCode("x"), null);
});

test("플랫폼별 최신 dispatch/run 신호가 서로의 상태를 덮지 않는다", () => {
  const states = resolveDeployButtonStates(
    targets,
    [
      { target: "AIT", createdAt: new Date("2026-07-19T01:00:00Z") },
      { target: "PLAY", createdAt: new Date("2026-07-19T03:00:00Z") },
    ],
    [
      {
        target: "AIT",
        status: "SUCCEEDED",
        updatedAt: new Date("2026-07-19T02:00:00Z"),
      },
      {
        target: "PLAY",
        status: "FAILED",
        updatedAt: new Date("2026-07-19T02:00:00Z"),
      },
    ],
  );

  assert.deepEqual(states, {
    AIT: "SUCCEEDED",
    PLAY: "TRIGGERED",
    APPSTORE: "READY",
  });
});

test("Deploy All dispatch 는 모든 플랫폼을 요청됨 상태로 만든다", () => {
  const states = resolveDeployButtonStates(
    targets,
    [{ target: "ALL", createdAt: new Date("2026-07-19T03:00:00Z") }],
    [],
  );

  assert.deepEqual(states, {
    AIT: "TRIGGERED",
    PLAY: "TRIGGERED",
    APPSTORE: "TRIGGERED",
  });
});
