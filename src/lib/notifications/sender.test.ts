import assert from "node:assert/strict";
import test from "node:test";
import { SEORI_SENDER, senderBotToken, senderKey } from "@/lib/notifications/sender";

const TOKEN_KEY = "DISCORD_TEAMMATE_SEORI_BOT_TOKEN";

function withToken<T>(value: string | undefined, fn: () => T): T {
  const original = process.env[TOKEN_KEY];
  if (value === undefined) delete process.env[TOKEN_KEY];
  else process.env[TOKEN_KEY] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[TOKEN_KEY];
    else process.env[TOKEN_KEY] = original;
  }
}

test("발신자가 지정되지 않은 알림은 메인 봇으로 나간다", () => {
  withToken("seori-token", () => {
    for (const payload of [null, "text", ["a"], {}, { text: "본문" }]) {
      assert.equal(senderKey(payload as never), null, JSON.stringify(payload));
      assert.equal(senderBotToken(payload as never), undefined, JSON.stringify(payload));
    }
  });
});

test("서리 발신 알림은 서리 봇 토큰으로 나간다", () => {
  const payload = { text: "본문", sender: SEORI_SENDER };
  assert.equal(senderKey(payload), SEORI_SENDER);
  withToken("seori-token", () => {
    assert.equal(senderBotToken(payload), "seori-token");
  });
});

test("토큰이 없으면 메인 봇으로 폴백해 리포트가 사라지지 않는다", () => {
  withToken(undefined, () => {
    assert.equal(senderBotToken({ text: "본문", sender: SEORI_SENDER }), undefined);
  });
  withToken("   ", () => {
    assert.equal(senderBotToken({ text: "본문", sender: SEORI_SENDER }), undefined);
  });
});

test("모르는 발신자 키는 메인 봇으로 나간다", () => {
  withToken("seori-token", () => {
    assert.equal(senderBotToken({ text: "본문", sender: "noeul" }), undefined);
  });
});
