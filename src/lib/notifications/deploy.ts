import type { NotificationProvider, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { DISCORD_OPS_ALERTS } from "@/lib/notifications/destinations";
import { editDiscord, sendDiscord, type DiscordActionRow } from "@/lib/notifications/discord";
import { plainTextPayload } from "@/lib/notifications/format";
import { env } from "@/lib/env";
import { drainNotifications, type DeliveryOverrideResult } from "@/lib/notifications/outbox";
import {
  buildDeployStatusCardText,
  deployCardComponents,
  deployCompletionPayload,
  type AppStoreReviewCardState,
  type DeployCompletionPayload,
} from "@/lib/notifications/deploy-format";
import { marketingVersionFromTag, readAppStoreReviewStatus } from "@/lib/app-store/submit";
import { incidentComponents, incidentDeliveryMode, incidentMessage } from "@/lib/notifications/incidents";

async function previousReleaseMessage(releaseRecordId: string, destinationKey: string) {
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

/**
 * App Store 심사 단계 라이브 조회. 카드 렌더를 외부 API 가용성에 묶지 않기 위해
 * 실패는 null 로 흘려보내고(버튼은 새로고침만 남는다) 알림 자체는 계속 보낸다.
 */
async function appStoreReviewCardState(
  iosBundle: string | null,
  version: string,
): Promise<AppStoreReviewCardState | null> {
  if (!iosBundle) return null;
  try {
    const status = await readAppStoreReviewStatus({
      bundleId: iosBundle,
      marketingVersion: marketingVersionFromTag(version),
    });
    return {
      appStoreState: status.appStoreState,
      versionEditable: status.versionEditable,
      submissionState: status.submissionState,
      hasSubmissionItem: status.submissionItemId != null,
    };
  } catch (error) {
    console.error(
      "[deploy-card] App Store 심사 상태 조회 실패:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * 배포 상태 카드의 본문과 액션 버튼. 알림 전달과 카드 버튼 실행 후 재렌더가 공유한다.
 * null = ReleaseRecord 없음.
 */
export async function renderDeployCard(
  releaseRecordId: string,
  runUrl?: string,
): Promise<{ text: string; components: DiscordActionRow[] } | null> {
  const release = await prisma.releaseRecord.findUnique({
    where: { id: releaseRecordId },
    select: {
      id: true,
      version: true,
      market: true,
      status: true,
      workflowName: true,
      workflowRunId: true,
      externalBuildNumber: true,
      updatedAt: true,
      app: { select: { displayName: true, repoFullName: true, iosBundle: true } },
    },
  });
  if (!release) return null;

  // 재렌더 시점에는 알림 payload 가 없으므로 미러된 실행 id 로 링크를 복원한다.
  const resolvedRunUrl =
    runUrl ??
    (release.workflowRunId != null
      ? `https://github.com/${release.app.repoFullName}/actions/runs/${release.workflowRunId}`
      : undefined);

  const review =
    release.market === "APPSTORE" && release.status === "SUCCEEDED"
      ? await appStoreReviewCardState(release.app.iosBundle, release.version)
      : null;

  return {
    text: buildDeployStatusCardText({
      displayName: release.app.displayName,
      version: release.version,
      market: release.market,
      status: release.status,
      workflowName: release.workflowName,
      externalBuildNumber: release.externalBuildNumber,
      runUrl: resolvedRunUrl,
      updatedAt: release.updatedAt,
    }),
    components: deployCardComponents({
      releaseRecordId: release.id,
      market: release.market,
      status: release.status,
      workflowName: release.workflowName,
      review,
    }),
  };
}

async function deliverDeployCompletion(
  payload: DeployCompletionPayload,
  provider: NotificationProvider,
  destinationKey: string,
): Promise<DeliveryOverrideResult> {
  if (provider !== "DISCORD") return { ok: false, error: "unsupported notification provider" };
  const card = await renderDeployCard(payload.releaseRecordId, payload.runUrl);
  if (!card) return { ok: false, error: "release record not found" };
  const options = { components: card.components };
  const messageId = await previousReleaseMessage(payload.releaseRecordId, destinationKey);
  if (messageId) {
    const edited = await editDiscord(destinationKey, messageId, card.text, options);
    if (edited.ok || edited.statusCode !== 404 || edited.errorCode !== 10_008) return edited;
  }
  return sendDiscord(destinationKey, card.text, options);
}

function attachmentFromPayload(payload: Prisma.JsonValue) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = (payload as Prisma.JsonObject).attachment;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Prisma.JsonObject;
  return typeof item.filename === "string" &&
    typeof item.contentType === "string" &&
    typeof item.base64 === "string"
    ? { filename: item.filename, contentType: item.contentType, base64: item.base64 }
    : undefined;
}

function componentsFromPayload(payload: Prisma.JsonValue): DiscordActionRow[] | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = (payload as Prisma.JsonObject).components;
  return Array.isArray(value) ? (value as unknown as DiscordActionRow[]).slice(0, 5) : undefined;
}

export async function drainAllNotifications(limit = 30) {
  return drainNotifications(limit, async ({ kind, provider, destinationKey, payload }) => {
    if (kind === "DEPLOY_COMPLETION") {
      const deploy = deployCompletionPayload(payload);
      if (!deploy) return { ok: false, error: "invalid deploy notification payload" };
      return deliverDeployCompletion(deploy, provider, destinationKey).catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : "unknown error",
      }));
    }
    if (kind === "INCIDENT") {
      if (provider !== "DISCORD") return { ok: false, error: "unsupported notification provider" };
      const incidentId = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Prisma.JsonObject).incidentId
        : null;
      if (typeof incidentId !== "string") return { ok: false, error: "invalid incident payload" };
      const incident = await prisma.operationalIncident.findUnique({ where: { id: incidentId } });
      if (!incident) return { ok: false, error: "incident not found" };
      const options = {
        alertRoleId: incident.status === "OPEN" ? env.discordRoleId("release_ops") : undefined,
        components: incidentComponents(incident),
      };
      const deliveryMode = incidentDeliveryMode(incident.providerMessageId);
      let result = deliveryMode.kind === "edit"
        ? await editDiscord(destinationKey, deliveryMode.messageId, incidentMessage(incident), options)
        : null;
      if (!result || (!result.ok && result.statusCode === 404 && result.errorCode === 10_008)) {
        result = await sendDiscord(destinationKey, incidentMessage(incident), options);
      }
      if (result.ok && result.messageId && result.messageId !== incident.providerMessageId) {
        await prisma.operationalIncident.update({ where: { id: incident.id }, data: { providerMessageId: result.messageId } });
      }
      return result;
    }
    if (provider !== "DISCORD") return { ok: false, error: "unsupported notification provider" };
    const text = plainTextPayload(kind, payload);
    if (!text) return { ok: false, error: "알림 payload 형식 오류" };
    return sendDiscord(destinationKey, text, {
      alertRoleId:
        destinationKey === DISCORD_OPS_ALERTS ? env.discordRoleId("release_ops") : undefined,
      attachment: attachmentFromPayload(payload),
      components: componentsFromPayload(payload),
    });
  });
}
