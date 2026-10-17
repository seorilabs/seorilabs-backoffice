import { env } from "@/lib/env";
import type { ChatMessage, ChatOptions, CompleteOptions } from "@/lib/ai/gemini";

// 서버 전용 Claude Messages API. JSON 출력은 시스템 지시와 호출부 검증을 함께 사용한다.
// 임베딩은 Gemini를 유지하고, 사용자 지정 IH 키 외의 키로 자동 전환하지 않는다.

export class ClaudeNotConfiguredError extends Error {
  constructor() {
    super(
      "Claude가 비활성 상태입니다 (FEATURE_CLAUDE_ENABLED + CLAUDE_API_KEY_IH 필요).",
    );
    this.name = "ClaudeNotConfiguredError";
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

const MAX_MSG_CHARS = 12_000;
const JSON_OUTPUT_INSTRUCTION =
  "응답은 항상 JSON 객체 하나만 출력한다. 머리말·설명·코드블록을 금지한다.";

type ClaudeMessagesResponse = {
  type?: string;
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export async function claudeChat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  if (!env.claudeChatConfigured()) throw new ClaudeNotConfiguredError();

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
  if (contents.length === 0) throw new Error("Claude API에 보낼 사용자 메시지가 없습니다.");

  const model = opts.model ?? env.claudeChatModel();
  const url = "https://api.anthropic.com/v1/messages";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.claudeChatTimeoutMs());

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": env.claudeApiKey(),
      },
      body: JSON.stringify({
        model,
        ...(system ? { system } : {}),
        messages: contents,
        max_tokens: opts.maxTokens ?? 4096,
        // Sonnet 5.5는 temperature: 0과 thinking: disabled를 거절한다.
        // 도구 없는 짧은 대화·요약에서 출력 한도를 추론에 소진하지 않는다.
        ...(model === "claude-sonnet-5-5" ? { thinking: { type: "between_tools" } } : {}),
        stream: false,
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Claude API 요청 실패 (${response.status})`,
      );
    }

    let parsed: ClaudeMessagesResponse;
    try {
      parsed = JSON.parse(rawText) as ClaudeMessagesResponse;
    } catch {
      throw new Error("Claude API 비 JSON 응답");
    }

    if (!parsed || parsed.type !== "message") {
      throw new Error("Claude API 응답 형식 오류");
    }

    const usage = parsed.usage;
    if (usage) {
      const tokens = {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        thinkingTokens: 0,
        totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      };
      const responseModel = parsed.model ?? model;
      console.info("[claude] usage", { model: responseModel, ...tokens });
      await import("@/lib/ai/usage")
        .then((m) =>
          m.recordAiUsage({
            provider: "anthropic",
            model: responseModel,
            path: opts.usage?.path ?? "unknown",
            ...tokens,
          }),
        )
        .catch(() => console.error("[claude] usage 기록 실패"));
    }
    // 과금된 실패 응답도 위에서 사용량을 기록한 뒤 호출부의 기본 요약으로 전환한다.
    if (parsed.stop_reason === "max_tokens") throw new Error("Claude API 출력 한도 초과");
    if (parsed.stop_reason !== "end_turn" && parsed.stop_reason !== "stop_sequence") {
      throw new Error("Claude API 응답 미완료");
    }
    const text = (parsed.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    if (!text) throw new Error("Claude API 빈 응답");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function claudeComplete(opts: CompleteOptions): Promise<string> {
  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });
  return claudeChat(messages, {
    maxTokens: opts.maxTokens,
    jsonOutput: opts.jsonOutput,
    usage: opts.usage,
  });
}
