import assert from "node:assert/strict";
import test from "node:test";
import { claudeChat, ClaudeNotConfiguredError } from "./claude";

const ENV_KEYS = ["FEATURE_MULTI_LLM", "ANTHROPIC_API_KEY", "ANTHROPIC_EFFORT"] as const;

test("Claude chat 은 system 분리·모델 오버라이드·effort 를 요청에 싣는다", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  process.env.FEATURE_MULTI_LLM = "true";
  process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "최종 답변" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const output = await claudeChat(
      [
        { role: "system", content: "시스템 규칙" },
        { role: "user", content: "질문" },
        { role: "assistant", content: "답변" },
        { role: "user", content: "후속" },
      ],
      { maxTokens: 512, model: "claude-opus-5" },
    );
    assert.equal(output, "최종 답변");
    assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "anthropic-test-key");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.model, "claude-opus-5");
    assert.equal(body.system, "시스템 규칙");
    assert.equal(body.max_tokens, 512);
    assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ["user", "assistant", "user"]);
    assert.equal(body.output_config.effort, "low");
    // 현행 모델은 thinking·temperature 를 보내면 안 된다.
    assert.equal("thinking" in body, false);
    assert.equal("temperature" in body, false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test("Claude 429 는 공용 재시도 가드가 매칭하는 형식으로 던진다", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.FEATURE_MULTI_LLM = "true";
  process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
  globalThis.fetch = async () => new Response("rate limited", { status: 429 });
  try {
    await assert.rejects(
      claudeChat([{ role: "user", content: "질문" }]),
      /Claude API 요청 실패 \(429\)/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test("플래그나 키가 없으면 fail-closed 로 던진다", async () => {
  const original = process.env.FEATURE_MULTI_LLM;
  delete process.env.FEATURE_MULTI_LLM;
  try {
    await assert.rejects(claudeChat([{ role: "user", content: "질문" }]), ClaudeNotConfiguredError);
  } finally {
    if (original !== undefined) process.env.FEATURE_MULTI_LLM = original;
  }
});
