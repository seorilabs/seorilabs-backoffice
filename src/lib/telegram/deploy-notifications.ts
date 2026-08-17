import type { NotificationProvider, Prisma, ReleaseMarket } from "@prisma/client";
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
import { configuredDestinations } from "@/lib/notifications/destinations";
import { DISCORD_OPS_ALERTS } from "@/lib/notifications/destinations";
import { editDiscord, sendDiscord } from "@/lib/notifications/discord";
import { plainTextPayload } from "@/lib/notifications/format";
import { env } from "@/lib/env";
import {
  drainNotifications,
  enqueueNotification,
  type DeliveryOverrideResult,
} from "@/lib/notifications/outbox";
import {
  buildDeployCompletionText,
  buildDeployStatusCardText,
  deployCompletionPayload,
  deployMarketLabel,
  deployNotificationDedupeKey,
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
  await enqueueNotification({
    dedupeKey,
    kind: "DEPLOY_COMPLETION",
    payload: jsonPayload,
    destinations: configuredDestinations(
      payload.status === "SUCCEEDED" || payload.status === "FAILED"
        ? ["telegram", "release-ops"]
        : ["release-ops"],
    ),
  });
}

async function previousDiscordReleaseMessage(
  releaseRecordId: string,
  destinationKey: string,
): Promise<string | null> {
  const delivery = await prisma.notificationDelivery.findFirst({
    where: {
      provider: "DISCORD",
      destinationKey,
      status: "SENT",
      providerMessageId: { not: null },
      event: { dedupeKey: { startsWith: `deploy:${releaseRecordId}:` } },
    },
    orderBy: { sentAt: "desc" },
    select: { providerMessageId: true },
  });
  return delivery?.providerMessageId ?? null;
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

async function deliverDeployCompletion(
  payload: DeployCompletionPayload,
  provider: NotificationProvider,
  destinationKey: string,
): Promise<DeliveryOverrideResult> {
  const release = await prisma.releaseRecord.findUnique({
    where: { id: payload.releaseRecordId },
    select: {
      id: true,
      version: true,
      market: true,
      status: true,
      workflowName: true,
      externalBuildNumber: true,
      updatedAt: true,
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
  if (provider === "DISCORD") {
    const text = buildDeployStatusCardText({
      displayName: release.app.displayName,
      version: release.version,
      market: release.market,
      // 오래된 outbox 재시도가 최신 카드를 과거 상태로 되돌리지 않게
      // 이벤트 payload가 아니라 mirror의 현재 상태를 표시한다.
      status: release.status,
      workflowName: release.workflowName,
      externalBuildNumber: release.externalBuildNumber,
      runUrl: payload.runUrl,
      updatedAt: release.updatedAt,
    });
    const messageId = await previousDiscordReleaseMessage(release.id, destinationKey);
    if (messageId) {
      const edited = await editDiscord(destinationKey, messageId, text);
      if (edited.ok || edited.statusCode !== 404) return edited;
    }
    return sendDiscord(destinationKey, text);
  }
  if (payload.status !== "SUCCEEDED" && payload.status !== "FAILED") {
    return { ok: false, error: "Telegram에는 완료 상태만 전송할 수 있습니다." };
  }
  const note = `${payload.status === "SUCCEEDED" ? "✅" : "❌"} ${deployMarketLabel(release.market)} 배포 ${payload.status === "SUCCEEDED" ? "완료" : "실패"}`;
  const text = buildDeployCompletionText({
    displayName: release.app.displayName,
    version: release.version,
    market: release.market,
    status: payload.status,
    workflowName: release.workflowName,
    externalBuildNumber: release.externalBuildNumber,
    runUrl: payload.runUrl,
  });
  const contexts = await releaseMessageContexts(release.app, release.version, release.market);
  // 원문 갱신은 Telegram delivery의 best-effort 보조 동작이다.
  for (const context of contexts) {
    await rebuildReleaseDeployMessage(
      context.chatId,
      context.messageId,
      release.app,
      release.version,
      note,
    ).catch(() => false);
  }
  const response = await notify(text);
  return telegramResponseOk(response)
    ? { ok: true }
    : {
        ok: false,
        error: response?.description ?? "Telegram이 설정되지 않았거나 응답이 없습니다.",
      };
}

export async function drainAllNotifications(limit = 30) {
  return drainNotifications(limit, async ({ kind, provider, destinationKey, payload }) => {
    if (kind !== "DEPLOY_COMPLETION") {
      const text = plainTextPayload(kind, payload, provider);
      if (!text) return { ok: false, error: "알림 payload 형식 오류" };
      if (provider === "DISCORD") {
        return sendDiscord(destinationKey, text, {
          alertRoleId:
            destinationKey === DISCORD_OPS_ALERTS
              ? env.optional("DISCORD_RELEASE_OPS_ROLE_ID").trim()
              : undefined,
        });
      }
      const response = await notify(text);
      return telegramResponseOk(response)
        ? { ok: true }
        : { ok: false, error: response?.description ?? "Telegram 응답 없음" };
    }
    const deploy = deployCompletionPayload(payload);
    if (!deploy) return { ok: false, error: "invalid deploy notification payload" };
    return deliverDeployCompletion(deploy, provider, destinationKey).catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : "unknown error",
    }));
  });
}
