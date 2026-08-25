import assert from "node:assert/strict";
import test from "node:test";
import { chatFnFor } from "./provider";
import { geminiChat } from "./gemini";
import { TEAMMATES } from "@/lib/discord/teammates";
import { LLM_PRICES } from "./pricing";

const ENV_KEYS = ["FEATURE_MULTI_LLM", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

function withMultiLlmEnv<T>(configured: boolean, fn: () => T): T {
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  if (configured) {
    process.env.FEATURE_MULTI_LLM = "true";
    process.env.ANTHROPIC_API_KEY = "a-key";
    process.env.OPENAI_API_KEY = "o-key";
  } else {
    for (const key of ENV_KEYS) delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test("플래그가 꺼져 있으면 전원 Gemini 폴백이다(무해 배포)", () => {
  withMultiLlmEnv(false, () => {
    for (const meta of Object.values(TEAMMATES)) {
      assert.equal(chatFnFor(meta), geminiChat, meta.key);
    }
  });
});

test("플래그·키가 있으면 페르소나 배정 모델로 라우팅된다", () => {
  withMultiLlmEnv(true, () => {
    // provider 별 클로저는 geminiChat 자체가 아니어야 한다(배정 모델 바인딩).
    assert.notEqual(chatFnFor(TEAMMATES.noeul), geminiChat); // anthropic
    assert.notEqual(chatFnFor(TEAMMATES.baram), geminiChat); // openai
    assert.notEqual(chatFnFor(TEAMMATES.saebyeok), geminiChat); // gemini 모델 오버라이드
    // 총괄(서리)은 모델 미배정 — 폴백 경로.
    assert.equal(chatFnFor(TEAMMATES.seori), geminiChat);
  });
});

test("배정 모델은 전부 단가표에 등재돼 있어 비용 집계가 누락되지 않는다", () => {
  for (const meta of Object.values(TEAMMATES)) {
    if (!meta.model) continue;
    assert.ok(LLM_PRICES[meta.model.model], `${meta.model.model} 단가 미등재`);
  }
});
