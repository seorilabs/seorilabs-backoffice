import assert from "node:assert/strict";
import test from "node:test";
import { ephemeral, updateMessage } from "@/lib/discord/responses";
import { EPHEMERAL_FLAG, InteractionResponseType } from "@/lib/discord/types";

test("ephemeral 버튼 결과는 새 답글 대신 원래 확인창을 갱신할 수 있다", () => {
  const created = ephemeral("확인");
  const updated = updateMessage("실행 중");

  assert.equal(created.type, InteractionResponseType.CHANNEL_MESSAGE);
  assert.equal(created.data.flags, EPHEMERAL_FLAG);
  assert.equal(updated.type, InteractionResponseType.UPDATE_MESSAGE);
  assert.deepEqual(updated.data.components, []);
  assert.ok(!("flags" in updated.data));
});
