import type { NotificationProvider, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { configuredDestinations, DISCORD_OPS_ALERTS } from "@/lib/notifications/destinations";
import { editDiscord, sendDiscord, type DiscordActionRow } from "@/lib/notifications/discord";
import { plainTextPayload } from "@/lib/notifications/format";
import { env } from "@/lib/env";
import { drainNotifications, enqueueNotification, type DeliveryOverrideResult } from "@/lib/notifications/outbox";
import {
  buildDeployStatusCardText,
  deployCompletionPayload,
  deployNotificationDedupeKey,
  type DeployCompletionPayload,
  type EnqueueDeployCompletionPayload,
} from "@/lib/notifications/deploy-format";
import { incidentComponents, incidentDeliveryMode, incidentMessage } from "@/lib/notifications/incidents";

export async function enqueueDeployCompletionNotification(
  payload: EnqueueDeployCompletionPayload,
): Promise<void> {
  await enqueueNotification({
    dedupeKey: deployNotificationDedupeKey(payload.releaseRecordId, payload.eventKey),
    kind: "DEPLOY_COMPLETION",
    payload: {
      releaseRecordId: payload.releaseRecordId,
      status: payload.status,
      ...(payload.runUrl ? { runUrl: payload.runUrl } : {}),
    },
    destinations: configuredDestinations(["release-ops"]),
  });
}

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

async function deliverDeployCompletion(
  payload: DeployCompletionPayload,
  provider: NotificationProvider,
  destinationKey: string,
): Promise<DeliveryOverrideResult> {
  if (provider !== "DISCORD") return { ok: false, error: "unsupported notification provider" };
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
      app: { select: { displayName: true } },
    },
  });
  if (!release) return { ok: false, error: "release record not found" };
  const text = buildDeployStatusCardText({
    displayName: release.app.displayName,
    version: release.version,
    market: release.market,
    status: release.status,
    workflowName: release.workflowName,
    externalBuildNumber: release.externalBuildNumber,
    runUrl: payload.runUrl,
    updatedAt: release.updatedAt,
  });
  const messageId = await previousReleaseMessage(release.id, destinationKey);
  if (messageId) {
    const edited = await editDiscord(destinationKey, messageId, text);
    if (edited.ok || edited.statusCode !== 404 || edited.errorCode !== 10_008) return edited;
  }
  return sendDiscord(destinationKey, text);
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
