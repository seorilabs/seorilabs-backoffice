import assert from "node:assert/strict";
import test from "node:test";
import { createDiscordChannelMessage, startDiscordThread } from "@/lib/notifications/discord";

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

async function withDiscord(
  respond: (captured: Captured) => Response,
  run: (calls: Captured[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "test-token";
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const captured: Captured = {
      url: String(url),
      method: String(init?.method),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    calls.push(captured);
    return respond(captured);
  }) as typeof globalThis.fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = originalToken;
  }
}

test("쓰레드는 카드 메시지에서 시작하고 24시간 뒤 자동 보관된다", async () => {
  await withDiscord(
    () => new Response(JSON.stringify({ id: "222" }), { status: 201 }),
    async (calls) => {
      const result = await startDiscordThread("111", "222", "도마뱀 테라리움 신규 계정 2026-08-21");
      assert.equal(result.ok, true);
      // 메시지에서 시작한 thread는 ID가 원본 메시지 ID와 같다.
      assert.equal(result.messageId, "222");
      assert.equal(calls[0].method, "POST");
      assert.match(calls[0].url, /\/channels\/111\/messages\/222\/threads$/);
      assert.equal(calls[0].body.auto_archive_duration, 1_440);
      assert.equal(calls[0].body.name, "도마뱀 테라리움 신규 계정 2026-08-21");
    },
  );
});

test("이미 쓰레드가 있으면 실패가 아니라 같은 메시지 ID를 돌려준다", async () => {
  await withDiscord(
    () => new Response(JSON.stringify({ code: 160_004, message: "..." }), { status: 400 }),
    async () => {
      // 그날 두 번째 댓글부터는 항상 이 경로다. 실패로 처리하면 댓글이 영영 안 붙는다.
      const result = await startDiscordThread("111", "222", "이름");
      assert.equal(result.ok, true);
      assert.equal(result.messageId, "222");
    },
  );
});

test("다른 Discord 오류는 그대로 실패로 전달한다", async () => {
  await withDiscord(
    () => new Response(JSON.stringify({ code: 50_013, message: "Missing Permissions" }), { status: 403 }),
    async () => {
      const result = await startDiscordThread("111", "222", "이름");
      assert.equal(result.ok, false);
      assert.equal(result.statusCode, 403);
      assert.equal(result.errorCode, 50_013);
    },
  );
});

test("쓰레드 이름은 Discord 상한인 100자로 자른다", async () => {
  await withDiscord(
    () => new Response(JSON.stringify({ id: "222" }), { status: 201 }),
    async (calls) => {
      await startDiscordThread("111", "222", "가".repeat(120));
      assert.equal(String(calls[0].body.name).length, 100);
    },
  );
});

test("한 줄 기록은 embed 없이 본문으로 나가고 멘션은 본문 앞에 붙는다", async () => {
  await withDiscord(
    () => new Response(JSON.stringify({ id: "333" }), { status: 201 }),
    async (calls) => {
      await createDiscordChannelMessage("222", "`#17` · 15:21:35", { plain: true });
      assert.equal(calls[0].body.content, "`#17` · 15:21:35");
      assert.equal(calls[0].body.embeds, undefined);

      await createDiscordChannelMessage("222", "`#1` · 00:02:59", {
        plain: true,
        alertRoleId: "987",
      });
      assert.equal(calls[1].body.content, "<@&987> `#1` · 00:02:59");
      assert.deepEqual(calls[1].body.allowed_mentions, { parse: [], roles: ["987"] });
    },
  );
});

test("본문이 비면 멘션만 남은 메시지를 보내지 않는다", async () => {
  await withDiscord(
    () => new Response(JSON.stringify({ id: "333" }), { status: 201 }),
    async (calls) => {
      const result = await createDiscordChannelMessage("222", "   ", {
        plain: true,
        alertRoleId: "987",
      });
      assert.equal(result.ok, false);
      assert.equal(calls.length, 0);
    },
  );
});

test("기본 메시지는 그대로 embed로 나간다", async () => {
  await withDiscord(
    () => new Response(JSON.stringify({ id: "333" }), { status: 201 }),
    async (calls) => {
      await createDiscordChannelMessage("222", "👤 **오늘 신규 계정 17명**");
      assert.deepEqual(calls[0].body.embeds, [{ description: "👤 **오늘 신규 계정 17명**" }]);
      assert.equal(calls[0].body.content, undefined);
    },
  );
});

test("ID 형식이 아니면 Discord를 호출하지 않는다", async () => {
  await withDiscord(
    () => new Response("{}", { status: 200 }),
    async (calls) => {
      assert.equal((await startDiscordThread("", "222", "이름")).ok, false);
      assert.equal((await startDiscordThread("111", "", "이름")).ok, false);
      assert.equal((await startDiscordThread("111", "222", "   ")).ok, false);
      assert.equal(calls.length, 0);
    },
  );
});
