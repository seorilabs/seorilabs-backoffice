import type { NotificationKind, Prisma } from "@prisma/client";
import type { DiscordEmbedMeta } from "@/lib/notifications/discord";

type JsonObject = Prisma.JsonObject;

function objectPayload(payload: Prisma.JsonValue): JsonObject | null {
  return payload != null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as JsonObject)
    : null;
}

function stringField(payload: JsonObject | null, key: string): string {
  const value = payload?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * 한 알림을 Discord 에 어떤 모양으로 내보낼지.
 *
 * 빌더가 payload 에 담고 worker 는 통과만 시킨다. kind 로 모양을 정할 수 없기
 * 때문이다 — OPS_ALERT 하나에 승인 카드, 재무 리포트, 이슈 알림, 장애가 아닌
 * 넛지가 전부 들어 있다.
 */
export interface DiscordRender {
  text: string;
  /** true 면 상자 없는 본문 한 줄. embed 메타는 무시된다. */
  plain?: boolean;
  embed?: DiscordEmbedMeta;
}

function embedMetaOf(payload: JsonObject | null): DiscordEmbedMeta | undefined {
  const value = payload?.embed;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as JsonObject;
  const color = object.color;
  const meta: DiscordEmbedMeta = {
    ...(typeof object.title === "string" && object.title ? { title: object.title } : {}),
    ...(typeof color === "number" && Number.isInteger(color) && color >= 0 && color <= 0xFFFFFF
      ? { color }
      : {}),
    ...(typeof object.url === "string" && /^https:\/\//.test(object.url) ? { url: object.url } : {}),
    ...(typeof object.footer === "string" && object.footer ? { footer: object.footer } : {}),
    ...(typeof object.timestamp === "string" && !Number.isNaN(Date.parse(object.timestamp))
      ? { timestamp: object.timestamp }
      : {}),
  };
  return Object.keys(meta).length > 0 ? meta : undefined;
}

export function discordRender(
  kind: NotificationKind,
  payload: Prisma.JsonValue,
): DiscordRender | null {
  // 배포 카드는 본문이 payload 에 없다. ReleaseRecord 로 매번 다시 그린다.
  if (kind === "DEPLOY_COMPLETION") return null;
  const object = objectPayload(payload);
  const text = stringField(object, "discordMarkdown") || stringField(object, "text");
  if (!text) return null;
  if (object?.plain === true) return { text, plain: true };
  const embed = embedMetaOf(object);
  return { text, ...(embed ? { embed } : {}) };
}

export function htmlToDiscord(input: string): string {
  return input
    .replace(/<b>(.*?)<\/b>/g, "**$1**")
    .replace(/<code>(.*?)<\/code>/g, "`$1`")
    .replace(/<a href="([^"]+)">(.*?)<\/a>/g, "[$2]($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
