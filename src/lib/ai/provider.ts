import { geminiChat, type ChatMessage, type ChatOptions } from "@/lib/ai/gemini";
import { claudeChat } from "@/lib/ai/claude";
import { openaiChat } from "@/lib/ai/openai";
import { env } from "@/lib/env";
import type { TeammateMeta } from "@/lib/discord/teammates";

// 페르소나별 모델 교차 배정 라우팅. 같은 과업을 서로 다른 모델이 수행해
// ai_usage(비용)×teammate_run(채택률) 원장으로 모델 비교가 가능해진다.
// 해당 provider 키가 미설정이면 Gemini(flash-lite)로 폴백해 배포가 무해하다.

export type ChatFn = (messages: ChatMessage[], opts?: ChatOptions) => Promise<string>;

export function chatFnFor(meta: TeammateMeta): ChatFn {
  const model = meta.model;
  if (!model || !env.featureMultiLlm()) return geminiChat;
  if (model.provider === "anthropic" && env.anthropicConfigured()) {
    return (messages, opts) => claudeChat(messages, { ...opts, model: model.model });
  }
  if (model.provider === "openai" && env.openaiConfigured()) {
    return (messages, opts) => openaiChat(messages, { ...opts, model: model.model });
  }
  if (model.provider === "gemini") {
    return (messages, opts) => geminiChat(messages, { ...opts, model: model.model });
  }
  return geminiChat;
}
