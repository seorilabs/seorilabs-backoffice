import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { claudeChat, claudeComplete, ClaudeNotConfiguredError } from "./claude";
import type { AiUsageRecord } from "./usage";

// Prisma 모델은 Proxy이므로 DB 경계에 평범한 기록 객체를 주입한다.
const usageSink = { create: async (input: { data: AiUsageRecord }) => input.data };
(globalThis as { prisma?: unknown }).prisma = { aiUsage: usageSink };

const ENV_KEYS = [
  "FEATURE_CLAUDE_ENABLED",
  "CLAUDE_API_KEY_IH",
  "CLAUDE_CHAT_MODEL",
  "CLAUDE_CHAT_TIMEOUT_MS",
] as const;

const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
beforeEach(() => {
  process.env.FEATURE_CLAUDE_ENABLED = "true";
  process.env.CLAUDE_API_KEY_IH = "ih-test-key";
  process.env.CLAUDE_CHAT_MODEL = "claude-sonnet-5-5";
  process.env.CLAUDE_CHAT_TIMEOUT_MS = "1000";
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

function message(body: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    type: "message",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "답변" }],
    stop_reason: "end_turn",
    ...body,
  }));
}

test("Claude 공식 API에 IH 헤더·멀티턴·JSON 지시를 보내고 최종 텍스트만 반환한다", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => message({
    content: [{ type: "thinking", thinking: "내부 추론" }, { type: "text", text: "최종 답변" }],
  }));
  assert.equal(await claudeChat([
    { role: "system", content: "시스템 규칙" },
    { role: "user", content: "첫 질문" },
    { role: "assistant", content: "첫 답변" },
    { role: "user", content: "후속 질문" },
  ], { maxTokens: 512, jsonOutput: true, temperature: 0 }), "최종 답변");

  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  const headers = init?.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "ih-test-key");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.ok(!String(url).includes("ih-test-key"));
  const body = JSON.parse(String(init?.body));
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.match(body.system, /시스템 규칙/u);
  assert.match(body.system, /JSON 객체 하나만/u);
  assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ["user", "assistant", "user"]);
  assert.equal(body.max_tokens, 512);
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.thinking, { type: "between_tools" });
});

test("초안 생성은 시스템·프롬프트·사용량 경로를 전달한다", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => message({
    content: [{ type: "text", text: '{"ok":true}' }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }));
  const usage = t.mock.method(usageSink, "create");
  assert.equal(await claudeComplete({
    system: "초안 규칙", prompt: "초안 요청", jsonOutput: true, usage: { path: "draft" },
  }), '{"ok":true}');
  const body = JSON.parse(String(fetch.mock.calls[0].arguments[1]?.body));
  assert.match(body.system, /초안 규칙/u);
  assert.equal(body.messages[0].content[0].text, "초안 요청");
  assert.equal((usage.mock.calls[0].arguments[0] as { data: { path: string } }).data.path, "draft");
});

test("실제 응답 모델과 토큰을 기록하며 추론 토큰을 중복 합산하지 않는다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => message({
    model: "claude-sonnet-5-5",
    usage: { input_tokens: 10, output_tokens: 15 },
  }));
  const usage = t.mock.method(usageSink, "create");
  await claudeChat([{ role: "user", content: "질문" }], { model: "requested-alias", usage: { path: "chat" } });
  assert.deepEqual((usage.mock.calls[0].arguments[0] as { data: unknown }).data, {
    provider: "anthropic", model: "claude-sonnet-5-5", path: "chat",
    inputTokens: 10, outputTokens: 15, thinkingTokens: 0, totalTokens: 25,
  });
});

test("HTTP 오류 응답에 포함된 비밀값·원문을 오류 메시지에 노출하지 않는다", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("ih-test-key private-response", { status: 429 }));
  await assert.rejects(claudeChat([{ role: "user", content: "질문" }]), (error: Error) => {
    assert.equal(error.message, "Claude API 요청 실패 (429)");
    return true;
  });
});

test("비 JSON·오류 봉투·빈 텍스트는 성공으로 반환하지 않는다", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("not-json"));
  await assert.rejects(claudeChat([{ role: "user", content: "질문" }]), /비 JSON 응답/u);
  fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ type: "error", error: { message: "private" } })));
  await assert.rejects(claudeChat([{ role: "user", content: "질문" }]), /응답 형식 오류/u);
  fetch.mock.mockImplementation(async () => message({ content: [] }));
  await assert.rejects(claudeChat([{ role: "user", content: "질문" }]), /빈 응답/u);
});

test("잘린 출력·거절을 실패로 처리하면서 과금된 토큰은 기록한다", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => message({
    content: [{ type: "text", text: "미완성 답변" }], stop_reason: "max_tokens",
    usage: { input_tokens: 10, output_tokens: 20 },
  }));
  const usage = t.mock.method(usageSink, "create");
  await assert.rejects(claudeChat([{ role: "user", content: "질문" }]), /출력 한도 초과/u);
  assert.equal(usage.mock.calls.length, 1);
  fetch.mock.mockImplementation(async () => message({ stop_reason: "refusal" }));
  await assert.rejects(claudeChat([{ role: "user", content: "질문" }]), /응답 미완료/u);
});

test("시간 제한이 지나면 요청을 취소한다", async (t) => {
  process.env.CLAUDE_CHAT_TIMEOUT_MS = "5";
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  });
  await assert.rejects(claudeChat([{ role: "user", content: "질문" }]), { name: "AbortError" });
});

test("미구성·빈 사용자 메시지는 외부 호출 전에 거절한다", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => message());
  await assert.rejects(claudeChat([{ role: "system", content: "규칙" }]), /사용자 메시지가 없습니다/u);
  delete process.env.CLAUDE_API_KEY_IH;
  await assert.rejects(claudeChat([{ role: "user", content: "질문" }]), ClaudeNotConfiguredError);
  assert.equal(fetch.mock.calls.length, 0);
});
