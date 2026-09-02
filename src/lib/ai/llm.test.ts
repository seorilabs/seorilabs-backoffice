import assert from "node:assert/strict";
import test from "node:test";
import { llmChat, llmChatConfigured, llmChatModel, LlmNotConfiguredError } from "./llm";

const ENV_KEYS = [
  "CHAT_LLM_PROVIDER",
  "FEATURE_MINIMAX_ENABLED",
  "MINIMAX_API_KEY",
  "FEATURE_GEMINI_ENABLED",
  "GEMINI_API_KEY",
] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => Promise<void> | void): Promise<void> | void {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key]!;
  }
  const restore = () => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  };
  const result = run();
  if (result instanceof Promise) return result.finally(restore);
  restore();
  return result;
}

test("기본 provider는 minimax이고 구성·모델 판정이 provider를 따른다", () => {
  return withEnv({ FEATURE_MINIMAX_ENABLED: "true", MINIMAX_API_KEY: "k" }, () => {
    assert.equal(llmChatConfigured(), true);
    assert.equal(llmChatModel(), "MiniMax-M3");
  });
});

test("CHAT_LLM_PROVIDER=gemini면 Gemini 구성으로 판정한다", () => {
  return withEnv(
    { CHAT_LLM_PROVIDER: "gemini", FEATURE_GEMINI_ENABLED: "true", GEMINI_API_KEY: "k" },
    () => {
      assert.equal(llmChatConfigured(), true);
      assert.equal(llmChatModel(), "gemini-3.1-flash-lite");
    },
  );
});

test("선택된 provider가 미구성이면 LlmNotConfiguredError를 던진다", async () => {
  await withEnv({}, async () => {
    await assert.rejects(
      llmChat([{ role: "user", content: "질문" }]),
      LlmNotConfiguredError,
    );
  });
});
