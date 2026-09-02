import assert from "node:assert/strict";
import test from "node:test";
import { minimaxChat, MinimaxNotConfiguredError } from "./minimax";

const ENV_KEYS = [
  "FEATURE_MINIMAX_ENABLED",
  "MINIMAX_API_KEY",
  "MINIMAX_CHAT_MODEL",
  "MINIMAX_CHAT_TIMEOUT_MS",
  "MINIMAX_API_BASE_URL",
] as const;

function withEnv(run: () => Promise<void>): Promise<void> {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.FEATURE_MINIMAX_ENABLED = "true";
  process.env.MINIMAX_API_KEY = "company-test-key";
  process.env.MINIMAX_CHAT_MODEL = "MiniMax-M3";
  process.env.MINIMAX_CHAT_TIMEOUT_MS = "1000";
  process.env.MINIMAX_API_BASE_URL = "https://api.minimax.io";
  return run().finally(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });
}

test("MiniMax chat은 Anthropic 호환 형식으로 보내고 jsonOutput을 시스템 지시로 강제한다", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({
      content: [
        { type: "thinking", text: "내부 추론" },
        { type: "text", text: "최종 답변" },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    await withEnv(async () => {
      const output = await minimaxChat([
        { role: "system", content: "시스템 규칙" },
        { role: "user", content: "첫 질문" },
        { role: "assistant", content: "첫 답변" },
        { role: "user", content: "후속 질문" },
      ], { maxTokens: 512, jsonOutput: true });

      assert.equal(output, "최종 답변");
      assert.equal(capturedUrl, "https://api.minimax.io/anthropic/v1/messages");
      const headers = capturedInit?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer company-test-key");
      assert.equal(headers["anthropic-version"], "2023-06-01");
      assert.ok(!capturedUrl.includes("company-test-key"));

      const body = JSON.parse(String(capturedInit?.body)) as {
        model: string;
        system: string;
        messages: Array<{ role: string; content: Array<{ text: string }> }>;
        max_tokens: number;
      };
      assert.equal(body.model, "MiniMax-M3");
      assert.match(body.system, /시스템 규칙/u);
      assert.match(body.system, /JSON 객체 하나만/u);
      assert.deepEqual(body.messages.map((m) => m.role), ["user", "assistant", "user"]);
      assert.equal(body.max_tokens, 512);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("base_resp 오류 봉투와 빈 응답은 오류로 던진다", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withEnv(async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ base_resp: { status_code: 1008, status_msg: "insufficient balance" } }), { status: 200 });
      await assert.rejects(
        minimaxChat([{ role: "user", content: "질문" }]),
        /MiniMax API 오류 1008/u,
      );

      globalThis.fetch = async () =>
        new Response(JSON.stringify({ content: [], stop_reason: "max_tokens" }), { status: 200 });
      await assert.rejects(
        minimaxChat([{ role: "user", content: "질문" }]),
        /MiniMax API 빈 응답 \(max_tokens\)/u,
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("미구성 상태에서는 MinimaxNotConfiguredError를 던진다", async () => {
  const original = process.env.FEATURE_MINIMAX_ENABLED;
  delete process.env.FEATURE_MINIMAX_ENABLED;
  try {
    await assert.rejects(
      minimaxChat([{ role: "user", content: "질문" }]),
      MinimaxNotConfiguredError,
    );
  } finally {
    if (original !== undefined) process.env.FEATURE_MINIMAX_ENABLED = original;
  }
});
