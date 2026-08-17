import type {
  NotificationKind,
  NotificationProvider,
  Prisma,
} from "@prisma/client";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { sendDiscord } from "@/lib/notifications/discord";
import type { NotificationDestination } from "@/lib/notifications/destinations";
import { DISCORD_OPS_ALERTS } from "@/lib/notifications/destinations";
import { plainTextPayload } from "@/lib/notifications/format";
import { notify, telegramResponseOk } from "@/lib/telegram/client";

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
    },
    // 같은 event redelivery는 상태를 되돌리지 않고 표시 payload만 최신화한다.
    update: { payload: input.payload },
    select: { id: true },
  });
  for (const destination of input.destinations) {
    await prisma.notificationDelivery.upsert({
      where: {
        eventId_provider_destinationKey: {
          eventId: event.id,
          provider: destination.provider,
          destinationKey: destination.key,
        },
      },
      create: {
        eventId: event.id,
        provider: destination.provider,
        destinationKey: destination.key,
      },
      update: {},
    });
  }
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
    provider: NotificationProvider;
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
            provider: row.provider,
            destinationKey: row.destinationKey,
            payload: row.event.payload,
          })
        : await deliverPlain(
            row.event.kind,
            row.provider,
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
  provider: NotificationProvider,
  destinationKey: string,
  payload: Prisma.JsonValue,
): Promise<DeliveryOverrideResult> {
  const text = plainTextPayload(kind, payload, provider);
  if (!text) return { ok: false, error: "알림 payload 형식 오류" };
  if (provider === "TELEGRAM") {
    const response = await notify(text);
    return telegramResponseOk(response)
      ? { ok: true }
      : { ok: false, error: response?.description ?? "Telegram 응답 없음" };
  }
  return sendDiscord(destinationKey, text, {
    alertRoleId:
      destinationKey === DISCORD_OPS_ALERTS
        ? env.optional("DISCORD_RELEASE_OPS_ROLE_ID").trim()
        : undefined,
  });
}
