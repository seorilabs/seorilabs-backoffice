import assert from "node:assert/strict";
import test from "node:test";
import { operatorTurnKey } from "@/lib/operator/chat";

test("Slack 대화 조회키에서 메시지 본문과 추가 필드를 제외한다", () => {
  const input = {
    workspaceId: "guild",
    channelId: "channel",
    userId: "user",
    text: "Prisma where에 들어가면 안 됨",
  };
  assert.deepEqual(operatorTurnKey(input), {
    workspaceId: "guild",
    channelId: "channel",
    userId: "user",
  });
});
