import { env } from "@/lib/env";
import type { ChatMessage, ChatOptions, CompleteOptions } from "@/lib/ai/gemini";

// 서버 전용 MiniMax 챗 클라이언트. Anthropic 호환 Messages API 를 사용하고
// 임베딩은 지원하지 않는다(임베딩은 Gemini 유지). JSON 출력 모드가 없어
// jsonOutput 은 시스템 지시로 강제하고 파싱 방어는 호출부(json.ts)가 맡는다.

export class MinimaxNotConfiguredError extends Error {
  constructor() {
    super(
      "MiniMax가 비활성 상태입니다 (FEATURE_MINIMAX_ENABLED + MINIMAX_API_KEY 필요).",
    );
    this.name = "MinimaxNotConfiguredError";
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

const MAX_MSG_CHARS = 12_000;
const JSON_OUTPUT_INSTRUCTION =
  "응답은 항상 JSON 객체 하나만 출력한다. 머리말·설명·코드블록을 금지한다.";

type MinimaxMessagesResponse = {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  base_resp?: { status_code?: number | string; status_msg?: string };
};

export async function minimaxChat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  if (!env.minimaxChatConfigured()) throw new MinimaxNotConfiguredError();

  const systemParts = messages
    .filter((message) => message.role === "system")
    .map((message) => truncate(message.content, MAX_MSG_CHARS))
    .filter(Boolean);
  if (opts.jsonOutput) systemParts.push(JSON_OUTPUT_INSTRUCTION);
  const system = systemParts.join("\n\n");
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: [{ type: "text", text: truncate(message.content, MAX_MSG_CHARS) }],
    }))
    .filter((message) => message.content[0].text.trim().length > 0);
  if (contents.length === 0) throw new Error("MiniMax API에 보낼 사용자 메시지가 없습니다.");

  const baseUrl = env.minimaxBaseUrl().replace(/\/+$/, "");
  const model = opts.model ?? env.minimaxChatModel();
  const url = `${baseUrl}/anthropic/v1/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.minimaxChatTimeoutMs());

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        Authorization: `Bearer ${env.minimaxApiKey()}`,
      },
      body: JSON.stringify({
        model,
        ...(system ? { system } : {}),
        messages: contents,
        max_tokens: opts.maxTokens ?? 4096,
        stream: false,
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(
        `MiniMax API 요청 실패 (${response.status}): ${truncate(rawText, 600)}`,
      );
    }

    let parsed: MinimaxMessagesResponse;
    try {
      parsed = JSON.parse(rawText) as MinimaxMessagesResponse;
    } catch {
      throw new Error(`MiniMax API 비 JSON 응답: ${truncate(rawText, 600)}`);
    }

    const statusCode = parsed.base_resp?.status_code;
    if (statusCode !== undefined && statusCode !== 0 && statusCode !== "0") {
      throw new Error(
        `MiniMax API 오류 ${String(statusCode)}: ${parsed.base_resp?.status_msg ?? "unknown"}`,
      );
    }

    const text = (parsed.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new Error(`MiniMax API 빈 응답 (${parsed.stop_reason ?? "unknown"})`);
    }

    const usage = parsed.usage;
    if (usage) {
      const tokens = {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        thinkingTokens: 0,
        totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      };
      console.info("[minimax] usage", { model, ...tokens });
      void import("@/lib/ai/usage")
        .then((m) =>
          m.recordAiUsage({
            provider: "minimax",
            model,
            path: opts.usage?.path ?? "unknown",
            ...tokens,
          }),
        )
        .catch((error) =>
          console.error("[minimax] usage 기록 실패", error instanceof Error ? error.message : error),
        );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function minimaxComplete(opts: CompleteOptions): Promise<string> {
  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });
  return minimaxChat(messages, {
    maxTokens: opts.maxTokens,
    jsonOutput: opts.jsonOutput,
    usage: opts.usage,
  });
}
