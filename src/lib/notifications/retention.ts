import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { deleteDiscordChannelMessage, deleteDiscordMessage } from "@/lib/notifications/discord";

function deletedOrMissing(result: { ok: boolean; statusCode?: number; errorCode?: number }): boolean {
  return result.ok || (result.statusCode === 404 && result.errorCode === 10_008);
}

export function notificationRetentionWhere(
  cutoff: Date,
  protectedIds: string[],
): Prisma.NotificationDeliveryWhereInput {
  return {
    provider: "DISCORD",
    status: "SENT",
    deletedAt: null,
    sentAt: { lt: cutoff },
    providerMessageId: { not: null, ...(protectedIds.length ? { notIn: protectedIds } : {}) },
  };
}

export function commandRetentionWhere(
  cutoff: Date,
  protectedIds: string[],
): Prisma.OperatorCommandRunWhereInput {
  return {
    status: { in: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"] },
    completedAt: { lt: cutoff },
    messageId: { not: null, ...(protectedIds.length ? { notIn: protectedIds } : {}) },
  };
}

export function reviewEventRetentionWhere(
  cutoff: Date,
): Prisma.NotificationEventWhereInput {
  return {
    kind: "STORE_REVIEW",
    createdAt: { lt: cutoff },
    deliveries: {
      some: {},
      every: {
        OR: [
          { status: "DEAD_LETTER" },
          { deletedAt: { not: null } },
        ],
      },
    },
  };
}

export async function maintainDiscordRetention(now = new Date()) {
  const cutoff = new Date(now.getTime() - env.discordRetentionDays() * 24 * 60 * 60_000);
  const activeIncidents = await prisma.operationalIncident.findMany({
    where: { status: { in: ["OPEN", "ACKNOWLEDGED"] }, providerMessageId: { not: null } },
    select: { providerMessageId: true },
  });
  const protectedIds = activeIncidents.flatMap((item) => item.providerMessageId ? [item.providerMessageId] : []);
  const deliveries = await prisma.notificationDelivery.findMany({
    where: notificationRetentionWhere(cutoff, protectedIds),
    orderBy: { sentAt: "asc" },
    take: 100,
  });
  let deletedNotifications = 0;
  for (const delivery of deliveries) {
    const result = await deleteDiscordMessage(delivery.destinationKey, delivery.providerMessageId!);
    if (!deletedOrMissing(result)) continue;
    await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { deletedAt: now } });
    deletedNotifications++;
  }

  const commands = await prisma.operatorCommandRun.findMany({
    where: commandRetentionWhere(cutoff, protectedIds),
    orderBy: { completedAt: "asc" },
    take: 100,
  });
  let deletedCommands = 0;
  for (const command of commands) {
    const result = await deleteDiscordChannelMessage(command.channelId, command.messageId!);
    if (!deletedOrMissing(result)) continue;
    await prisma.operatorCommandRun.update({ where: { id: command.id }, data: { messageId: null } });
    deletedCommands++;
  }
  const turns = await prisma.discordTurn.deleteMany({ where: { createdAt: { lt: cutoff } } });
  // 리뷰 원문은 전송 payload에만 최대 보존기한 동안 둔다. Discord 삭제가
  // 확인됐거나 전송이 영구 실패한 이벤트만 제거해 pending 재시도는 보존한다.
  const expiredReviewEvents = await prisma.notificationEvent.findMany({
    where: reviewEventRetentionWhere(cutoff),
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true },
  });
  const deletedReviewEvents = expiredReviewEvents.length
    ? (await prisma.notificationEvent.deleteMany({
        where: { id: { in: expiredReviewEvents.map((event) => event.id) } },
      })).count
    : 0;
  return {
    deletedNotifications,
    deletedCommands,
    deletedTurns: turns.count,
    deletedReviewEvents,
    cutoff,
  };
}
