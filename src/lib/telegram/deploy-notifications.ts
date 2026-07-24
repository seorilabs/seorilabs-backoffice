import type { Prisma, ReleaseMarket } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  notify,
  telegramResponseOk,
} from "@/lib/telegram/client";
import {
  rebuildReleaseDeployMessage,
  type ReleaseDeployApp,
} from "@/lib/telegram/release-message";
import {
  deployTargetFromAuditPayload,
  telegramContextFromAuditPayload,
} from "@/lib/telegram/release-message-payload";
import type { PlatformDeployTarget } from "@/lib/telegram/release-deploy-buttons";
import {
  buildDeployCompletionText,
  deployCompletionPayload,
  deployMarketLabel,
  deployNotificationDedupeKey,
  nextNotificationAttemptAt,
  type DeployCompletionPayload,
  type EnqueueDeployCompletionPayload,
} from "@/lib/telegram/deploy-notification-format";

export async function enqueueDeployCompletionNotification(
  payload: EnqueueDeployCompletionPayload,
): Promise<void> {
  const dedupeKey = deployNotificationDedupeKey(
    payload.releaseRecordId,
    payload.eventKey,
  );
  const jsonPayload: Prisma.InputJsonObject = {
    releaseRecordId: payload.releaseRecordId,
    status: payload.status,
    ...(payload.runUrl ? { runUrl: payload.runUrl } : {}),
  };
  await prisma.telegramNotification.upsert({
    where: { dedupeKey },
    create: {
      dedupeKey,
      kind: "DEPLOY_COMPLETION",
      payload: jsonPayload,
    },
    // 동일 완료 이벤트 redelivery 는 SENT 상태를 되돌리지 않고 링크만 최신화한다.
    update: { payload: jsonPayload },
  });
}

async function releaseMessageContexts(
  app: ReleaseDeployApp,
  version: string,
  market: ReleaseMarket,
): Promise<Array<{ chatId: string; messageId: number }>> {
  if (market === "WEB") return [];
  const rows = await prisma.auditLog.findMany({
    where: {
      action: "release.deploy.dispatch",
      entityType: "release",
      entityId: `${app.repoFullName}@${version}`,
    },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { payload: true },
  });
  const target = market as PlatformDeployTarget;
  const seen = new Set<string>();
  const contexts: Array<{ chatId: string; messageId: number }> = [];
  for (const row of rows) {
    const dispatchedTarget = deployTargetFromAuditPayload(row.payload);
    if (dispatchedTarget !== target && dispatchedTarget !== "ALL") continue;
    const context = telegramContextFromAuditPayload(row.payload);
    if (!context) continue;
    const key = `${context.chatId}:${context.messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    contexts.push(context);
  }
  return contexts;
}

async function deliverDeployCompletion(payload: DeployCompletionPayload): Promise<{
  ok: boolean;
  error?: string;
}> {
  const release = await prisma.releaseRecord.findUnique({
    where: { id: payload.releaseRecordId },
    select: {
      id: true,
      version: true,
      market: true,
      status: true,
      workflowName: true,
      externalBuildNumber: true,
      app: {
        select: {
          id: true,
          slug: true,
          displayName: true,
          repoFullName: true,
          marketTargets: true,
        },
      },
    },
  });
  if (!release) return { ok: false, error: "release record not found" };
  const note =
    release.status === "SUCCEEDED" || release.status === "FAILED"
      ? `${release.status === "SUCCEEDED" ? "✅" : "❌"} ${deployMarketLabel(release.market)} 배포 ${release.status === "SUCCEEDED" ? "완료" : "실패"}`
      : `⏳ ${deployMarketLabel(release.market)} 배포 재실행 중`;
  const contexts = await releaseMessageContexts(
    release.app,
    release.version,
    release.market,
  );
  // 원문 갱신은 best-effort다. 오래된 메시지 수정 실패가 새 완료 알림을 막지 않는다.
  for (const context of contexts) {
    await rebuildReleaseDeployMessage(
      context.chatId,
      context.messageId,
      release.app,
      release.version,
      note,
    ).catch(() => false);
  }

  const response = await notify(
    buildDeployCompletionText({
      displayName: release.app.displayName,
      version: release.version,
      market: release.market,
      status: payload.status,
      workflowName: release.workflowName,
      externalBuildNumber: release.externalBuildNumber,
      runUrl: payload.runUrl,
    }),
  );
  if (!telegramResponseOk(response)) {
    return {
      ok: false,
      error: response?.description ?? "Telegram이 설정되지 않았거나 응답이 없습니다.",
    };
  }
  return { ok: true };
}

let draining = false;

export async function drainTelegramNotifications(limit = 20): Promise<{
  processed: number;
  sent: number;
}> {
  if (draining) return { processed: 0, sent: 0 };
  draining = true;
  try {
    const now = new Date();
    // 전송 중 프로세스가 종료된 row 는 10분 뒤 다시 집는다.
    await prisma.telegramNotification.updateMany({
      where: {
        status: "PROCESSING",
        updatedAt: { lt: new Date(now.getTime() - 10 * 60_000) },
      },
      data: { status: "PENDING", nextAttemptAt: now },
    });
    const rows = await prisma.telegramNotification.findMany({
      where: { status: "PENDING", nextAttemptAt: { lte: now } },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true, kind: true, payload: true, attempts: true },
    });

    let sent = 0;
    for (const row of rows) {
      const claimed = await prisma.telegramNotification.updateMany({
        where: { id: row.id, status: "PENDING" },
        data: { status: "PROCESSING" },
      });
      if (claimed.count !== 1) continue;

      const payload = row.kind === "DEPLOY_COMPLETION"
        ? deployCompletionPayload(row.payload)
        : null;
      const result = payload
        ? await deliverDeployCompletion(payload).catch((error) => ({
            ok: false,
            error: error instanceof Error ? error.message : "unknown error",
          }))
        : { ok: false, error: "invalid notification payload" };
      if (result.ok) {
        sent++;
        await prisma.telegramNotification.update({
          where: { id: row.id },
          data: {
            status: "SENT",
            attempts: { increment: 1 },
            sentAt: new Date(),
            lastError: null,
          },
        });
      } else {
        await prisma.telegramNotification.update({
          where: { id: row.id },
          data: {
            status: "PENDING",
            attempts: { increment: 1 },
            nextAttemptAt: nextNotificationAttemptAt(row.attempts),
            lastError: result.error ?? "unknown error",
          },
        });
      }
      await prisma.auditLog.create({
        data: {
          actorLogin: null,
          action: result.ok
            ? "telegram.deploy.notification.sent"
            : "telegram.deploy.notification.failed",
          entityType: "telegram_notification",
          entityId: row.id,
          payload: {
            releaseRecordId: payload?.releaseRecordId ?? null,
            error: result.error ?? null,
          },
        },
      });
    }
    return { processed: rows.length, sent };
  } finally {
    draining = false;
  }
}
