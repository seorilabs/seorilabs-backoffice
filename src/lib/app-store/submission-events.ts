import type { StoreReviewStore } from "@prisma/client";

export interface AppleSubmissionEvent {
  store: "APP_STORE";
  externalEventId: string;
  externalVersionId: string | null;
  externalVersionLabel: string | null;
  state: string;
  bundleId: string | null;
  actor: string | null;
  sourceEventAt: Date;
  rawPayload: unknown;
}

const SUPPORTED_EVENT_TYPES = new Set<string>([
  "appStoreVersionAppVersionStateUpdated",
  "appStoreVersionStateChanged",
]);

interface WebhookEventData {
  id?: string;
  type?: string;
  attributes?: {
    eventType?: string;
    eventDate?: string;
    signedPayloadState?: { appStoreVersion?: unknown };
    appStoreVersion?: unknown;
    event?: unknown;
  };
}

interface WebhookEnvelope {
  data?: WebhookEventData;
  notification?: WebhookEventData;
}

function pickEnvelope(payload: unknown): WebhookEventData | null {
  if (!payload || typeof payload !== "object") return null;
  const env = payload as WebhookEnvelope;
  if (env.notification && typeof env.notification === "object") {
    return env.notification;
  }
  if (env.data && typeof env.data === "object") {
    return env.data;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function bundleIdFromVersion(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const version = value as { type?: unknown; id?: unknown; attributes?: { bundleId?: unknown } };
  if (version.type !== "appStoreVersions") return asString(version.id ?? null);
  return asString(version.attributes?.bundleId ?? null);
}

export function extractAppleSubmissionEvent(
  payload: unknown,
): AppleSubmissionEvent | null {
  const envelope = pickEnvelope(payload);
  if (!envelope) return null;
  const eventType = asString(envelope.attributes?.eventType);
  if (!eventType || !SUPPORTED_EVENT_TYPES.has(eventType)) {
    return null;
  }
  const versionRef =
    (envelope.attributes?.signedPayloadState?.appStoreVersion as unknown) ??
    envelope.attributes?.appStoreVersion ??
    envelope.attributes?.event;
  if (!versionRef || typeof versionRef !== "object") {
    return null;
  }
  const version = versionRef as { id?: unknown; attributes?: { appVersionState?: unknown; version?: unknown } };
  const versionId = asString(version.id);
  const state = asString(version.attributes?.appVersionState);
  if (!versionId || !state) return null;
  const eventId = asString(envelope.id);
  if (!eventId) return null;
  const eventDateRaw = asString(envelope.attributes?.eventDate);
  const sourceEventAt = eventDateRaw ? new Date(eventDateRaw) : new Date();
  return {
    store: "APP_STORE" satisfies StoreReviewStore,
    externalEventId: eventId,
    externalVersionId: versionId,
    externalVersionLabel: asString(version.attributes?.version),
    state,
    bundleId: bundleIdFromVersion(version),
    actor: null,
    sourceEventAt: Number.isNaN(sourceEventAt.getTime())
      ? new Date()
      : sourceEventAt,
    rawPayload: payload,
  };
}
