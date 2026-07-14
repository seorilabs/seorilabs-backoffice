import { env } from "@/lib/env";

const API = "https://api.telegram.org";
const TG_TEXT_LIMIT = 4000; // Telegram 4096 보다 보수적

export interface InlineButton {
  text: string;
  callback_data: string;
}

export function telegramConfigured(): boolean {
  return env.telegramEnabled() && !!env.telegramToken();
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// AI 답변의 마크다운 → Telegram HTML. 균형 잡힌 쌍만 태그화(파싱 오류 방지).
// 단일 '_'/'*'(italic)은 식별자·파일경로와 충돌해 위험하므로 변환하지 않음.
export function mdToTelegramHtml(src: string): string {
  let s = esc(src);
  s = s.replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`); // `code`
  s = s.replace(/\*\*([^\n*]+?)\*\*/g, (_m, c) => `<b>${c}</b>`); // **bold**
  s = s.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, (_m, c) => `<b>${c}</b>`); // 헤딩 → bold
  s = s.replace(/^(\s*)[-*]\s+/gm, "$1• "); // 불릿 → •
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, t, u) => `<a href="${u}">${t}</a>`,
  ); // [text](url)
  return s;
}

// HTML 태그 제거 + 엔티티 복원(parse_mode 실패 시 plain 폴백용).
function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function truncate(s: string, max = TG_TEXT_LIMIT): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

async function call(method: string, body: unknown): Promise<unknown> {
  const token = env.telegramToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return await res.json().catch(() => null);
  } catch (e) {
    // 토큰이 URL 에 있으므로 전체 에러 객체 대신 message + 연결 실패 코드만 로깅.
    const code =
      e && typeof e === "object" && "cause" in e && e.cause && typeof e.cause === "object" && "code" in e.cause
        ? ` (${(e.cause as { code?: string }).code})`
        : "";
    console.error(`[telegram] ${method} 실패:`, (e instanceof Error ? e.message : "error") + code);
    return null;
  }
}

export async function sendMessage(
  chatId: string | number,
  text: string,
  buttons?: InlineButton[][],
): Promise<unknown> {
  const markup = buttons ? { reply_markup: { inline_keyboard: buttons } } : {};
  const res = (await call("sendMessage", {
    chat_id: chatId,
    text: truncate(text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...markup,
  })) as { ok?: boolean } | null;
  // HTML 파싱 실패(잘못된 태그 등) → parse_mode 없이 plain 재전송(원문 노출 방지).
  if (res && res.ok === false) {
    return call("sendMessage", {
      chat_id: chatId,
      text: truncate(stripTags(text)),
      disable_web_page_preview: true,
      ...markup,
    });
  }
  return res;
}

// 하단 고정 빠른 버튼(reply keyboard). labels 의 텍스트가 그대로 메시지로 전송됨.
export async function sendWithReplyKeyboard(
  chatId: string | number,
  text: string,
  keyboard: string[][],
): Promise<unknown> {
  return call("sendMessage", {
    chat_id: chatId,
    text: truncate(text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      keyboard: keyboard.map((row) => row.map((t) => ({ text: t }))),
      resize_keyboard: true,
      is_persistent: true,
    },
  });
}

// 입력중 표시(채팅 응답 지연 동안 UX). 실패 무시.
export async function sendChatAction(
  chatId: string | number,
  action = "typing",
): Promise<unknown> {
  return call("sendChatAction", { chat_id: chatId, action });
}

export async function answerCallback(id: string, text?: string): Promise<unknown> {
  return call("answerCallbackQuery", {
    callback_query_id: id,
    ...(text ? { text } : {}),
  });
}

export async function editMessageText(
  chatId: string | number,
  messageId: number,
  text: string,
  buttons?: InlineButton[][],
): Promise<unknown> {
  return call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: truncate(text),
    parse_mode: "HTML",
    // buttons=[] 명시 시 기존 인라인 버튼 제거.
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

// 봇 명령어 메뉴(텔레그램 "/" 메뉴) 등록.
export async function setMyCommands(
  commands: Array<{ command: string; description: string }>,
): Promise<unknown> {
  return call("setMyCommands", { commands });
}

// 채팅 입력창 메뉴 버튼을 명령어 목록으로.
export async function setChatMenuButton(): Promise<unknown> {
  return call("setChatMenuButton", { menu_button: { type: "commands" } });
}

// 기본 알림 대상(TELEGRAM_CHAT_ID)으로 전송. 실패해도 throw 안 함.
export async function notify(text: string, buttons?: InlineButton[][]): Promise<void> {
  const chat = env.telegramChatId();
  if (!telegramConfigured() || !chat) return;
  await sendMessage(chat, text, buttons);
}

export async function setWebhook(url: string, secret: string): Promise<unknown> {
  return call("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
  });
}
