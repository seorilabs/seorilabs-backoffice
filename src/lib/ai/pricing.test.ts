import assert from "node:assert/strict";
import { test } from "node:test";
import { usageCostUsd, LLM_PRICES } from "@/lib/ai/pricing";

test("등재 모델은 입력·출력 단가로 환산한다", () => {
  // flash-lite: $0.25 in / $1.50 out per 1M
  const cost = usageCostUsd("gemini-3.1-flash-lite", 1_000_000, 1_000_000);
  assert.equal(cost, 0.25 + 1.5);
});

test("thinking 토큰은 출력 단가로 합산 청구한다", () => {
  const withThinking = usageCostUsd("gemini-3.1-flash-lite", 0, 500_000, 500_000);
  const outputOnly = usageCostUsd("gemini-3.1-flash-lite", 0, 1_000_000, 0);
  assert.equal(withThinking, outputOnly);
});

test("미등재 모델은 null 을 돌려준다", () => {
  assert.equal(usageCostUsd("unknown-model", 1000, 1000), null);
});

test("사용량 0 은 비용 0", () => {
  assert.equal(usageCostUsd("claude-sonnet-5", 0, 0), 0);
});

test("단가표는 양수 단가만 갖는다", () => {
  for (const [model, price] of Object.entries(LLM_PRICES)) {
    assert.ok(price.inputUsdPerMTok > 0, `${model} input`);
    assert.ok(price.outputUsdPerMTok > 0, `${model} output`);
  }
});
