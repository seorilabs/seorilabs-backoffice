import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityForCommand,
  hasDiscordCapability,
  isDiscordInteractionScope,
  DISCORD_CARD_CHANNEL_KEYS,
  interactionChannelKeys,
} from "@/lib/discord/roles";

test("guild와 허용 채널이 모두 일치해야 interaction scope를 통과한다", () => {
  const expected = { expectedGuildId: "100", allowedChannelIds: ["200"] };
  assert.equal(isDiscordInteractionScope({ guildId: "100", channelId: "200", ...expected }), true);
  assert.equal(isDiscordInteractionScope({ guildId: "101", channelId: "200", ...expected }), false);
  assert.equal(isDiscordInteractionScope({ guildId: "100", channelId: "201", ...expected }), false);
  assert.equal(isDiscordInteractionScope({ ...expected }), false);
});

test("버튼은 카드가 놓이는 여러 운영 채널에서 눌릴 수 있다", () => {
  // 배포 카드는 release-ops, 장애 카드는 ops-alerts 에 놓인다. 명령 채널만 허용하면
  // 카드에 붙은 버튼이 전부 거부된다.
  const cards = { expectedGuildId: "100", allowedChannelIds: ["200", "300", "400"] };
  for (const channelId of ["200", "300", "400"]) {
    assert.equal(isDiscordInteractionScope({ guildId: "100", channelId, ...cards }), true, channelId);
  }
  assert.equal(isDiscordInteractionScope({ guildId: "100", channelId: "999", ...cards }), false);
});

test("미설정 채널의 빈 ID는 허용 목록을 느슨하게 만들지 않는다", () => {
  // env 미설정 채널은 빈 문자열로 들어온다. 걸러내지 않으면 channelId 가 비어도 통과한다.
  const withEmpty = { expectedGuildId: "100", allowedChannelIds: ["200", "", ""] };
  assert.equal(isDiscordInteractionScope({ guildId: "100", channelId: "", ...withEmpty }), false);
  assert.equal(isDiscordInteractionScope({ guildId: "100", channelId: "200", ...withEmpty }), true);
});

test("슬래시 명령과 모달은 #backoffice 로만 제한한다", () => {
  // 명령까지 카드 채널로 넓히면 운영 알림 채널 어디서나 배포를 시작할 수 있게 된다.
  assert.deepEqual([...interactionChannelKeys(false)], ["backoffice"]);
  assert.deepEqual([...interactionChannelKeys(true)], [...DISCORD_CARD_CHANNEL_KEYS]);
  assert.ok(interactionChannelKeys(true).length > interactionChannelKeys(false).length);
});

test("카드 채널 목록에는 버튼이 실려 나가는 목적지가 모두 들어 있다", () => {
  // 여기서 빠진 채널의 카드는 버튼이 눌리지 않는다. 새 카드 목적지를 추가하면 여기도 갱신한다.
  assert.deepEqual([...DISCORD_CARD_CHANNEL_KEYS], [
    "backoffice",
    "release-ops",
    "ops-alerts",
    "metrics-daily",
  ]);
});

test("Discord 역할별 capability와 명령 매핑을 최소권한으로 제한한다", () => {
  const keys = [
    "DISCORD_ROLE_VIEWER_ID",
    "DISCORD_ROLE_RELEASE_OPS_ID",
    "DISCORD_ROLE_OPERATIONS_ADMIN_ID",
  ] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.DISCORD_ROLE_VIEWER_ID = "viewer-role";
    process.env.DISCORD_ROLE_RELEASE_OPS_ID = "release-role";
    process.env.DISCORD_ROLE_OPERATIONS_ADMIN_ID = "admin-role";
    assert.equal(hasDiscordCapability(["viewer-role"], "read"), true);
    assert.equal(hasDiscordCapability(["viewer-role"], "release"), false);
    assert.equal(hasDiscordCapability(["release-role"], "release"), true);
    assert.equal(hasDiscordCapability(["release-role"], "vault_index"), false);
    assert.equal(hasDiscordCapability(["admin-role"], "vault_index"), true);
    assert.equal(capabilityForCommand("deploy"), "release");
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
