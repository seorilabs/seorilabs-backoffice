import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  deleteChannelMessage,
  deleteNotification,
} from "@/lib/notifications/channel";
import { senderBotToken } from "@/lib/notifications/sender";
import { senderKey } from "@/lib/notifications/sender";
import { deleteLegacyDiscordReview } from "./legacy-discord";
import { fileReceipt, messagePageReceipts } from "./channel";
import { slackApi } from "@/lib/slack/api";

function deletedOrMissing(result: {
  ok: boolean;
  error?: string;
}): boolean {
  return (
    result.ok || result.error === "message_not_found"
  );
}

export function notificationRetentionWhere(
  cutoff: Date,
  protectedIds: string[],
  provider: "SLACK" | "DISCORD" = "SLACK",
): Prisma.NotificationDeliveryWhereInput {
  return {
    provider,
    status: { in: ["SENT", "SUPPRESSED", "DEAD_LETTER"] },
    deletedAt: null,
    event: { createdAt: { lt: cutoff }, OR: [{kind:"STORE_REVIEW"},{payload:{path:"$.reviewReport",equals:true}}] },
    ...(protectedIds.length ? { OR: [{providerMessageId:null},{providerMessageId:{notIn:protectedIds}}] } : {}),
  };
}

export function commandRetentionWhere(
  cutoff: Date,
  protectedIds: string[],
): Prisma.OperatorCommandRunWhereInput {
  return {
    sourceProvider: "SLACK",
    status: { in: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"] },
    completedAt: { lt: cutoff },
    messageId: {
      not: null,
      ...(protectedIds.length ? { notIn: protectedIds } : {}),
    },
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
      every: { deletedAt: { not: null } },
    },
  };
}

export async function maintainSlackRetention(now = new Date()) {
  const cutoff = new Date(
    now.getTime() - env.reviewRetentionDays() * 24 * 60 * 60_000,
  );
  const activeIncidents = await prisma.operationalIncident.findMany({
    where: {
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
      providerMessageId: { not: null },
    },
    select: { providerMessageId: true },
  });
  const protectedIds = activeIncidents.flatMap((item) =>
    item.providerMessageId ? [item.providerMessageId] : [],
  );
  const deliveries = await prisma.notificationDelivery.findMany({
    where: { OR: [notificationRetentionWhere(cutoff,protectedIds,"SLACK"),notificationRetentionWhere(cutoff,protectedIds,"DISCORD")] },
    orderBy: { sentAt: "asc" },
    take: 100,
    // 메인 봇이 아닌 정체로 게시한 알림은 그 봇만 확실히 지울 수 있다.
    include: { event: { select: { payload: true } } },
  });
  let deletedNotifications = 0;
  for (const delivery of deliveries) {
    const receiptObject = delivery.providerReceipt && typeof delivery.providerReceipt === "object" && !Array.isArray(delivery.providerReceipt) ? delivery.providerReceipt : {};
    const receipt = fileReceipt(receiptObject.file);
    const messageId = delivery.providerMessageId ?? (typeof receiptObject.postedMessageId === "string" ? receiptObject.postedMessageId : receipt?.messageTs);
    // 전송 결과를 모르면 삭제를 확인할 수 없다. 원문과 영수증을 보존해 조치 대상으로 남긴다.
    if ((receiptObject.postState === "STARTED" || delivery.lastError === "SLACK_DELIVERY_OUTCOME_UNKNOWN") && !messageId) continue;
    if (delivery.provider === "DISCORD") {
      if (messageId && !await deleteLegacyDiscordReview(delivery.destinationKey,messageId,senderKey(delivery.event.payload) ?? undefined)) continue;
      await prisma.notificationDelivery.update({where:{id:delivery.id},data:{deletedAt:now}});
      deletedNotifications++;
      continue;
    }
    const pages=messagePageReceipts(receiptObject.pages);
    const unresolvedPages=pages.some(page=>page.state === "STARTED");
    let allDeleted=true;
    for(const id of new Set([messageId,...pages.map(page=>page.messageId)].filter((id):id is string=>!!id))) {
      const result=await deleteNotification(delivery.destinationKey,id,senderBotToken(delivery.event.payload));
      if(!deletedOrMissing(result))allDeleted=false;
    }
    if(!allDeleted)continue;
    let deletedFiles = true;
    for (const file of receipt?.fileIds ?? []) {
      const deleted = await slackApi("files.delete",{file});
      if (!deleted.ok && deleted.error !== "file_not_found") deletedFiles = false;
    }
    // 확인된 메시지와 파일은 지우되 결과 불명 연속편의 원장과 payload는 남긴다.
    if (!deletedFiles || unresolvedPages) continue;
    await prisma.notificationDelivery.update({where:{id:delivery.id},data:{deletedAt:now}});
    deletedNotifications++;
  }

  const commands = await prisma.operatorCommandRun.findMany({
    where: commandRetentionWhere(cutoff, protectedIds),
    orderBy: { completedAt: "asc" },
    take: 100,
  });
  let deletedCommands = 0;
  for (const command of commands) {
    const result = await deleteChannelMessage(
      command.channelId,
      command.messageId!,
    );
    if (!deletedOrMissing(result)) continue;
    await prisma.operatorCommandRun.update({
      where: { id: command.id },
      data: { messageId: null },
    });
    deletedCommands++;
  }
  const turns = await prisma.slackTurn.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  await prisma.discordTurn.deleteMany({where:{createdAt:{lt:cutoff}}});
  await prisma.slackRequestReceipt.deleteMany({where:{createdAt:{lt:new Date(now.getTime() - 86400000)}}});
  // 리뷰 원문은 전송 payload에만 최대 보존기한 동안 둔다. Slack 삭제가
  // 확인된 이벤트만 제거해 pending과 결과 불명 요청은 보존한다.
  const expiredReviewEvents = await prisma.notificationEvent.findMany({
    where: reviewEventRetentionWhere(cutoff),
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true },
  });
  const deletedReviewEvents = expiredReviewEvents.length
    ? (
        await prisma.notificationEvent.deleteMany({
          where: { id: { in: expiredReviewEvents.map((event) => event.id) } },
        })
      ).count
    : 0;
  // 요약 보고에 포함된 짧은 원문 인용도 원본 리뷰와 같은 기한으로 비운다.
  await prisma.notificationEvent.updateMany({
    where: {
      createdAt: { lt: cutoff },
      payload: { path: "$.reviewReport", equals: true },
      deliveries: { every: { deletedAt: { not: null } } },
    },
    data: {
      payload: {
        sender: "seori",
        text: "리뷰 본문 보존기한 만료",
        reviewReportExpired: true,
        report: { category: "internal", reason: "REVIEW_CONTENT_EXPIRED" },
      },
    },
  });
  await prisma.insightDocument.updateMany({
    where: { signal: { kind: "review-themes", observedAt: { lt: cutoff } } },
    data: { content: Prisma.DbNull },
  });
  return {
    deletedNotifications,
    deletedCommands,
    deletedTurns: turns.count,
    deletedReviewEvents,
    cutoff,
  };
}
