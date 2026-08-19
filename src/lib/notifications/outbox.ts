import type {
  NotificationKind,
  Prisma,
} from "@prisma/client";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { sendDiscord, type DiscordActionRow } from "@/lib/notifications/discord";
import type { NotificationDestination } from "@/lib/notifications/destinations";
import { DISCORD_OPS_ALERTS } from "@/lib/notifications/destinations";
import { plainTextPayload } from "@/lib/notifications/format";

const MAX_ATTEMPTS = 10;
let draining = false;

export function nextNotificationAttemptAt(
  attempts: number,
  now = new Date(),
  retryAfterMs?: number,
): Date {
  const delayMs = retryAfterMs ?? Math.min(30_000 * 2 ** Math.max(0, attempts), 30 * 60_000);
  return new Date(now.getTime() + Math.max(1_000, delayMs));
}

export async function enqueueNotification(input: {
  dedupeKey: string;
  kind: NotificationKind;
  payload: Prisma.InputJsonObject;
  occurredAt?: Date;
  destinations: NotificationDestination[];
}): Promise<string> {
  const event = await prisma.notificationEvent.upsert({
    where: { dedupeKey: input.dedupeKey },
    create: {
      dedupeKey: input.dedupeKey,
      kind: input.kind,
      payload: input.payload,
      occurredAt: input.occurredAt,
      ...(input.destinations.length > 0
        ? {
            deliveries: {
              create: input.destinations.map((destination) => ({
                provider: destination.provider,
                destinationKey: destination.key,
              })),
            },
          }
        : {}),
    },
    // 같은 event redelivery는 상태나 최초 목적지를 바꾸지 않고 표시 payload만
    // 최신화한다. 나중에 추가한 provider가 과거 알림을 역으로 전송하면 안 된다.
    update: { payload: input.payload },
    select: { id: true },
  });
  return event.id;
}

export interface DeliveryOverrideResult {
  ok: boolean;
  error?: string;
  messageId?: string;
  retryAfterMs?: number;
}

export async function drainNotifications(
  limit = 30,
  deliverOverride?: (input: {
    kind: NotificationKind;
    destinationKey: string;
    payload: Prisma.JsonValue;
  }) => Promise<DeliveryOverrideResult>,
): Promise<{ processed: number; sent: number; deadLetter: number }> {
  if (draining) return { processed: 0, sent: 0, deadLetter: 0 };
  draining = true;
  try {
    const now = new Date();
    await prisma.notificationDelivery.updateMany({
      where: {
        status: "PROCESSING",
        updatedAt: { lt: new Date(now.getTime() - 10 * 60_000) },
      },
      data: { status: "PENDING", nextAttemptAt: now },
    });
    const rows = await prisma.notificationDelivery.findMany({
      where: { status: "PENDING", nextAttemptAt: { lte: now } },
      orderBy: { createdAt: "asc" },
      take: limit,
      include: { event: true },
    });
    let sent = 0;
    let deadLetter = 0;
    for (const row of rows) {
      const claimed = await prisma.notificationDelivery.updateMany({
        where: { id: row.id, status: "PENDING" },
        data: { status: "PROCESSING" },
      });
      if (claimed.count !== 1) continue;

      const result = deliverOverride
        ? await deliverOverride({
            kind: row.event.kind,
            destinationKey: row.destinationKey,
            payload: row.event.payload,
          })
        : await deliverPlain(
            row.event.kind,
            row.destinationKey,
            row.event.payload,
          );
      if (result.ok) {
        sent++;
        await prisma.notificationDelivery.update({
          where: { id: row.id },
          data: {
            status: "SENT",
            attempts: { increment: 1 },
            sentAt: new Date(),
            providerMessageId: result.messageId,
            lastError: null,
          },
        });
      } else {
        const attempts = row.attempts + 1;
        const terminal = attempts >= MAX_ATTEMPTS;
        if (terminal) deadLetter++;
        await prisma.notificationDelivery.update({
          where: { id: row.id },
          data: {
            status: terminal ? "DEAD_LETTER" : "PENDING",
            attempts: { increment: 1 },
            nextAttemptAt: nextNotificationAttemptAt(
              row.attempts,
              new Date(),
              result.retryAfterMs,
            ),
            lastError: result.error ?? "unknown error",
          },
        });
      }
      await prisma.auditLog.create({
        data: {
          actorLogin: null,
          action: result.ok ? "notification.sent" : "notification.failed",
          entityType: "notification_delivery",
          entityId: row.id,
          payload: {
            kind: row.event.kind,
            provider: row.provider,
            destinationKey: row.destinationKey,
            terminal: !result.ok && row.attempts + 1 >= MAX_ATTEMPTS,
            error: result.error ?? null,
          },
        },
      });
    }
    return { processed: rows.length, sent, deadLetter };
  } finally {
    draining = false;
  }
}

async function deliverPlain(
  kind: NotificationKind,
  destinationKey: string,
  payload: Prisma.JsonValue,
): Promise<DeliveryOverrideResult> {
  const text = plainTextPayload(kind, payload);
  if (!text) return { ok: false, error: "알림 payload 형식 오류" };
  const object = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Prisma.JsonObject
    : null;
  const attachmentValue = object?.attachment;
  const attachment = attachmentValue && typeof attachmentValue === "object" && !Array.isArray(attachmentValue)
    ? attachmentValue as Prisma.JsonObject
    : null;
  const attachmentOption =
    typeof attachment?.filename === "string" &&
    typeof attachment?.contentType === "string" &&
    typeof attachment?.base64 === "string"
      ? {
          filename: attachment.filename,
          contentType: attachment.contentType,
          base64: attachment.base64,
        }
      : undefined;
  const components = Array.isArray(object?.components)
    ? (object.components as unknown as DiscordActionRow[]).slice(0, 5)
    : undefined;
  return sendDiscord(destinationKey, text, {
    alertRoleId:
      destinationKey === DISCORD_OPS_ALERTS
        ? env.discordRoleId("release_ops")
        : undefined,
    attachment: attachmentOption,
    components,
  });
}
