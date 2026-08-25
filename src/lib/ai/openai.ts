import { env } from "@/lib/env";
import type { ChatMessage, ChatOptions } from "@/lib/ai/gemini";

// 서버 전용 OpenAI Chat Completions 클라이언트. 저장소 zero-SDK 관례에 따라
// raw fetch 를 쓴다. GPT-5 계열은 max_tokens 대신 max_completion_tokens 를 받고,
// reasoning 소모를 억제하기 위해 reasoning_effort(기본 minimal)를 명시한다.

export class OpenAiNotConfiguredError extends Error {
  constructor() {
    super("OpenAI가 비활성 상태입니다 (FEATURE_MULTI_LLM + OPENAI_API_KEY 필요).");
    this.name = "OpenAiNotConfiguredError";
  }
}

const MAX_MSG_CHARS = 12_000;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

type OpenAiResponse = {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export async function openaiChat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  if (!env.openaiConfigured()) throw new OpenAiNotConfiguredError();

  const turns = messages
    .map((message) => ({ role: message.role, content: truncate(message.content, MAX_MSG_CHARS) }))
    .filter((turn) => turn.content.trim().length > 0);
  if (!turns.some((turn) => turn.role !== "system")) {
    throw new Error("OpenAI API에 보낼 사용자 메시지가 없습니다.");
  }

  const model = opts.model ?? env.openaiChatModel();
  const baseUrl = env.openaiBaseUrl().replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.openaiChatTimeoutMs());

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${env.openaiApiKey()}`,
      },
      body: JSON.stringify({
        model,
        messages: turns,
        max_completion_tokens: opts.maxTokens ?? 4096,
        reasoning_effort: env.openaiReasoningEffort(),
        ...(opts.jsonOutput ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    if (!response.ok) {
      // "(429)" 형식은 공용 재시도 가드(withLlm429Retry)가 매칭한다.
      throw new Error(`OpenAI API 요청 실패 (${response.status}): ${truncate(rawText, 600)}`);
    }

    let parsed: OpenAiResponse;
    try {
      parsed = JSON.parse(rawText) as OpenAiResponse;
    } catch {
      throw new Error(`OpenAI API 비 JSON 응답: ${truncate(rawText, 600)}`);
    }

    const choice = parsed.choices?.[0];
    const text = (choice?.message?.content ?? "").trim();
    if (!text) {
      throw new Error(`OpenAI API 빈 응답 (${choice?.finish_reason ?? "unknown"})`);
    }

    const usage = parsed.usage;
    if (usage) {
      const tokens = {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        thinkingTokens: 0, // reasoning 토큰은 completion 에 합산 청구된다.
        totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      };
      console.info("[openai] usage", { model, ...tokens });
      void import("@/lib/ai/usage")
        .then((m) =>
          m.recordAiUsage({
            provider: "openai",
            model,
            path: opts.usage?.path ?? "unknown",
            teammate: opts.usage?.teammate ?? null,
            ...tokens,
          }),
        )
        .catch((error) =>
          console.error("[openai] usage 기록 실패", error instanceof Error ? error.message : error),
        );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
