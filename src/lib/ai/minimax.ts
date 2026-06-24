import { env } from "@/lib/env";

// MiniMax 클라이언트 — OpenAI 호환 /chat/completions.
// gemini-pr-bot(src/gemini.ts runMiniMaxApi) 의 검증된 형태를 재사용:
//   - thinking:{type:"disabled"} (M3)
//   - base_resp.status_code 에러 봉투 검사
//   - response_format json_object (구조화 출력 옵션)
// 서버 전용. 절대 클라이언트 번들에 포함하지 말 것(MINIMAX_API_KEY).

export interface CompleteOptions {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  jsonOutput?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonOutput?: boolean;
}

export class MiniMaxNotConfiguredError extends Error {
  constructor() {
    super(
      "MiniMax 가 비활성 상태입니다 (FEATURE_MINIMAX_ENABLED + MINIMAX_API_KEY 필요).",
    );
    this.name = "MiniMaxNotConfiguredError";
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

// 단일 메시지 컨텍스트 상한(과대 요청·요금 폭주 방지).
const MAX_MSG_CHARS = 12_000;

// 멀티턴 채팅(텔레그램 대화 등). messages 는 system/user/assistant 순서.
export async function miniMaxChat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  if (!env.minimaxConfigured()) throw new MiniMaxNotConfiguredError();

  const baseUrl = env.minimaxBaseUrl().replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;
  const safeMessages = messages.map((m) => ({
    role: m.role,
    content: truncate(m.content, MAX_MSG_CHARS),
  }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.minimaxTimeoutMs());
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.minimaxApiKey()}`,
      },
      body: JSON.stringify({
        model: env.minimaxModel(),
        messages: safeMessages,
        temperature: opts.temperature ?? 0.3,
        max_completion_tokens: opts.maxTokens ?? 4096,
        thinking: { type: "disabled" },
        ...(opts.jsonOutput ? { response_format: { type: "json_object" } } : {}),
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(`MiniMax API 비 JSON 응답: ${truncate(rawText, 600)}`);
    }

    const obj = parsed as {
      base_resp?: { status_code?: number; status_msg?: string };
      choices?: Array<{ message?: { content?: string } }>;
    };
    const baseResp = obj.base_resp;
    if (baseResp && Number(baseResp.status_code) !== 0) {
      const msg = baseResp.status_msg || `error code ${baseResp.status_code}`;
      throw new Error(`MiniMax API 거부: ${msg}`);
    }

    const content = obj.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) throw new Error("MiniMax API 빈 응답");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// 단일 system+user 호출(에이전트 초안 생성). 내부적으로 miniMaxChat 위임.
export async function miniMaxComplete(opts: CompleteOptions): Promise<string> {
  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });
  return miniMaxChat(messages, {
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    jsonOutput: opts.jsonOutput,
  });
}
