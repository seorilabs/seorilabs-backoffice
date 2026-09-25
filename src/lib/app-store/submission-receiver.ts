import { createHash } from "node:crypto";

import type { StoreReviewStore } from "@prisma/client";
import { NotificationKind, NotificationProvider } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  normalizeSubmissionState,
} from "@/lib/store-reviews/submissions/normalizer";
import { dispatchSubmissionObservation } from "@/lib/store-reviews/submissions/collector";
import type { SubmissionDedupeDecision } from "@/lib/store-reviews/submissions/store-agnostic-dedupe";
import { enqueueNotification } from "@/lib/notifications/outbox";
import {
  DISCORD_RELEASE_OPS,
  type NotificationDestination,
} from "@/lib/notifications/destinations";
import type { AppleSubmissionEvent } from "@/lib/app-store/submission-events";

function actorFromPayload(rawPayload: unknown): string | null {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const env = rawPayload as {
    data?: { attributes?: { actor?: unknown } };
    notification?: { data?: { attributes?: { actor?: unknown } } };
  };
  const candidate =
    env.data?.attributes?.actor ?? env.notification?.data?.attributes?.actor;
  return typeof candidate === "string" ? candidate : null;
}

function extractHash(decision: SubmissionDedupeDecision): string {
  return decision.contentHash;
}

function dedupeKeyFor(
  store: StoreReviewStore,
  externalVersionId: string,
  state: string,
  eventDate: Date,
): string {
  return [
    "appstore",
    store,
    externalVersionId,
    state,
    String(eventDate.getTime()),
  ].join(":");
}

function cardPayloadFrom(input: {
  store: StoreReviewStore;
  appId: string;
  appDisplayName: string;
  bundleId: string;
  versionLabel: string;
  actor: string | null;
  state: string;
  normalized: ReturnType<typeof normalizeSubmissionState>;
  previousState: string | null;
  sourceEventAt: Date;
}): unknown {
  const dedupeStamp = createHash("sha256")
    .update(
      JSON.stringify({
        store: input.store,
        appId: input.appId,
        version: input.versionLabel,
        state: input.state,
        ts: input.sourceEventAt.toISOString(),
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return {
    kind: "store_submission_state_changed",
    store: input.store,
    appId: input.appId,
    appDisplayName: input.appDisplayName,
    bundleId: input.bundleId,
    versionLabel: input.versionLabel,
    actor: input.actor,
    state: input.state,
    stateLabel: input.normalized.stateLabel,
    emoji: input.normalized.emoji,
    storeColorHex: input.normalized.storeColorHex,
    previousState: input.previousState,
    sourceEventAt: input.sourceEventAt.toISOString(),
    link: `https://backoffice.vzyx.xyz/apps/${input.appId}/releases`,
    dedupeStamp,
  };
}

const DISCORD_RELEASE_OPS_DESTINATION: NotificationDestination = {
  provider: NotificationProvider.DISCORD,
  key: DISCORD_RELEASE_OPS,
};

export interface ReceiveAppStoreSubmissionResult {
  externalEventId: string;
  decision: "baseline" | "duplicate" | "transition" | "no-change" | "ignored";
  notified: boolean;
}

export async function receiveAppStoreSubmissionEvent(
  event: AppleSubmissionEvent,
): Promise<ReceiveAppStoreSubmissionResult> {
  const normalized = normalizeSubmissionState({
    store: event.store,
    state: event.state,
  });
  const actor = actorFromPayload(event.rawPayload) ?? event.actor;
  const app = event.bundleId
    ? await prisma.app.findFirst({
        where: { iosBundle: event.bundleId },
        select: { id: true, displayName: true, marketTargets: true },
      })
    : null;
  if (!app) {
    return {
      externalEventId: event.externalEventId,
      decision: "ignored",
      notified: false,
    };
  }

  const previous =
    event.externalVersionId
      ? await prisma.storeReviewSubmissionObservation.findFirst({
          where: {
            appId: app.id,
            store: event.store,
            externalVersionId: event.externalVersionId,
          },
          orderBy: { sourceEventAt: "desc" },
          select: { state: true, notifiedHash: true },
        })
      : null;
  const dispatched = dispatchSubmissionObservation({
    store: event.store,
    externalEventId: event.externalEventId,
    state: event.state,
    trackName: null,
    externalVersionId: event.externalVersionId,
    previousState: previous?.state ?? null,
    lastNotifiedHash: previous?.notifiedHash ?? null,
  });
  const isTransition = dispatched.notify !== false;

  const dispatchedHash = extractHash(dispatched.decision);

  await prisma.storeReviewSubmissionObservation.upsert({
    where: {
      store_externalEventId: {
        store: event.store,
        externalEventId: event.externalEventId,
      },
    },
    create: {
      appId: app.id,
      store: event.store,
      externalEventId: event.externalEventId,
      externalVersionId: event.externalVersionId,
      state: event.state,
      stateLabel: normalized.stateLabel,
      previousState: previous?.state ?? null,
      rawPayload: event.rawPayload as object,
      contentHash: dispatchedHash,
      notifiedHash: isTransition ? dispatchedHash : previous?.notifiedHash ?? null,
      trackName: null,
      sourceEventAt: event.sourceEventAt,
      expiresAt: new Date(event.sourceEventAt.getTime() + 7 * 24 * 60 * 60 * 1000),
    },
    update: {
      state: event.state,
      stateLabel: normalized.stateLabel,
      previousState: previous?.state ?? null,
      rawPayload: event.rawPayload as object,
      contentHash: dispatchedHash,
      notifiedHash: isTransition ? dispatchedHash : previous?.notifiedHash ?? null,
      trackName: null,
      sourceEventAt: event.sourceEventAt,
      lastObservedAt: new Date(),
      expiresAt: new Date(event.sourceEventAt.getTime() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  if (!isTransition) {
    return {
      externalEventId: event.externalEventId,
      decision: (dispatched.decision.kind === "transition"
        ? "no-change"
        : dispatched.decision.kind) as "baseline" | "duplicate" | "no-change",
      notified: false,
    };
  }

  const dedupeKey = dedupeKeyFor(
    event.store,
    event.externalVersionId ?? event.externalEventId,
    event.state,
    event.sourceEventAt,
  );
  await enqueueNotification({
    dedupeKey,
    kind: NotificationKind.STORE_REVIEW,
    payload: cardPayloadFrom({
      store: event.store,
      appId: app.id,
      appDisplayName: app.displayName ?? app.id,
      bundleId: event.bundleId ?? "(bundle 미상)",
      versionLabel: event.externalVersionLabel ?? "n/a",
      actor,
      state: event.state,
      normalized,
      previousState: previous?.state ?? null,
      sourceEventAt: event.sourceEventAt,
    }) as never,
    occurredAt: event.sourceEventAt,
    destinations: [DISCORD_RELEASE_OPS_DESTINATION],
  });

  return {
    externalEventId: event.externalEventId,
    decision: "transition",
    notified: true,
  };
}
