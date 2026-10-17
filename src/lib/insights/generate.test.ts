import assert from "node:assert/strict";
import test from "node:test";
import { generateInsight } from "./generate";
import { env } from "@/lib/env";
import { llmChatModel } from "@/lib/ai/llm";
const facts = [{ id: "rating", label: "평점", value: "2점", source: "App Store" }];
test("운영 분석도 선택된 공통 대화 공급자와 모델을 사용한다", async (t) => {
  t.mock.method(env, "chatLlmProvider", () => "anthropic");
  t.mock.method(env, "claudeChatConfigured", () => true);
  t.mock.method(env, "claudeChatModel", () => "claude-sonnet-5-5");
  let called = 0;
  const result = await generateInsight(facts, "customer", {
    acquire: async () => "qa-permit", release: async () => {},
    chat: async () => {
      called++;
      return '{"bullets":[{"kind":"fact","text":"{rating} 관측됨","evidenceIds":["rating"]},{"kind":"hypothesis","text":"추가 의견과 연관 가능성 있음","evidenceIds":["rating"]},{"kind":"action","text":"이용자 의견 확인 필요","evidenceIds":["rating"]}]}';
    },
  });
  assert.equal(called, 1);
  assert.equal(result.fallback, false);
  assert.equal(llmChatModel(), "claude-sonnet-5-5");
});
test("근거 없는 답변을 한 번 재시도한 뒤 사실 요약으로 대체함", async () => {
  let attempts = 0;
  const result = await generateInsight(facts, "customer", {
    configured: true,
    acquire: async () => "qa-permit",
    release: async () => {},
    chat: async () => {
      attempts++;
      return '{"bullets":[]}';
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.fallback, true);
  assert.equal(result.errorCode, "ANALYSIS_FORMAT_INVALID");
});
test("예산 상한과 공급자 오류는 호출을 반복하지 않고 사실을 남김", async () => {
  let attempts = 0;
  const chat = async () => {
    attempts++;
    throw new Error("provider-sensitive-error");
  };
  assert.equal(
    (
      await generateInsight(facts, "customer", {
        configured: true,
        acquire: async () => "qa-permit",
        release: async () => {},
        chat,
        reserve: async () => false,
      })
    ).errorCode,
    "DAILY_ANALYSIS_LIMIT",
  );
  assert.equal(attempts, 0);
  assert.equal(
    (
      await generateInsight(facts, "customer", {
        configured: true,
        acquire: async () => "qa-permit",
        release: async () => {},
        chat,
      })
    ).errorCode,
    "ANALYSIS_PROVIDER_FAILED",
  );
  assert.equal(attempts, 1);
});
