import { env } from "@/lib/env";
import { discordChannelId } from "@/lib/notifications/destinations";

const API_BASE = "https://discord.com/api/v10";
const EMBED_DESCRIPTION_LIMIT = 4_000;
const CONTENT_LIMIT = 2_000;
const MAX_EMBEDS = 10;
/**
 * 한 메시지의 모든 embed 를 합친 문자 상한.
 *
 * Discord 는 title·description·field.name·field.value·footer.text·author.name 의
 * 합이 6,000 자를 넘으면 400 으로 거절한다. description 4,000 × embed 10 개라는
 * 계산은 이 상한을 모르는 값이라 넘기면 전송이 통째로 실패한다.
 */
const EMBED_TOTAL_LIMIT = 6_000;
const EMBED_TITLE_LIMIT = 256;
const EMBED_FOOTER_LIMIT = 2_048;
const TRUNCATION_MARK = "\n…(길이 제한으로 이하 생략)";
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

/**
 * 구조화 embed 의 상자 메타. 본문(description)은 sendDiscord 의 text 인자가 맡는다.
 *
 * 색·제목이 없으면 모든 알림이 같은 무게의 회색 상자로 보인다. 여기 값을 넣는 쪽은
 * 알림을 만드는 빌더이고, worker 는 payload 로 받은 것을 그대로 통과시킨다.
 */
export interface DiscordEmbedMeta {
  /** Discord 가 굵게 렌더하므로 ** 를 넣지 않는다. */
  title?: string;
  color?: number;
  url?: string;
  footer?: string;
  /** ISO8601. Discord 가 상자 하단에 뷰어 로컬 시각으로 렌더한다. */
  timestamp?: string;
}

export interface DiscordMessageOptions {
  alertRoleId?: string;
  components?: DiscordActionRow[];
  attachment?: DiscordAttachment;
  // 한 줄짜리 기록은 embed 박스 없이 본문으로 보낸다. 여러 건이 쌓이는 곳에서
  // embed는 한 건마다 상자를 그려 로그로 읽히지 않는다.
  plain?: boolean;
  // plain 이 아닐 때의 상자 메타. plain 이면 상자가 없어 그릴 곳이 없다.
  embed?: DiscordEmbedMeta;
  // 원본 메시지에 대한 네이티브 답글로 보낸다. 답글이어도 allowed_mentions 는
  // 그대로 비워 두므로 핑은 발생하지 않는다.
  replyToMessageId?: string;
  // 메인 봇이 아닌 다른 봇 정체로 보낸다(예: 서리 재무 리포트). 미지정이면 메인 봇.
  botToken?: string;
}

/**
 * 본문을 embed description 여러 개로 쪼갠다.
 *
 * budget 은 이 메시지의 embed 전체에 남은 문자 예산이다. 제목·footer 를 함께
 * 보내면 그 길이가 같은 예산에서 나가므로 호출부가 빼서 넘긴다. 예산을 넘는
 * 꼬리는 잘라내되, 잘렸다는 사실을 본문에 남긴다 — 조용히 사라지면 읽는 쪽이
 * 리포트가 원래 그만큼인 줄 안다.
 */
export function splitDiscordText(text: string, budget = EMBED_TOTAL_LIMIT): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const cap = Math.min(Math.max(0, budget), MAX_EMBEDS * EMBED_DESCRIPTION_LIMIT);
  if (cap <= 0) return [];
  let rest = normalized;
  if (rest.length > cap) {
    const keep = Math.max(0, cap - TRUNCATION_MARK.length);
    rest = rest.slice(0, keep).trimEnd() + TRUNCATION_MARK;
  }
  const chunks: string[] = [];
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
  const reference = options.replyToMessageId && /^\d+$/.test(options.replyToMessageId)
    ? { message_reference: { message_id: options.replyToMessageId, fail_if_not_exists: false } }
    : {};
  if (options.plain) {
    const body = text.trim();
    // 본문이 비면 embed 경로와 같이 보내지 않는다. 멘션만 남은 알림은 내용 없이 울린다.
    if (!body) return null;
    const content = [mention, body].filter(Boolean).join(" ");
    // 2,000 자를 넘으면 잘라내지 않고 embed 로 떨어뜨린다. 로그 한 줄로 만든 알림이
    // 예외적으로 길어졌을 때 끝부분이 말없이 사라지는 편보다, 상자에 담겨 전부
    // 도착하는 편이 낫다.
    if (content.length <= CONTENT_LIMIT) {
      return { content, ...components, ...reference, allowed_mentions: allowedMentions };
    }
  }
  const meta = options.embed;
  const title = meta?.title?.trim().slice(0, EMBED_TITLE_LIMIT);
  const footer = meta?.footer?.trim().slice(0, EMBED_FOOTER_LIMIT);
  // 제목·footer 도 같은 6,000 자 예산에서 나간다.
  const reserved = (title?.length ?? 0) + (footer?.length ?? 0);
  const descriptions = splitDiscordText(text, EMBED_TOTAL_LIMIT - reserved);
  if (descriptions.length === 0) return null;
  return {
    ...(mention ? { content: mention } : {}),
    // 메타는 첫 상자에만 얹는다. 길어서 10 개로 쪼갠 리포트에 제목이 10 번 반복되면
    // 상자가 이어지지 않고 끊어져 읽힌다. 색은 전부에 걸어 한 기둥으로 보이게 한다.
    embeds: descriptions.map((description, index) => ({
      description,
      ...(meta?.color != null ? { color: meta.color } : {}),
      ...(index === 0
        ? {
            ...(title ? { title } : {}),
            ...(meta?.url ? { url: meta.url } : {}),
            ...(footer ? { footer: { text: footer } } : {}),
            ...(meta?.timestamp ? { timestamp: meta.timestamp } : {}),
          }
        : {}),
    })),
    ...components,
    ...reference,
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
  // 서리처럼 별도 정체로 발화하는 경로가 자기 토큰을 넘긴다. 미지정이면 메인 봇 토큰.
  tokenOverride?: string,
): Promise<DiscordDeliveryResult & { json?: unknown }> {
  const token = tokenOverride ?? env.discordBotToken();
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
  }, options.botToken);
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
  // 메시지는 그것을 게시한 봇만 고칠 수 있다. botToken 을 흘리면 서리가 보낸
  // 카드를 메인 봇이 고치려다 403 이 나고, 실패 원인이 권한 문제로 보이지 않는다.
  return discordRequest(`/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    // Discord PATCH는 누락 필드를 보존하므로 이전 mention·버튼·상자를 명시적으로 비운다.
    // embeds 를 비우지 않으면 plain 으로 바뀐 알림에 이전 상자가 그대로 남는다.
    body: JSON.stringify({ content: "", components: [], embeds: [], ...payload }),
  }, options.botToken);
}

export async function deleteDiscordMessage(
  destinationKey: string,
  messageId: string,
  // 게시한 봇 정체로 지운다. 미지정이면 메인 봇.
  botToken?: string,
): Promise<DiscordDeliveryResult> {
  const channelId = discordChannelId(destinationKey);
  if (!/^\d+$/.test(channelId) || !/^\d+$/.test(messageId)) {
    return { ok: false, error: "Discord channel/message ID 오류" };
  }
  return discordRequest(`/channels/${channelId}/messages/${messageId}`, { method: "DELETE" }, botToken);
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
    // 진행 중으로 읽힌다. embeds 도 같은 이유로 비운다.
    body: JSON.stringify({ content: "", components: [], embeds: [], ...payload }),
  });
}

export async function putDiscordApi(path: string, body: unknown): Promise<DiscordDeliveryResult> {
  return discordRequest(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
