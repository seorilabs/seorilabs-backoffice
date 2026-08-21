import assert from "node:assert/strict";
import test from "node:test";
import { capabilitiesForRole, DISCORD_CARD_CHANNEL_KEYS } from "@/lib/discord/roles";
import {
  configuredTeammates,
  isTeammateRole,
  shouldHandleTeammateMention,
  stripMentionTags,
  TEAMMATE_ROLES,
  TEAMMATES,
} from "@/lib/discord/teammates";

test("팀원 4명이 모두 정의되고 capability 는 사람 역할을 그대로 상속한다", () => {
  assert.deepEqual(TEAMMATE_ROLES, ["product", "data", "development", "qa"]);
  for (const role of TEAMMATE_ROLES) {
    const meta = TEAMMATES[role];
    assert.equal(meta.role, role);
    assert.ok(meta.ko.startsWith("서리"));
    assert.deepEqual(meta.capabilities, capabilitiesForRole(role));
    assert.ok(meta.capabilities.length > 0);
  }
});

test("팀원 보고 채널은 전부 카드 버튼 allowlist 채널이다", () => {
  for (const role of TEAMMATE_ROLES) {
    assert.ok(
      (DISCORD_CARD_CHANNEL_KEYS as readonly string[]).includes(TEAMMATES[role].channelKey),
      `${role} 채널 ${TEAMMATES[role].channelKey} 이 카드 채널이 아니다`,
    );
  }
});

test("isTeammateRole 은 사람 전용 역할을 거른다", () => {
  assert.ok(isTeammateRole("data"));
  assert.ok(!isTeammateRole("operator"));
  assert.ok(!isTeammateRole(""));
});

test("봇이 보낸 메시지와 다른 길드 메시지는 응답 대상이 아니다", () => {
  const base = {
    id: "m1",
    guild_id: "g1",
    channel_id: "c1",
    content: "<@bot1> 안녕",
    author: { id: "u1", bot: false },
    mentions: [{ id: "bot1" }],
  };
  assert.ok(shouldHandleTeammateMention(base, "bot1", "g1"));
  assert.ok(!shouldHandleTeammateMention({ ...base, author: { id: "u2", bot: true } }, "bot1", "g1"));
  assert.ok(!shouldHandleTeammateMention({ ...base, guild_id: "g2" }, "bot1", "g1"));
  assert.ok(!shouldHandleTeammateMention({ ...base, mentions: [{ id: "other" }] }, "bot1", "g1"));
  assert.ok(!shouldHandleTeammateMention({ ...base, mentions: [] }, "bot1", "g1"));
  assert.ok(!shouldHandleTeammateMention(base, "", "g1"));
  assert.ok(!shouldHandleTeammateMention({ ...base, id: undefined }, "bot1", "g1"));
});

test("멘션 태그를 벗겨 사용자 발화만 남긴다", () => {
  assert.equal(stripMentionTags("<@bot1> 이번 주 지표 어때?", "bot1"), "이번 주 지표 어때?");
  assert.equal(stripMentionTags("<@!bot1>  상태  보고", "bot1"), "상태 보고");
  assert.equal(stripMentionTags("<@bot1>", "bot1"), "");
});

test("기능 플래그가 꺼져 있으면 설정된 팀원이 없다", () => {
  const original = process.env.FEATURE_DISCORD_TEAMMATES;
  delete process.env.FEATURE_DISCORD_TEAMMATES;
  try {
    assert.deepEqual(configuredTeammates(), []);
  } finally {
    if (original !== undefined) process.env.FEATURE_DISCORD_TEAMMATES = original;
  }
});

test("플래그가 켜지면 자격증명이 주입된 팀원만 활성화된다", () => {
  const saved = {
    flag: process.env.FEATURE_DISCORD_TEAMMATES,
    appId: process.env.DISCORD_TEAMMATE_DATA_APPLICATION_ID,
    token: process.env.DISCORD_TEAMMATE_DATA_BOT_TOKEN,
  };
  process.env.FEATURE_DISCORD_TEAMMATES = "true";
  process.env.DISCORD_TEAMMATE_DATA_APPLICATION_ID = "app";
  process.env.DISCORD_TEAMMATE_DATA_BOT_TOKEN = "token";
  try {
    const roles = configuredTeammates().map((meta) => meta.role);
    assert.ok(roles.includes("data"));
    assert.ok(!roles.includes("qa"));
  } finally {
    if (saved.flag === undefined) delete process.env.FEATURE_DISCORD_TEAMMATES;
    else process.env.FEATURE_DISCORD_TEAMMATES = saved.flag;
    if (saved.appId === undefined) delete process.env.DISCORD_TEAMMATE_DATA_APPLICATION_ID;
    else process.env.DISCORD_TEAMMATE_DATA_APPLICATION_ID = saved.appId;
    if (saved.token === undefined) delete process.env.DISCORD_TEAMMATE_DATA_BOT_TOKEN;
    else process.env.DISCORD_TEAMMATE_DATA_BOT_TOKEN = saved.token;
  }
});
