import type { NotificationProvider, Prisma, ReleaseMarket } from "@prisma/client";
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
  isReleaseTag,
  type AppStoreReviewCardState,
  type DeployCompletionPayload,
} from "@/lib/notifications/deploy-format";
import { marketingVersionFromTag, readAppStoreReviewStatus } from "@/lib/app-store/submit";
import { incidentComponents, incidentDeliveryMode, incidentMessage } from "@/lib/notifications/incidents";

/**
 * 이 배포가 이어 써야 할 카드 메시지.
 *
 * 한 마켓·버전의 배포는 실행이 여러 개로 갈린다(업로드 → 프로덕션 승격, 재시도, 태그 push 와
 * 명시 dispatch 중복). 실행마다 ReleaseRecord 가 따로 생기므로 releaseRecordId 로만 찾으면
 * 그때마다 새 카드가 채널에 쌓인다. 같은 앱·마켓·버전의 카드는 하나로 유지한다.
 */
async function previousReleaseMessage(
  release: { appId: string; market: ReleaseMarket; version: string },
  destinationKey: string,
) {
  const siblings = await prisma.releaseRecord.findMany({
    where: { appId: release.appId, market: release.market, version: release.version },
    select: { id: true },
  });
  if (siblings.length === 0) return null;
  const delivery = await prisma.notificationDelivery.findFirst({
    where: {
      provider: "DISCORD",
      destinationKey,
      status: "SENT",
      providerMessageId: { not: null },
      event: {
        OR: siblings.map((s) => ({ dedupeKey: { startsWith: `deploy:${s.id}:` } })),
      },
    },
    // 가장 최근 카드를 이어 쓴다. 사람이 카드를 지워 edit 이 10008 로 실패하면 새로 보내고,
    // 다음 갱신은 그 새 카드를 집어 자기 복구된다. 가장 오래된 것을 고르면 지워진 메시지를
    // 계속 편집 시도하다 매번 새 카드를 만든다.
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
export interface DeployCardRender {
  text: string;
  components: DiscordActionRow[];
  /** 카드 메시지를 공유하는 단위. 같은 앱·마켓·버전이면 같은 카드다. */
  release: { appId: string; market: ReleaseMarket; version: string };
}

export async function renderDeployCard(
  releaseRecordId: string,
  runUrl?: string,
): Promise<DeployCardRender | null> {
  const release = await prisma.releaseRecord.findUnique({
    where: { id: releaseRecordId },
    select: {
      id: true,
      appId: true,
      version: true,
      market: true,
      status: true,
      track: true,
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

  // 태그가 없으면 어차피 버튼을 달지 않는다. ASC 를 헛되이 호출하지 않는다.
  const actionable = release.status === "SUCCEEDED" && isReleaseTag(release.version);
  const review =
    actionable && release.market === "APPSTORE"
      ? await appStoreReviewCardState(release.app.iosBundle, release.version)
      : null;

  // 같은 태그의 승격 배포가 이미 있으면(진행 중·성공) 승격 버튼을 다시 달지 않는다.
  // 실패한 승격은 재시도할 수 있어야 하므로 세지 않는다.
  const promotionRequested =
    actionable &&
    release.market === "PLAY" &&
    (await prisma.releaseRecord.count({
      where: {
        appId: release.appId,
        market: "PLAY",
        version: release.version,
        track: "production",
        status: { in: ["PENDING", "IN_PROGRESS", "SUCCEEDED"] },
      },
    })) > 0;

  return {
    release: { appId: release.appId, market: release.market, version: release.version },
    text: buildDeployStatusCardText({
      displayName: release.app.displayName,
      version: release.version,
      market: release.market,
      status: release.status,
      track: release.track,
      workflowName: release.workflowName,
      externalBuildNumber: release.externalBuildNumber,
      runUrl: resolvedRunUrl,
      updatedAt: release.updatedAt,
    }),
    components: deployCardComponents({
      releaseRecordId: release.id,
      market: release.market,
      status: release.status,
      version: release.version,
      promotionRequested,
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
  const messageId = await previousReleaseMessage(card.release, destinationKey);
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
  return drainNotifications(limit, async ({ kind, provider, destinationKey, payload, providerMessageId }) => {
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
    // 신규 계정 요약은 같은 카드를 계속 갱신한다. 사람이 지웠으면 새로 만든다.
    if (kind === "IDENTITY_SUMMARY" && providerMessageId) {
      const edited = await editDiscord(destinationKey, providerMessageId, text);
      if (edited.ok || edited.statusCode !== 404 || edited.errorCode !== 10_008) return edited;
    }
    return sendDiscord(destinationKey, text, {
      alertRoleId:
        destinationKey === DISCORD_OPS_ALERTS ? env.discordRoleId("release_ops") : undefined,
      attachment: attachmentFromPayload(payload),
      components: componentsFromPayload(payload),
    });
  });
}
