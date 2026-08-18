import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { deleteDiscordChannelMessage, deleteDiscordMessage } from "@/lib/notifications/discord";

function deletedOrMissing(result: { ok: boolean; statusCode?: number; errorCode?: number }): boolean {
  return result.ok || (result.statusCode === 404 && result.errorCode === 10_008);
}

export async function maintainDiscordRetention(now = new Date()) {
  const cutoff = new Date(now.getTime() - env.discordRetentionDays() * 24 * 60 * 60_000);
  const activeIncidents = await prisma.operationalIncident.findMany({
    where: { status: { in: ["OPEN", "ACKNOWLEDGED"] }, providerMessageId: { not: null } },
    select: { providerMessageId: true },
  });
  const protectedIds = activeIncidents.flatMap((item) => item.providerMessageId ? [item.providerMessageId] : []);
  const deliveries = await prisma.notificationDelivery.findMany({
    where: {
      provider: "DISCORD",
      status: "SENT",
      deletedAt: null,
      sentAt: { lt: cutoff },
      providerMessageId: { not: null, ...(protectedIds.length ? { notIn: protectedIds } : {}) },
    },
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
    where: {
      status: { in: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"] },
      completedAt: { lt: cutoff },
      messageId: { not: null, ...(protectedIds.length ? { notIn: protectedIds } : {}) },
    },
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
  return { deletedNotifications, deletedCommands, deletedTurns: turns.count, cutoff };
}
