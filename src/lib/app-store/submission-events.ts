import type { StoreReviewStore } from "@prisma/client";

export interface AppleSubmissionEvent {
  store: "APP_STORE";
  externalEventId: string;
  externalVersionId: string;
  externalVersionLabel: string | null;
  state: string;
  bundleId: string | null;
  actor: string | null;
  sourceEventAt: Date;
  rawPayload: unknown;
}

// https://developer.apple.com/documentation/appstoreconnectapi/configuring-webhook-notifications
export function extractAppleSubmissionEvent(payload: unknown): AppleSubmissionEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const event = data as {
    id?: unknown;
    type?: unknown;
    attributes?: { newValue?: unknown; timestamp?: unknown };
    relationships?: { instance?: { data?: { id?: unknown; type?: unknown } } };
  };
  if (event.type !== "appStoreVersionAppVersionStateUpdated") return null;
  const version = event.relationships?.instance?.data;
  if (version?.type !== "appStoreVersions" ||
      typeof version.id !== "string" || !version.id ||
      typeof event.id !== "string" || !event.id ||
      typeof event.attributes?.newValue !== "string" || !event.attributes.newValue ||
      typeof event.attributes.timestamp !== "string") return null;
  const sourceEventAt = new Date(event.attributes.timestamp);
  if (Number.isNaN(sourceEventAt.getTime())) return null;
  return {
    store: "APP_STORE" satisfies StoreReviewStore,
    externalEventId: event.id,
    externalVersionId: version.id,
    externalVersionLabel: null,
    state: event.attributes.newValue,
    bundleId: null,
    actor: null,
    sourceEventAt,
    rawPayload: payload,
  };
}
