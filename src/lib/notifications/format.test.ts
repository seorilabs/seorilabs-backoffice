import assert from "node:assert/strict";
import test from "node:test";
import {
  editDiscord,
  editDiscordChannelMessage,
  sendDiscord,
  splitDiscordText,
} from "@/lib/notifications/discord";
import { discordRender, htmlToDiscord } from "@/lib/notifications/format";

test("과거 HTML 본문을 Discord Markdown으로 변환한다", () => {
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

test("embed 는 한 메시지 합계 6,000자를 넘지 않고, 잘린 사실을 남긴다", () => {
  // Discord 는 모든 embed 의 title·description·footer 합이 6,000자를 넘으면 400 으로
  // 거절한다. description 4,000 × 10 개라는 계산은 이 상한을 모르는 값이다.
  const chunks = splitDiscordText("행\n".repeat(20_000));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  assert.ok(total <= 6_000, `합계 ${total}`);
  assert.match(chunks.at(-1) ?? "", /길이 제한으로 이하 생략/);
});

test("제목과 footer 도 같은 6,000자 예산에서 나간다", () => {
  const body = "행\n".repeat(20_000);
  const full = splitDiscordText(body);
  const reserved = splitDiscordText(body, 6_000 - 300);
  const sum = (chunks: string[]) => chunks.reduce((total, chunk) => total + chunk.length, 0);
  assert.equal(sum(full) - sum(reserved), 300);
});

test("discordRender 는 plain·embed·무효 payload 를 가른다", () => {
  assert.deepEqual(discordRender("OPS_ALERT", { text: "한 줄", plain: true }), {
    text: "한 줄",
    plain: true,
  });
  assert.deepEqual(
    discordRender("OPS_ALERT", {
      text: "리포트",
      embed: { title: "제목", color: 0x2FA55C, footer: "2026-09-16 KST" },
    }),
    { text: "리포트", embed: { title: "제목", color: 0x2FA55C, footer: "2026-09-16 KST" } },
  );
  // 배포 카드 본문은 payload 에 없다. ReleaseRecord 로 매번 다시 그린다.
  assert.equal(discordRender("DEPLOY_COMPLETION", { text: "카드" }), null);
  assert.equal(discordRender("OPS_ALERT", { text: "" }), null);
  assert.equal(discordRender("OPS_ALERT", null), null);
  // 값이 계약을 벗어나면 그 키만 버리고 본문은 살린다.
  assert.deepEqual(discordRender("OPS_ALERT", { text: "본문", embed: { color: -1, url: "javascript:x" } }), {
    text: "본문",
  });
});

async function withDiscordEnv(run: () => Promise<void>) {
  const keys = ["DISCORD_BOT_TOKEN", "DISCORD_CHANNEL_OPS_ALERTS_ID", "DISCORD_CHANNEL_RELEASE_OPS_ID"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.DISCORD_BOT_TOKEN = "test-bot-token";
  process.env.DISCORD_CHANNEL_OPS_ALERTS_ID = "1538853137862098954";
  process.env.DISCORD_CHANNEL_RELEASE_OPS_ID = "1538853052818264225";
  try {
    await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Ops 실패 알림은 지정 역할만 mention allowlist에 넣는다", async () => {
  await withDiscordEnv(async () => {
    const previousFetch = globalThis.fetch;
    let bodyText = "";
    let auth = "";
    let requestUrl = "";
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      bodyText = String(init?.body);
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ id: "1234567890" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const result = await sendDiscord("ops-alerts", "실패", { alertRoleId: "1538854786021990480" });
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      assert.equal(result.messageId, "1234567890");
      assert.equal(auth, "Bot test-bot-token");
      assert.equal(requestUrl, "https://discord.com/api/v10/channels/1538853137862098954/messages");
      assert.equal(body.content, "<@&1538854786021990480>");
      assert.deepEqual(body.allowed_mentions, { parse: [], roles: ["1538854786021990480"] });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("Discord Bot 메시지를 같은 channel/message ID로 수정한다", async () => {
  await withDiscordEnv(async () => {
    const previousFetch = globalThis.fetch;
    let requestUrl = "";
    let requestMethod = "";
    let bodyText = "";
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestMethod = String(init?.method);
      bodyText = String(init?.body);
      return new Response(JSON.stringify({ id: "9876543210" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const result = await editDiscord("release-ops", "9876543210", "진행 중");
      const body = JSON.parse(bodyText) as {
        content?: string;
        components?: unknown[];
        embeds?: Array<{ description?: string }>;
      };
      assert.equal(result.ok, true);
      assert.equal(requestMethod, "PATCH");
      assert.equal(requestUrl, "https://discord.com/api/v10/channels/1538853052818264225/messages/9876543210");
      assert.equal(body.content, "");
      assert.deepEqual(body.components, []);
      assert.equal(body.embeds?.[0]?.description, "진행 중");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("삭제된 Discord 카드의 Unknown Message를 복구 가능하게 전달한다", async () => {
  await withDiscordEnv(async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 10_008, message: "Unknown Message" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
    try {
      const result = await editDiscord("release-ops", "9876543210", "완료");
      assert.equal(result.ok, false);
      assert.equal(result.statusCode, 404);
      assert.equal(result.errorCode, 10_008);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("명령 결과 수정은 확인 버튼이 남긴 진행 중 content와 버튼을 비운다", async () => {
  await withDiscordEnv(async () => {
    const previousFetch = globalThis.fetch;
    let bodyText = "";
    globalThis.fetch = async (input, init) => {
      bodyText = String(init?.body);
      return new Response(JSON.stringify({ id: "1539418059209445457" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const result = await editDiscordChannelMessage(
        "1539210290917277706",
        "1539418059209445457",
        "🚀 배포 트리거 완료",
      );
      const body = JSON.parse(bodyText) as {
        content?: string;
        components?: unknown[];
        embeds?: Array<{ description?: string }>;
      };
      assert.equal(result.ok, true);
      // PATCH 는 누락 필드를 보존한다. content 를 비우지 않으면 "⏳ 실행 중…" 이 남아
      // 결과 embed 를 붙여도 메시지가 계속 진행 중으로 읽힌다.
      assert.equal(body.content, "");
      assert.deepEqual(body.components, []);
      assert.equal(body.embeds?.[0]?.description, "🚀 배포 트리거 완료");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("명령 결과에 버튼이 있으면 비우지 않고 그대로 실어 보낸다", async () => {
  await withDiscordEnv(async () => {
    const previousFetch = globalThis.fetch;
    let bodyText = "";
    globalThis.fetch = async (input, init) => {
      bodyText = String(init?.body);
      return new Response(JSON.stringify({ id: "1539418059209445457" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await editDiscordChannelMessage("1539210290917277706", "1539418059209445457", "확인 필요", {
        components: [{ type: 1, components: [{ type: 2, style: 4, label: "실행", custom_id: "command:confirm:x" }] }],
      });
      const body = JSON.parse(bodyText) as { content?: string; components?: Array<{ type?: number }> };
      assert.equal(body.content, "");
      assert.equal(body.components?.length, 1);
      assert.equal(body.components?.[0]?.type, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("plain 본문이 2,000자를 넘으면 잘라내지 않고 embed 로 떨어뜨린다", async () => {
  await withDiscordEnv(async () => {
    const previousFetch = globalThis.fetch;
    let bodyText = "";
    globalThis.fetch = async (input, init) => {
      bodyText = String(init?.body);
      return new Response(JSON.stringify({ id: "1234567890" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const long = "로그 한 줄이 예외적으로 길어졌다. ".repeat(200);
      assert.ok(long.length > 2_000);
      await sendDiscord("ops-alerts", long, { plain: true });
      const body = JSON.parse(bodyText) as { content?: string; embeds?: Array<{ description?: string }> };
      // 잘라내면 끝부분이 말없이 사라진다. 상자에 담겨 전부 도착하는 편이 낫다.
      assert.equal(body.content, undefined);
      assert.ok((body.embeds?.[0]?.description?.length ?? 0) > 2_000);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("구조화 embed 메타는 첫 상자에만 얹고 색은 전부에 건다", async () => {
  await withDiscordEnv(async () => {
    const previousFetch = globalThis.fetch;
    let bodyText = "";
    globalThis.fetch = async (input, init) => {
      bodyText = String(init?.body);
      return new Response(JSON.stringify({ id: "1234567890" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await sendDiscord("ops-alerts", "행\n".repeat(3_000), {
        embed: {
          title: "배포 · 운글 v1.0.32",
          color: 0x2FA55C,
          footer: "2026-09-16 KST",
          timestamp: "2026-09-16T07:33:48.834Z",
        },
      });
      const body = JSON.parse(bodyText) as {
        embeds?: Array<{ title?: string; color?: number; footer?: unknown; timestamp?: string }>;
      };
      const embeds = body.embeds ?? [];
      assert.ok(embeds.length > 1);
      assert.equal(embeds[0].title, "배포 · 운글 v1.0.32");
      assert.deepEqual(embeds[0].footer, { text: "2026-09-16 KST" });
      assert.equal(embeds[0].timestamp, "2026-09-16T07:33:48.834Z");
      // 제목이 상자마다 반복되면 이어지지 않고 끊어져 읽힌다.
      assert.ok(embeds.slice(1).every((embed) => embed.title === undefined));
      // 색은 전부에 걸어 한 기둥으로 보이게 한다.
      assert.ok(embeds.every((embed) => embed.color === 0x2FA55C));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
