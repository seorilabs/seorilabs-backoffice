import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  capabilitiesForRole,
  capabilityForCommand,
  hasOperatorCapability,
  isOperatorScope,
  CHANNEL_CARD_CHANNEL_KEYS,
  interactionChannelKeys,
} from "@/lib/operator/roles";

test("역할 capability accessor 는 사람 역할 경계를 그대로 노출한다", () => {
  // 역할마다 실제 Slack 역할 ID env 가 있어야 의미가 있다. env 없는 역할 키는
  // hasOperatorCapability 에서 영원히 false 라 목록에 두지 않는다.
  assert.deepEqual(capabilitiesForRole("data"), ["read", "metric_incident"]);
  assert.deepEqual(capabilitiesForRole("finance"), []);
  assert.ok(!capabilitiesForRole("qa").includes("release"));
  assert.ok(capabilitiesForRole("qa").includes("release_approval"));
  assert.ok(!capabilitiesForRole("product").includes("release"));
  assert.deepEqual(capabilitiesForRole("unknown-role"), []);
});

test("guild와 허용 채널이 모두 일치해야 interaction scope를 통과한다", () => {
  const expected = { expectedWorkspaceId: "100", allowedChannelIds: ["200"] };
  assert.equal(
    isOperatorScope({
      workspaceId: "100",
      channelId: "200",
      ...expected,
    }),
    true,
  );
  assert.equal(
    isOperatorScope({
      workspaceId: "101",
      channelId: "200",
      ...expected,
    }),
    false,
  );
  assert.equal(
    isOperatorScope({
      workspaceId: "100",
      channelId: "201",
      ...expected,
    }),
    false,
  );
  assert.equal(isOperatorScope({ ...expected }), false);
});

test("버튼은 카드가 놓이는 여러 운영 채널에서 눌릴 수 있다", () => {
  // 배포 카드는 release-ops, 장애 카드는 ops-alerts 에 놓인다. 명령 채널만 허용하면
  // 카드에 붙은 버튼이 전부 거부된다.
  const cards = {
    expectedWorkspaceId: "100",
    allowedChannelIds: ["200", "300", "400"],
  };
  for (const channelId of ["200", "300", "400"]) {
    assert.equal(
      isOperatorScope({ workspaceId: "100", channelId, ...cards }),
      true,
      channelId,
    );
  }
  assert.equal(
    isOperatorScope({ workspaceId: "100", channelId: "999", ...cards }),
    false,
  );
});

test("허용 목록에 미설정 채널의 빈 ID가 섞여도 매칭이 느슨해지지 않는다", () => {
  // env 미설정 채널은 빈 문자열로 허용 목록에 들어온다. 설정된 채널만 통과해야 한다.
  const withEmpty = {
    expectedWorkspaceId: "100",
    allowedChannelIds: ["200", "", ""],
  };
  assert.equal(
    isOperatorScope({
      workspaceId: "100",
      channelId: "200",
      ...withEmpty,
    }),
    true,
  );
  assert.equal(
    isOperatorScope({
      workspaceId: "100",
      channelId: "300",
      ...withEmpty,
    }),
    false,
  );
  // channelId 가 비어 있는 인터랙션은 허용 목록과 무관하게 거부한다.
  assert.equal(
    isOperatorScope({ workspaceId: "100", channelId: "", ...withEmpty }),
    false,
  );
  assert.equal(
    isOperatorScope({
      workspaceId: "100",
      channelId: "",
      expectedWorkspaceId: "100",
      allowedChannelIds: [""],
    }),
    false,
  );
});

test("슬래시 명령과 모달은 #backoffice 로만 제한한다", () => {
  // 명령까지 카드 채널로 넓히면 운영 알림 채널 어디서나 배포를 시작할 수 있게 된다.
  assert.deepEqual([...interactionChannelKeys(false)], ["backoffice"]);
  assert.deepEqual(
    [...interactionChannelKeys(true)],
    [...CHANNEL_CARD_CHANNEL_KEYS],
  );
  assert.ok(
    interactionChannelKeys(true).length > interactionChannelKeys(false).length,
  );
});

test("카드 채널 목록에는 버튼이 실려 나가는 목적지가 모두 들어 있다", () => {
  // 여기서 빠진 채널의 카드는 버튼이 눌리지 않는다. 새 카드 목적지를 추가하면 여기도 갱신한다.
  assert.deepEqual(
    [...CHANNEL_CARD_CHANNEL_KEYS],
    ["backoffice", "release-ops", "ops-alerts", "metrics-daily"],
  );
});

test("Slack 역할별 capability와 명령 매핑을 최소권한으로 제한한다", () => {
  const keys = [
    "CHANNEL_ROLE_VIEWER_ID",
    "CHANNEL_ROLE_RELEASE_OPS_ID",
    "CHANNEL_ROLE_OPERATIONS_ADMIN_ID",
  ] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.CHANNEL_ROLE_VIEWER_ID = "viewer-role";
    process.env.CHANNEL_ROLE_RELEASE_OPS_ID = "release-role";
    process.env.CHANNEL_ROLE_OPERATIONS_ADMIN_ID = "admin-role";
    assert.equal(hasOperatorCapability(["viewer"], "read"), true);
    assert.equal(hasOperatorCapability(["viewer"], "release"), false);
    assert.equal(hasOperatorCapability(["release_ops"], "release"), true);
    assert.equal(hasOperatorCapability(["release_ops"], "vault_index"), false);
    assert.equal(hasOperatorCapability(["operations_admin"], "vault_index"), true);
    assert.equal(capabilityForCommand("deploy"), "release");
    assert.equal(capabilityForCommand("snapshot"), "release");
    assert.equal(capabilityForCommand("save"), "vault_write");
    assert.equal(capabilityForCommand("metrics"), "read");
  } finally {
    for (const key of keys) {
      const value = before[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("interaction 을 받는 배포에 카드 채널 ID env 가 모두 선언돼 있다", () => {
  // /api/discord/interactions 는 웹 배포에서 돈다. 여기 env 가 없으면 채널 ID 가 빈
  // 문자열이 되고, 허용 목록에서 걸러져 그 채널의 버튼이 조용히 전부 거부된다.
  // 실제로 release-ops 카드 버튼이 이 이유로 막혀 있었다.
  const deployment = readFileSync(
    new URL("../../../k8s/deployment.yaml", import.meta.url),
    "utf8",
  );
  for (const key of CHANNEL_CARD_CHANNEL_KEYS) {
    const envName = `SLACK_CHANNEL_${key.toUpperCase().replace(/-/g, "_")}_ID`;
    assert.match(
      deployment,
      new RegExp(`name: ${envName}\\b`),
      `${envName} 미선언`,
    );
  }
});

test("일일보고 채널은 장애 카드 조작만 허용하고 다른 명령·버튼 범위는 넓히지 않는다", () => {
  assert.ok(
    interactionChannelKeys(true, "incident:resolve:case1").includes("app-ops"),
  );
  assert.ok(
    !interactionChannelKeys(true, "rdeploy:web:app:tag").includes("app-ops"),
  );
  assert.ok(
    !interactionChannelKeys(false, "incident:resolve:case1").includes(
      "app-ops",
    ),
  );
});
