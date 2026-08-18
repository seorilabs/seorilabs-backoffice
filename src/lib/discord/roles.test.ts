import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityForCommand,
  hasDiscordCapability,
  isDiscordInteractionScope,
} from "@/lib/discord/roles";

test("guild와 backoffice 채널이 모두 일치해야 interaction scope를 통과한다", () => {
  const expected = { expectedGuildId: "100", expectedChannelId: "200" };
  assert.equal(isDiscordInteractionScope({ guildId: "100", channelId: "200", ...expected }), true);
  assert.equal(isDiscordInteractionScope({ guildId: "101", channelId: "200", ...expected }), false);
  assert.equal(isDiscordInteractionScope({ guildId: "100", channelId: "201", ...expected }), false);
  assert.equal(isDiscordInteractionScope({ ...expected }), false);
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
