import assert from "node:assert/strict";
import test from "node:test";
import { geminiChat, GeminiNotConfiguredError } from "./gemini";

const ENV_KEYS = [
  "FEATURE_GEMINI_ENABLED",
  "GEMINI_API_KEY",
  "GEMINI_CHAT_MODEL",
  "GEMINI_CHAT_TIMEOUT_MS",
  "GEMINI_API_BASE_URL",
] as const;

test("Gemini chat maps system and assistant messages without exposing the API key in the URL", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  process.env.FEATURE_GEMINI_ENABLED = "true";
  process.env.GEMINI_API_KEY = "company-test-key";
  process.env.GEMINI_CHAT_MODEL = "gemini-3.1-flash-lite";
  process.env.GEMINI_CHAT_TIMEOUT_MS = "1000";
  process.env.GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "최종 답변" }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const output = await geminiChat([
      { role: "system", content: "시스템 규칙" },
      { role: "user", content: "첫 질문" },
      { role: "assistant", content: "첫 답변" },
      { role: "user", content: "후속 질문" },
    ], { maxTokens: 512, jsonOutput: true });

    assert.equal(output, "최종 답변");
    assert.equal(
      capturedUrl,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
    );
    assert.equal(capturedUrl.includes("company-test-key"), false);
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers["x-goog-api-key"], "company-test-key");
    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.systemInstruction.parts[0].text, "시스템 규칙");
    assert.deepEqual(body.contents.map((content: { role: string }) => content.role), [
      "user",
      "model",
      "user",
    ]);
    assert.equal(body.generationConfig.maxOutputTokens, 512);
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.equal("temperature" in body.generationConfig, false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Gemini chat fails closed when the feature flag is disabled", async () => {
  const originalFeature = process.env.FEATURE_GEMINI_ENABLED;
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.FEATURE_GEMINI_ENABLED = "false";
  process.env.GEMINI_API_KEY = "company-test-key";

  try {
    await assert.rejects(
      () => geminiChat([{ role: "user", content: "질문" }]),
      GeminiNotConfiguredError,
    );
  } finally {
    if (originalFeature === undefined) delete process.env.FEATURE_GEMINI_ENABLED;
    else process.env.FEATURE_GEMINI_ENABLED = originalFeature;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});

test("페르소나 오버라이드 모델(비 flash-lite)은 thinkingLevel low 를 쓴다", async () => {
  // gemini-3.7-flash 는 MINIMAL 을 400 으로 거부한다(2026-08-26 실호출 검증).
  const originalFetch = globalThis.fetch;
  const saved = { flag: process.env.FEATURE_GEMINI_ENABLED, key: process.env.GEMINI_API_KEY };
  process.env.FEATURE_GEMINI_ENABLED = "true";
  process.env.GEMINI_API_KEY = "company-test-key";
  let capturedBody = "";
  let capturedUrl = "";
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "답" }] } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await geminiChat([{ role: "user", content: "질문" }], { model: "gemini-3.7-flash" });
    assert.ok(capturedUrl.includes("gemini-3.7-flash"));
    assert.equal(JSON.parse(capturedBody).generationConfig.thinkingConfig.thinkingLevel, "low");
  } finally {
    globalThis.fetch = originalFetch;
    if (saved.flag === undefined) delete process.env.FEATURE_GEMINI_ENABLED;
    else process.env.FEATURE_GEMINI_ENABLED = saved.flag;
    if (saved.key === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved.key;
  }
});
