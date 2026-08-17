import assert from "node:assert/strict";
import test from "node:test";
import { sendDiscord, splitDiscordText } from "@/lib/notifications/discord";
import { htmlToDiscord } from "@/lib/notifications/format";

test("Telegram HTML을 Discord Markdown으로 안전하게 바꾼다", () => {
  assert.equal(
    htmlToDiscord('<b>지표</b> <code>v1</code> <a href="https://example.com">보기</a> &amp; 확인'),
    "**지표** `v1` [보기](https://example.com) & 확인",
  );
});

test("긴 Discord 본문을 embed 제한 안에서 줄 단위로 나눈다", () => {
  const chunks = splitDiscordText(Array.from({ length: 1_000 }, (_, i) => `긴 지표 행 ${i}`).join("\n"));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.length <= 10);
  assert.ok(chunks.every((chunk) => chunk.length <= 4_000));
});

test("Ops 실패 알림은 지정 역할만 mention allowlist에 넣는다", async () => {
  const previousWebhook = process.env.DISCORD_OPS_ALERTS_WEBHOOK_URL;
  const previousFetch = globalThis.fetch;
  process.env.DISCORD_OPS_ALERTS_WEBHOOK_URL =
    "https://discord.com/api/webhooks/1234567890/test_token";
  let bodyText = "";
  globalThis.fetch = async (_input, init) => {
    bodyText = String(init?.body);
    return new Response(JSON.stringify({ id: "message-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await sendDiscord("ops-alerts", "실패", { alertRoleId: "1538854786021990480" });
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    assert.equal(result.messageId, "message-1");
    assert.equal(body.content, "<@&1538854786021990480>");
    assert.deepEqual(body.allowed_mentions, {
      parse: [],
      roles: ["1538854786021990480"],
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWebhook == null) delete process.env.DISCORD_OPS_ALERTS_WEBHOOK_URL;
    else process.env.DISCORD_OPS_ALERTS_WEBHOOK_URL = previousWebhook;
  }
});
