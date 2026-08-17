import { discordUsername, discordWebhookFor } from "@/lib/notifications/destinations";

const EMBED_DESCRIPTION_LIMIT = 4_000;
const MAX_EMBEDS = 10;

export interface DiscordDeliveryResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  retryAfterMs?: number;
  statusCode?: number;
}

interface DiscordMessageOptions {
  alertRoleId?: string;
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

function validWebhookUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      (url.hostname === "discord.com" || url.hostname === "discordapp.com") &&
      /^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function discordPayload(text: string, options: DiscordMessageOptions): Record<string, unknown> | null {
  const descriptions = splitDiscordText(text);
  if (descriptions.length === 0) return null;

  const roleId = options.alertRoleId?.trim();
  const content = roleId && /^\d+$/.test(roleId) ? `<@&${roleId}>` : undefined;
  return {
    ...(content ? { content } : {}),
    embeds: descriptions.map((description) => ({ description })),
    allowed_mentions: { parse: [], roles: content ? [roleId] : [] },
  };
}

async function requestDiscord(
  url: string,
  method: "POST" | "PATCH",
  payload: Record<string, unknown>,
  fallbackMessageId?: string,
): Promise<DiscordDeliveryResult> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
      return {
        ok: true,
        ...(typeof body?.id === "string"
          ? { messageId: body.id }
          : fallbackMessageId
            ? { messageId: fallbackMessageId }
            : {}),
      };
    }
    const body = (await response.json().catch(() => null)) as {
      message?: unknown;
      retry_after?: unknown;
    } | null;
    const retryAfter = Number(body?.retry_after);
    return {
      ok: false,
      error: `Discord HTTP ${response.status}${typeof body?.message === "string" ? `: ${body.message}` : ""}`,
      statusCode: response.status,
      ...(response.status === 429 && Number.isFinite(retryAfter)
        ? { retryAfterMs: Math.max(1_000, Math.ceil(retryAfter * 1_000)) }
        : {}),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Discord network error" };
  }
}

export async function sendDiscord(
  destinationKey: string,
  text: string,
  options: DiscordMessageOptions = {},
): Promise<DiscordDeliveryResult> {
  const webhook = discordWebhookFor(destinationKey);
  if (!validWebhookUrl(webhook)) return { ok: false, error: "Discord webhook 미설정" };
  const payload = discordPayload(text, options);
  if (!payload) return { ok: false, error: "Discord 메시지 비어 있음" };
  return requestDiscord(`${webhook}?wait=true`, "POST", {
    username: discordUsername(destinationKey),
    ...payload,
  });
}

export async function editDiscord(
  destinationKey: string,
  messageId: string,
  text: string,
  options: DiscordMessageOptions = {},
): Promise<DiscordDeliveryResult> {
  const webhook = discordWebhookFor(destinationKey);
  if (!validWebhookUrl(webhook)) return { ok: false, error: "Discord webhook 미설정" };
  if (!/^\d+$/.test(messageId)) return { ok: false, error: "Discord message ID 오류" };
  const payload = discordPayload(text, options);
  if (!payload) return { ok: false, error: "Discord 메시지 비어 있음" };
  return requestDiscord(
    `${webhook}/messages/${messageId}?wait=true`,
    "PATCH",
    payload,
    messageId,
  );
}
