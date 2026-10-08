import assert from "node:assert/strict";
import test from "node:test";
import { shouldDeferRead, completeDeferredRead } from "./deferred-read";
const interaction = {
  id: "1",
  application_id: "22",
  token: "isolated-test",
  type: 2,
  data: { name: "report" },
};
test("느린 조회는 DB 접근 전에 예약하고 modal·버튼·자동완성은 원래 응답 방식 유지", () => {
  assert.equal(shouldDeferRead(interaction), true);
  assert.equal(shouldDeferRead({ ...interaction, type: 4 }), false);
  assert.equal(shouldDeferRead({ ...interaction, data: { name: "plan" } }), false);
});
test("예약한 조회 실패도 안전한 원문 응답으로 마무리하고 멘션을 차단", async () => {
  let body: Record<string, unknown> = {};
  await completeDeferredRead(
    interaction,
    async () => {
      throw new Error("sensitive");
    },
    async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ id: "33" });
    },
  );
  assert.match(String(body.content), /조회에 실패/);
  assert.doesNotMatch(String(body.content), /sensitive/);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
});
