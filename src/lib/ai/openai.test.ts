import assert from "node:assert/strict";
import test from "node:test";
import { openaiChat, OpenAiNotConfiguredError } from "./openai";

const ENV_KEYS = ["FEATURE_MULTI_LLM", "OPENAI_API_KEY", "OPENAI_REASONING_EFFORT"] as const;

function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

test("OpenAI chat 은 Chat Completions 계약(max_completion_tokens·json_object)을 따른다", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  process.env.FEATURE_MULTI_LLM = "true";
  process.env.OPENAI_API_KEY = "openai-test-key";
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "최종 답변" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const output = await withEnv(() =>
      openaiChat(
        [
          { role: "system", content: "시스템 규칙" },
          { role: "user", content: "질문" },
        ],
        { maxTokens: 512, jsonOutput: true, model: "gpt-5.6-terra" },
      ),
    );
    assert.equal(output, "최종 답변");
    assert.equal(capturedUrl, "https://api.openai.com/v1/chat/completions");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer openai-test-key");
    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.model, "gpt-5.6-terra");
    // GPT-5 계열은 max_tokens 가 아니라 max_completion_tokens 를 받는다.
    assert.equal(body.max_completion_tokens, 512);
    assert.equal("max_tokens" in body, false);
    assert.equal(body.reasoning_effort, "minimal");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ["system", "user"]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test("OpenAI 429 는 공용 재시도 가드가 매칭하는 형식으로 던진다", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.FEATURE_MULTI_LLM = "true";
  process.env.OPENAI_API_KEY = "openai-test-key";
  globalThis.fetch = async () => new Response("rate limited", { status: 429 });
  try {
    await assert.rejects(
      openaiChat([{ role: "user", content: "질문" }]),
      /OpenAI API 요청 실패 \(429\)/,
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
    await assert.rejects(openaiChat([{ role: "user", content: "질문" }]), OpenAiNotConfiguredError);
  } finally {
    if (original !== undefined) process.env.FEATURE_MULTI_LLM = original;
  }
});
