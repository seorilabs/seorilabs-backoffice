import { env } from "@/lib/env";

// 서버 전용 Gemini GenerateContent 클라이언트.
// Gemini 3.1 Flash-Lite는 minimal thinking이 기본이며, 낮은 지연·비용을 위해
// 이를 명시한다. Gemini 3 계열 권장값에 따라 temperature는 보내지 않는다.

export interface CompleteOptions {
  prompt: string;
  system?: string;
  maxTokens?: number;
  jsonOutput?: boolean;
  usage?: ChatOptions["usage"];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  jsonOutput?: boolean;
  /** 모델 오버라이드(페르소나 교차 배정). 미전달 시 provider 기본 모델을 쓴다. */
  model?: string;
  /** 사용량 원장(ai_usage) 귀속 컨텍스트. 미전달 시 path "unknown" 으로 기록된다. */
  usage?: { path: string };
}

export class GeminiNotConfiguredError extends Error {
  constructor() {
    super(
      "Gemini가 비활성 상태입니다 (FEATURE_GEMINI_ENABLED + GEMINI_API_KEY 필요).",
    );
    this.name = "GeminiNotConfiguredError";
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

const MAX_MSG_CHARS = 12_000;

type GeminiGenerateResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string }> };
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
};

// 멀티턴 채팅(텔레그램 대화 등). assistant 역할은 Gemini의 model 역할로 변환한다.
export async function geminiChat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  if (!env.geminiChatConfigured()) throw new GeminiNotConfiguredError();

  const systemInstruction = messages
    .filter((message) => message.role === "system")
    .map((message) => truncate(message.content, MAX_MSG_CHARS))
    .filter(Boolean)
    .join("\n\n");
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: truncate(message.content, MAX_MSG_CHARS) }],
    }))
    .filter((content) => content.parts[0].text.trim().length > 0);
  if (contents.length === 0) throw new Error("Gemini API에 보낼 사용자 메시지가 없습니다.");

  const baseUrl = env.geminiBaseUrl().replace(/\/+$/, "");
  const model = opts.model ?? env.geminiChatModel();
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.geminiChatTimeoutMs());

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.geminiApiKey(),
      },
      body: JSON.stringify({
        ...(systemInstruction
          ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
          : {}),
        contents,
        generationConfig: {
          maxOutputTokens: opts.maxTokens ?? 4096,
          // flash-lite 만 minimal 을 지원하고 상위 flash(3.7 등)는 거부한다
          // (2026-08-26 실호출 검증) — 페르소나 오버라이드 모델은 low 로.
          thinkingConfig: { thinkingLevel: model.includes("flash-lite") ? "minimal" : "low" },
          ...(opts.jsonOutput ? { responseMimeType: "application/json" } : {}),
        },
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Gemini API 요청 실패 (${response.status}): ${truncate(rawText, 600)}`,
      );
    }

    let parsed: GeminiGenerateResponse;
    try {
      parsed = JSON.parse(rawText) as GeminiGenerateResponse;
    } catch {
      throw new Error(`Gemini API 비 JSON 응답: ${truncate(rawText, 600)}`);
    }

    const text = (parsed.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) {
      const reason = parsed.promptFeedback?.blockReason
        ?? parsed.candidates?.[0]?.finishReason
        ?? "unknown";
      throw new Error(`Gemini API 빈 응답 (${reason})`);
    }

    const usage = parsed.usageMetadata;
    if (usage) {
      const tokens = {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        thinkingTokens: usage.thoughtsTokenCount ?? 0,
        totalTokens: usage.totalTokenCount ?? 0,
      };
      console.info("[gemini] usage", { model, ...tokens });
      // fire-and-forget 원장 적재. 동적 import 로 prisma 의존을 이 모듈의
      // 정적 그래프에서 격리한다(웹 번들·테스트 그래프 보호).
      void import("@/lib/ai/usage")
        .then((m) =>
          m.recordAiUsage({
            provider: "gemini",
            model,
            path: opts.usage?.path ?? "unknown",
            ...tokens,
          }),
        )
        .catch((error) =>
          console.error("[gemini] usage 기록 실패", error instanceof Error ? error.message : error),
        );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function geminiComplete(opts: CompleteOptions): Promise<string> {
  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });
  return geminiChat(messages, {
    maxTokens: opts.maxTokens,
    jsonOutput: opts.jsonOutput,
    usage: opts.usage,
  });
}
