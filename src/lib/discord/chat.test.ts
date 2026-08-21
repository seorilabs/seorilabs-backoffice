import assert from "node:assert/strict";
import test from "node:test";
import { discordTurnKey } from "@/lib/discord/chat";

test("Discord 대화 조회키에서 메시지 본문과 추가 필드를 제외한다", () => {
  const input = {
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    text: "Prisma where에 들어가면 안 됨",
  };
  assert.deepEqual(discordTurnKey(input), {
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    teammate: null,
  });
});

test("팀원 대화 조회키는 teammate 로 메인 봇 히스토리와 격리된다", () => {
  const key = discordTurnKey({
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    teammate: "data",
  });
  assert.equal(key.teammate, "data");
});
