import assert from "node:assert/strict";
import test from "node:test";
import { createDiscordChannelMessage, editDiscordChannelMessage } from "./discord";

test("PNG 생성·수정에 원래 발신자 토큰과 multipart 첨부를 유지함", async () => {
  const original = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(init!);
    return Response.json({ id: "222" });
  };
  try {
    const options = {
      botToken: "isolated-test-bot",
      attachment: {
        filename: "trend.png",
        contentType: "image/png",
        base64: Buffer.from("test-image").toString("base64"),
      },
    };
    assert.equal((await createDiscordChannelMessage("111", "지표", options)).ok, true);
    assert.equal((await editDiscordChannelMessage("111", "222", "분석 보완", options)).ok, true);
    for (const call of calls) {
      assert.equal(new Headers(call.headers).get("authorization"), "Bot isolated-test-bot");
      assert.ok(call.body instanceof FormData);
      assert.equal(
        JSON.parse(String(call.body.get("payload_json"))).attachments[0].filename,
        "trend.png",
      );
    }
    assert.equal(calls[1].method, "PATCH");
  } finally {
    globalThis.fetch = original;
  }
});
