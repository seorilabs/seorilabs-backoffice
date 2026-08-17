import type { NotificationKind, Prisma } from "@prisma/client";

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

export function plainTextPayload(
  kind: NotificationKind,
  payload: Prisma.JsonValue,
  provider: "TELEGRAM" | "DISCORD",
): string | null {
  if (kind === "DEPLOY_COMPLETION") return null;
  const object = objectPayload(payload);
  return provider === "TELEGRAM"
    ? stringField(object, "telegramHtml") || stringField(object, "text") || null
    : stringField(object, "discordMarkdown") || stringField(object, "text") || null;
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
