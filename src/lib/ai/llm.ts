import { env } from "@/lib/env";
import {
  geminiChat,
  geminiComplete,
  type ChatMessage,
  type ChatOptions,
  type CompleteOptions,
} from "@/lib/ai/gemini";
import { minimaxChat, minimaxComplete } from "@/lib/ai/minimax";

// 챗 LLM 라우터. CHAT_LLM_PROVIDER 로 provider 를 고르고 호출부는 provider 를
// 모른 채 이 모듈만 사용한다. 임베딩(embeddings.ts)은 라우팅 대상이 아니다.

export type { ChatMessage, ChatOptions, CompleteOptions };

export class LlmNotConfiguredError extends Error {
  constructor(provider: "minimax" | "gemini") {
    super(
      provider === "minimax"
        ? "챗 LLM이 비활성 상태입니다 (FEATURE_MINIMAX_ENABLED + MINIMAX_API_KEY 필요)."
        : "챗 LLM이 비활성 상태입니다 (FEATURE_GEMINI_ENABLED + GEMINI_API_KEY 필요).",
    );
    this.name = "LlmNotConfiguredError";
  }
}

export function llmChatConfigured(): boolean {
  return env.chatLlmProvider() === "minimax"
    ? env.minimaxChatConfigured()
    : env.geminiChatConfigured();
}

/** ai_usage 원장·이벤트 메타데이터에 기록할 현재 provider 의 기본 챗 모델. */
export function llmChatModel(): string {
  return env.chatLlmProvider() === "minimax"
    ? env.minimaxChatModel()
    : env.geminiChatModel();
}

export async function llmChat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  const provider = env.chatLlmProvider();
  if (!llmChatConfigured()) throw new LlmNotConfiguredError(provider);
  return provider === "minimax" ? minimaxChat(messages, opts) : geminiChat(messages, opts);
}

export async function llmComplete(opts: CompleteOptions): Promise<string> {
  const provider = env.chatLlmProvider();
  if (!llmChatConfigured()) throw new LlmNotConfiguredError(provider);
  return provider === "minimax" ? minimaxComplete(opts) : geminiComplete(opts);
}
