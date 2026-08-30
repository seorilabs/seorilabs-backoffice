import type { Prisma, ReleaseMarket } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { DISCORD_OPS_ALERTS, discordChannelId } from "@/lib/notifications/destinations";
import {
  createDiscordChannelMessage,
  editDiscord,
  sendDiscord,
  startDiscordThread,
  type DiscordActionRow,
} from "@/lib/notifications/discord";
import { plainTextPayload } from "@/lib/notifications/format";
import { senderBotToken } from "@/lib/notifications/sender";
import { issueThreadPayload, threadStartFailure } from "@/lib/notifications/issue-thread";
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
      app: {
        select: {
          displayName: true,
          repoFullName: true,
          iosBundle: true,
          playInternalTestUrl: true,
        },
      },
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
      internalTestUrl: release.app.playInternalTestUrl,
    }),
  };
}

async function deliverDeployCompletion(
  payload: DeployCompletionPayload,
  destinationKey: string,
): Promise<DeliveryOverrideResult> {
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

interface IdentityRowPayload {
  text: string;
  cardDedupeKey: string;
  threadName: string;
  first: boolean;
}

function identityRowPayload(payload: Prisma.JsonValue): IdentityRowPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const object = payload as Prisma.JsonObject;
  const text = object.text;
  const cardDedupeKey = object.cardDedupeKey;
  const threadName = object.threadName;
  if (typeof text !== "string" || typeof cardDedupeKey !== "string" || typeof threadName !== "string") {
    return null;
  }
  return { text, cardDedupeKey, threadName, first: object.first === true };
}

/**
 * 신규 계정 한 건을 요약 카드의 쓰레드에 댓글로 남긴다.
 *
 * 카드 메시지에서 시작한 public thread는 ID가 카드 메시지 ID와 같아서 따로 저장하지
 * 않는다. 하루 첫 댓글만 역할을 멘션한다. 멘션된 사람은 쓰레드 멤버로 추가되므로
 * 그날의 나머지 댓글은 멘션 없이도 알림이 간다.
 *
 * 댓글은 편집하지 않으므로 message ID를 남기지 않는다. 보존기한 정리는 채널 기준으로
 * 지우는데 댓글은 쓰레드 안에 있어 대상이 아니고, 카드가 지워질 때 쓰레드와 함께 사라진다.
 */
/**
 * 이슈 알림 메시지의 쓰레드에 맥락(본문·댓글·PR)을 남긴다.
 *
 * 부모 알림이 아직 안 나갔으면 붙일 곳이 없으므로 실패로 돌려 재시도에 맡긴다
 * (같은 webhook 요청에서 둘 다 enqueue 되므로 보통 다음 drain 에서 해소된다).
 * 쓰레드는 원본 메시지에서 시작하므로 ID 가 메시지 ID 와 같아 따로 저장하지 않는다.
 */
async function deliverIssueThread(
  payload: Prisma.JsonValue,
  destinationKey: string,
): Promise<DeliveryOverrideResult> {
  const thread = issueThreadPayload(payload);
  if (!thread) return { ok: false, error: "invalid issue thread payload" };
  const parent = await prisma.notificationDelivery.findFirst({
    where: {
      provider: "DISCORD",
      destinationKey,
      status: "SENT",
      deletedAt: null,
      providerMessageId: { not: null },
      event: { dedupeKey: thread.parentDedupeKey },
    },
    select: { providerMessageId: true },
  });
  if (!parent?.providerMessageId) return { ok: false, error: "부모 이슈 알림 발송 대기 중" };
  const started = await startDiscordThread(
    discordChannelId(destinationKey),
    parent.providerMessageId,
    thread.threadName,
  );
  if (!started.ok) return threadStartFailure(started);
  const sent = await createDiscordChannelMessage(parent.providerMessageId, thread.text, {
    plain: true,
  });
  return sent.ok ? { ok: true } : sent;
}

async function deliverIdentityRow(
  payload: Prisma.JsonValue,
  destinationKey: string,
): Promise<DeliveryOverrideResult> {
  const row = identityRowPayload(payload);
  if (!row) return { ok: false, error: "invalid identity row payload" };
  const card = await prisma.notificationDelivery.findFirst({
    where: {
      provider: "DISCORD",
      destinationKey,
      status: "SENT",
      deletedAt: null,
      providerMessageId: { not: null },
      event: { dedupeKey: row.cardDedupeKey },
    },
    select: { providerMessageId: true },
  });
  // 카드가 아직 안 나갔으면 쓰레드를 걸 곳이 없다. 실패로 돌려 재시도에 맡긴다.
  if (!card?.providerMessageId) return { ok: false, error: "요약 카드 발송 대기 중" };
  const thread = await startDiscordThread(
    discordChannelId(destinationKey),
    card.providerMessageId,
    row.threadName,
  );
  if (!thread.ok) return thread;
  const sent = await createDiscordChannelMessage(card.providerMessageId, row.text, {
    plain: true,
    ...(row.first ? { alertRoleId: env.discordRoleId("release_ops") } : {}),
  });
  return sent.ok ? { ok: true } : sent;
}

export async function drainAllNotifications(limit = 30) {
  return drainNotifications(limit, async ({ kind, destinationKey, payload, providerMessageId }) => {
    if (kind === "DEPLOY_COMPLETION") {
      const deploy = deployCompletionPayload(payload);
      if (!deploy) return { ok: false, error: "invalid deploy notification payload" };
      return deliverDeployCompletion(deploy, destinationKey).catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : "unknown error",
      }));
    }
    if (kind === "INCIDENT") {
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
    if (kind === "IDENTITY_ROW") return deliverIdentityRow(payload, destinationKey);
    // 쓰레드 게시는 kind 가 아니라 payload 로 구분한다. NotificationKind 는 MySQL ENUM 이라
    // 값 추가에 ALTER MODIFY 가 필요한데 expand-only 게이트가 막는다.
    if (issueThreadPayload(payload)) return deliverIssueThread(payload, destinationKey);
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
      // 재무 리포트처럼 발신자가 지정된 알림은 그 봇 정체로 나간다.
      botToken: senderBotToken(payload),
    });
  });
}
