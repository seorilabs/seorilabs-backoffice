import { env } from "@/lib/env";
import type { ChatMessage, ChatOptions } from "@/lib/ai/gemini";

// 서버 전용 Anthropic Messages API 클라이언트. 저장소 zero-SDK 관례에 따라
// raw fetch 를 쓴다(gemini.ts 와 동일 — Next 번들에 SDK 의존을 싣지 않는다).
// thinking 파라미터는 생략(현행 모델은 adaptive 기본), temperature 는 보내지 않고
// 비용은 output_config.effort(기본 low)로 통제한다.

export class ClaudeNotConfiguredError extends Error {
  constructor() {
    super("Claude가 비활성 상태입니다 (FEATURE_MULTI_LLM + ANTHROPIC_API_KEY 필요).");
    this.name = "ClaudeNotConfiguredError";
  }
}

const MAX_MSG_CHARS = 12_000;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

type ClaudeResponse = {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export async function claudeChat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  if (!env.anthropicConfigured()) throw new ClaudeNotConfiguredError();

  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => truncate(message.content, MAX_MSG_CHARS))
    .filter(Boolean)
    .join("\n\n");
  const turns = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: truncate(message.content, MAX_MSG_CHARS),
    }))
    .filter((turn) => turn.content.trim().length > 0);
  if (turns.length === 0) throw new Error("Claude API에 보낼 사용자 메시지가 없습니다.");

  const model = opts.model ?? env.anthropicChatModel();
  const baseUrl = env.anthropicBaseUrl().replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.anthropicChatTimeoutMs());

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.anthropicApiKey(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 4096,
        ...(system ? { system } : {}),
        messages: turns,
        output_config: { effort: env.anthropicEffort() },
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    if (!response.ok) {
      // "(429)" 형식은 공용 재시도 가드(withLlm429Retry)가 매칭한다.
      throw new Error(`Claude API 요청 실패 (${response.status}): ${truncate(rawText, 600)}`);
    }

    let parsed: ClaudeResponse;
    try {
      parsed = JSON.parse(rawText) as ClaudeResponse;
    } catch {
      throw new Error(`Claude API 비 JSON 응답: ${truncate(rawText, 600)}`);
    }

    const text = (parsed.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new Error(`Claude API 빈 응답 (${parsed.stop_reason ?? "unknown"})`);
    }

    const usage = parsed.usage;
    if (usage) {
      const tokens = {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        thinkingTokens: 0, // Claude 는 thinking 을 output 에 합산 청구한다.
        totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      };
      console.info("[claude] usage", { model, ...tokens });
      void import("@/lib/ai/usage")
        .then((m) =>
          m.recordAiUsage({
            provider: "anthropic",
            model,
            path: opts.usage?.path ?? "unknown",
            teammate: opts.usage?.teammate ?? null,
            ...tokens,
          }),
        )
        .catch((error) =>
          console.error("[claude] usage 기록 실패", error instanceof Error ? error.message : error),
        );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
