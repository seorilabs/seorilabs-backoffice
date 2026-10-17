import assert from "node:assert/strict";
import test from "node:test";
import { llmChat, llmChatConfigured, llmChatModel, LlmNotConfiguredError } from "./llm";

const ENV_KEYS = [
  "CHAT_LLM_PROVIDER",
  "FEATURE_CLAUDE_ENABLED",
  "CLAUDE_API_KEY_IH",
  "CLAUDE_CHAT_MODEL",
  "CLAUDE_API_KEY_IH_BACKUP",
  "CLAUDE_API_KEY_SYOUS",
  "ANTHROPIC_API_KEY",
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

test("기본 provider는 anthropic이고 정확한 IH 키로 구성한다", () => {
  return withEnv({ FEATURE_CLAUDE_ENABLED: "true", CLAUDE_API_KEY_IH: "k" }, () => {
    assert.equal(llmChatConfigured(), true);
    assert.equal(llmChatModel(), "claude-sonnet-5-5");
  });
});

test("IH 키가 없으면 다른 Claude 키나 Gemini로 자동 전환하지 않는다", async () => {
  await withEnv({
    FEATURE_CLAUDE_ENABLED: "true",
    CLAUDE_API_KEY_IH_BACKUP: "backup-key",
    CLAUDE_API_KEY_SYOUS: "other-key",
    ANTHROPIC_API_KEY: "default-key",
    FEATURE_GEMINI_ENABLED: "true",
    GEMINI_API_KEY: "gemini-key",
  }, async () => {
    assert.equal(llmChatConfigured(), false);
    await assert.rejects(llmChat([{ role: "user", content: "질문" }]), LlmNotConfiguredError);
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

test("제거된 MiniMax 설정은 다른 공급자로 조용히 대체하지 않는다", () => {
  return withEnv({ CHAT_LLM_PROVIDER: "minimax" }, () => {
    assert.throws(() => llmChatConfigured(), /anthropic 또는 gemini/u);
  });
});
