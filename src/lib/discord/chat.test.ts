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

test("대화는 메인 봇 하나뿐이라 조회키의 teammate 축은 항상 null 이다", () => {
  // discord_turn.teammate 컬럼은 contract 단계에서 제거될 때까지 남는다. 키가 null 을
  // 빠뜨리면 기존 행과 복합 인덱스를 벗어나 히스토리가 끊긴다.
  const key = discordTurnKey({ guildId: "guild", channelId: "channel", userId: "user" });
  assert.equal(key.teammate, null);
});
