import { env } from "@/lib/env";
import { discordChannelId } from "@/lib/notifications/destinations";

const API_BASE = "https://discord.com/api/v10";
const EMBED_DESCRIPTION_LIMIT = 4_000;
const CONTENT_LIMIT = 2_000;
const MAX_EMBEDS = 10;
export const MAX_DISCORD_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export interface DiscordDeliveryResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  retryAfterMs?: number;
  statusCode?: number;
  errorCode?: number;
}

export interface DiscordButton {
  type: 2;
  style: 1 | 2 | 3 | 4 | 5;
  label: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordButton[];
}

export interface DiscordAttachment {
  filename: string;
  contentType: string;
  base64: string;
}

export interface DiscordMessageOptions {
  alertRoleId?: string;
  components?: DiscordActionRow[];
  attachment?: DiscordAttachment;
  // 한 줄짜리 기록은 embed 박스 없이 본문으로 보낸다. 여러 건이 쌓이는 곳에서
  // embed는 한 건마다 상자를 그려 로그로 읽히지 않는다.
  plain?: boolean;
}

export function splitDiscordText(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > EMBED_DESCRIPTION_LIMIT && chunks.length < MAX_EMBEDS - 1) {
    let cut = rest.lastIndexOf("\n", EMBED_DESCRIPTION_LIMIT);
    if (cut < EMBED_DESCRIPTION_LIMIT / 2) cut = EMBED_DESCRIPTION_LIMIT;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest.slice(0, EMBED_DESCRIPTION_LIMIT));
  return chunks;
}

function messagePayload(text: string, options: DiscordMessageOptions) {
  const roleId = options.alertRoleId?.trim();
  const mention = roleId && /^\d+$/.test(roleId) ? `<@&${roleId}>` : undefined;
  const allowedMentions = { parse: [] as string[], roles: mention ? [roleId] : [] };
  const components = options.components?.length ? { components: options.components } : {};
  if (options.plain) {
    const body = text.trim();
    // 본문이 비면 embed 경로와 같이 보내지 않는다. 멘션만 남은 알림은 내용 없이 울린다.
    if (!body) return null;
    return {
      content: [mention, body].filter(Boolean).join(" ").slice(0, CONTENT_LIMIT),
      ...components,
      allowed_mentions: allowedMentions,
    };
  }
  const descriptions = splitDiscordText(text);
  if (descriptions.length === 0) return null;
  return {
    ...(mention ? { content: mention } : {}),
    embeds: descriptions.map((description) => ({ description })),
    ...components,
    allowed_mentions: allowedMentions,
  };
}

function safeDiscordError(status: number, body: unknown): DiscordDeliveryResult {
  const parsed = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const retryAfter = Number(parsed.retry_after);
  const errorCode = typeof parsed.code === "number" ? parsed.code : undefined;
  return {
    ok: false,
    error: `Discord HTTP ${status}${typeof parsed.message === "string" ? `: ${parsed.message}` : ""}`,
    statusCode: status,
    ...(errorCode != null ? { errorCode } : {}),
    ...(status === 429 && Number.isFinite(retryAfter)
      ? { retryAfterMs: Math.max(1_000, Math.ceil(retryAfter * 1_000)) }
      : {}),
  };
}

async function discordRequest(
  path: string,
  init: RequestInit,
): Promise<DiscordDeliveryResult & { json?: unknown }> {
  const token = env.discordBotToken();
  if (!token) return { ok: false, error: "Discord Bot token 미설정" };
  try {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bot ${token}`);
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) return safeDiscordError(response.status, json);
    const id = json && typeof json === "object" && typeof (json as { id?: unknown }).id === "string"
      ? (json as { id: string }).id
      : undefined;
    return { ok: true, ...(id ? { messageId: id } : {}), json };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 300) : "Discord network error",
    };
  }
}

export async function sendDiscord(
  destinationKey: string,
  text: string,
  options: DiscordMessageOptions = {},
): Promise<DiscordDeliveryResult> {
  const channelId = discordChannelId(destinationKey);
  if (!/^\d+$/.test(channelId)) return { ok: false, error: "Discord channel ID 미설정" };
  const payload = messagePayload(text, options);
  if (!payload) return { ok: false, error: "Discord 메시지 비어 있음" };

  if (options.attachment) {
    const bytes = Buffer.from(options.attachment.base64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_DISCORD_ATTACHMENT_BYTES) {
      return { ok: false, error: "Discord 첨부 크기 제한 초과" };
    }
    const form = new FormData();
    form.set("payload_json", JSON.stringify({
      ...payload,
      attachments: [{ id: 0, filename: options.attachment.filename }],
    }));
    form.set(
      "files[0]",
      new Blob([bytes], { type: options.attachment.contentType }),
      options.attachment.filename,
    );
    return discordRequest(`/channels/${channelId}/messages`, { method: "POST", body: form });
  }

  return discordRequest(`/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function editDiscord(
  destinationKey: string,
  messageId: string,
  text: string,
  options: DiscordMessageOptions = {},
): Promise<DiscordDeliveryResult> {
  const channelId = discordChannelId(destinationKey);
  if (!/^\d+$/.test(channelId) || !/^\d+$/.test(messageId)) {
    return { ok: false, error: "Discord channel/message ID 오류" };
  }
  const payload = messagePayload(text, options);
  if (!payload) return { ok: false, error: "Discord 메시지 비어 있음" };
  return discordRequest(`/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    // Discord PATCH는 누락 필드를 보존하므로 이전 mention과 버튼을 명시적으로 비운다.
    body: JSON.stringify({ content: "", components: [], ...payload }),
  });
}

export async function deleteDiscordMessage(
  destinationKey: string,
  messageId: string,
): Promise<DiscordDeliveryResult> {
  const channelId = discordChannelId(destinationKey);
  if (!/^\d+$/.test(channelId) || !/^\d+$/.test(messageId)) {
    return { ok: false, error: "Discord channel/message ID 오류" };
  }
  return discordRequest(`/channels/${channelId}/messages/${messageId}`, { method: "DELETE" });
}

export async function deleteDiscordChannelMessage(
  channelId: string,
  messageId: string,
): Promise<DiscordDeliveryResult> {
  if (!/^\d+$/.test(channelId) || !/^\d+$/.test(messageId)) {
    return { ok: false, error: "Discord channel/message ID 오류" };
  }
  return discordRequest(`/channels/${channelId}/messages/${messageId}`, { method: "DELETE" });
}

export async function createDiscordChannelMessage(
  channelId: string,
  text: string,
  options: DiscordMessageOptions = {},
): Promise<DiscordDeliveryResult> {
  if (!/^\d+$/.test(channelId)) return { ok: false, error: "Discord channel ID 오류" };
  const payload = messagePayload(text, options);
  if (!payload) return { ok: false, error: "Discord 메시지 비어 있음" };
  return discordRequest(`/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// 메시지에서 시작한 public thread는 ID가 원본 메시지 ID와 같다. 그래서 thread ID를 따로
// 저장하지 않고 카드의 providerMessageId를 그대로 쓴다. 메시지당 thread는 하나뿐이라
// 재시도로 다시 요청하면 Discord가 160004로 거절하는데, 이미 있다는 뜻이지 실패가 아니다.
const MESSAGE_ALREADY_HAS_THREAD = 160_004;
const THREAD_AUTO_ARCHIVE_MINUTES = 1_440;
const THREAD_NAME_LIMIT = 100;

export async function startDiscordThread(
  channelId: string,
  messageId: string,
  name: string,
): Promise<DiscordDeliveryResult> {
  if (!/^\d+$/.test(channelId) || !/^\d+$/.test(messageId)) {
    return { ok: false, error: "Discord channel/message ID 오류" };
  }
  const threadName = name.trim().slice(0, THREAD_NAME_LIMIT);
  if (!threadName) return { ok: false, error: "Discord thread 이름 비어 있음" };
  const result = await discordRequest(`/channels/${channelId}/messages/${messageId}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: threadName,
      auto_archive_duration: THREAD_AUTO_ARCHIVE_MINUTES,
    }),
  });
  if (result.errorCode === MESSAGE_ALREADY_HAS_THREAD) return { ok: true, messageId };
  return result;
}

export async function editDiscordChannelMessage(
  channelId: string,
  messageId: string,
  text: string,
  options: DiscordMessageOptions = {},
): Promise<DiscordDeliveryResult> {
  if (!/^\d+$/.test(channelId) || !/^\d+$/.test(messageId)) {
    return { ok: false, error: "Discord channel/message ID 오류" };
  }
  const payload = messagePayload(text, options);
  if (!payload) return { ok: false, error: "Discord 메시지 비어 있음" };
  return discordRequest(`/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    // Discord PATCH는 누락 필드를 보존한다. 확인 버튼 응답(UPDATE_MESSAGE)이 남긴
    // "실행 중" content 와 버튼을 비우지 않으면 결과 embed 를 붙여도 메시지가 계속
    // 진행 중으로 읽힌다.
    body: JSON.stringify({ content: "", components: [], ...payload }),
  });
}

export async function putDiscordApi(path: string, body: unknown): Promise<DiscordDeliveryResult> {
  return discordRequest(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
