// LLM 단가표(USD per 1M tokens)와 비용 환산. 순수 모듈 — 테스트로 고정한다.
// 단가는 provider 공식 문서 기준이며 개정 시 이 표만 갱신하면 ai_usage 원장의
// 과거 행에도 소급 반영된다(원장은 토큰만 저장).
// 마지막 확인: 2026-08 (Gemini ai.google.dev/pricing, Anthropic docs, OpenAI pricing)

export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export const LLM_PRICES: Record<string, ModelPrice> = {
  "gemini-3.1-flash-lite": { inputUsdPerMTok: 0.25, outputUsdPerMTok: 1.5 },
  "claude-haiku-4-5": { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
  "claude-sonnet-5": { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  "claude-opus-5": { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
};

/**
 * 토큰 사용량을 USD 비용으로 환산한다. thinking 토큰은 모든 provider가
 * 출력 단가로 청구하므로 output 에 합산한다. 미등재 모델은 0 을 돌려주되
 * 호출부(월누적 요약)가 "단가 미등재" 로 표기할 수 있게 null 구분자를 준다.
 */
export function usageCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  thinkingTokens = 0,
): number | null {
  const price = LLM_PRICES[model];
  if (!price) return null;
  return (
    (inputTokens * price.inputUsdPerMTok + (outputTokens + thinkingTokens) * price.outputUsdPerMTok) /
    1_000_000
  );
}
