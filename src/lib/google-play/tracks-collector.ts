import { createHash } from "node:crypto";

import { NotificationProvider } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  normalizeSubmissionState,
} from "@/lib/store-reviews/submissions/normalizer";
import { dispatchSubmissionObservation } from "@/lib/store-reviews/submissions/collector";
import { enqueueNotification } from "@/lib/notifications/outbox";
import {
  DISCORD_RELEASE_OPS,
  type NotificationDestination,
} from "@/lib/notifications/destinations";
import type { GooglePlayTracksRelease } from "@/lib/google-play/tracks-fetcher";

const DISCORD_RELEASE_OPS_DESTINATION: NotificationDestination = {
  provider: NotificationProvider.DISCORD,
  key: DISCORD_RELEASE_OPS,
};

export interface GooglePlayTrackObservation {
  appId: string;
  store: "GOOGLE_PLAY";
  externalEventId: string;
  externalVersionId: string;
  trackName: string;
  state: GooglePlayTracksRelease["status"];
  sourceEventAt: Date;
  rawPayload: unknown;
}

function dedupeKeyFor(input: {
  externalVersionId: string;
  trackName: string;
  state: string;
  sourceEventAt: Date;
}): string {
  return [
    "google-play",
    input.externalVersionId,
    input.trackName,
    input.state,
    String(input.sourceEventAt.getTime()),
  ].join(":");
}

function hashContentHash(input: { externalVersionId: string; trackName: string; state: string }): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function cardPayloadFrom(input: {
  appDisplayName: string;
  packageName: string;
  trackName: string;
  releaseName: string;
  normalized: ReturnType<typeof normalizeSubmissionState>;
  previousState: string | null;
  sourceEventAt: Date;
}): unknown {
  return {
    kind: "store_submission_state_changed",
    store: input.normalized.store,
    appDisplayName: input.appDisplayName,
    packageName: input.packageName,
    trackName: input.trackName,
    releaseName: input.releaseName,
    state: input.normalized.state,
    stateLabel: input.normalized.stateLabel,
    emoji: input.normalized.emoji,
    storeColorHex: input.normalized.storeColorHex,
    previousState: input.previousState,
    sourceEventAt: input.sourceEventAt.toISOString(),
  };
}

function extractContentHash(decision: { contentHash: string }): string {
  return decision.contentHash;
}

export interface ApplyGooglePlayTrackResult {
  appId: string;
  release: GooglePlayTracksRelease;
  decision: "transition" | "no-change" | "baseline" | "duplicate" | "ignored";
  notified: boolean;
}

export async function applyGooglePlayTrackRelease(input: {
  appId: string;
  appDisplayName: string;
  packageName: string;
  release: GooglePlayTracksRelease;
  sourceEventAt: Date;
}): Promise<ApplyGooglePlayTrackResult> {
  const normalized = normalizeSubmissionState({
    store: "GOOGLE_PLAY",
    state: input.release.status,
  });
  const externalVersionId = `${input.release.trackName}:${input.release.releaseName}`;
  const externalEventId = `${externalVersionId}:${input.release.status}:${Math.floor(
    (input.sourceEventAt.getTime() ?? Date.now()) / 1000,
  )}`;
  const previous = await prisma.storeReviewSubmissionObservation.findFirst({
    where: {
      appId: input.appId,
      store: "GOOGLE_PLAY",
      externalVersionId,
    },
    orderBy: { sourceEventAt: "desc" },
    select: { state: true, notifiedHash: true },
  });
  const dispatched = dispatchSubmissionObservation({
    store: "GOOGLE_PLAY",
    externalEventId,
    state: input.release.status,
    trackName: input.release.trackName,
    externalVersionId,
    previousState: previous?.state ?? null,
    lastNotifiedHash: previous?.notifiedHash ?? null,
  });
  const isTransition = dispatched.notify !== false;
  const dispatchedHash = extractContentHash(dispatched.decision);

  await prisma.storeReviewSubmissionObservation.upsert({
    where: {
      store_externalEventId: {
        store: "GOOGLE_PLAY",
        externalEventId,
      },
    },
    create: {
      appId: input.appId,
      store: "GOOGLE_PLAY",
      externalEventId,
      externalVersionId,
      state: input.release.status,
      stateLabel: normalized.stateLabel,
      previousState: previous?.state ?? null,
      rawPayload: input.release as object,
      contentHash: dispatchedHash,
      notifiedHash: isTransition
        ? dispatchedHash
        : previous?.notifiedHash ?? null,
      trackName: input.release.trackName,
      sourceEventAt: input.sourceEventAt,
      expiresAt: new Date(
        input.sourceEventAt.getTime() + 7 * 24 * 60 * 60 * 1000,
      ),
    },
    update: {
      state: input.release.status,
      stateLabel: normalized.stateLabel,
      previousState: previous?.state ?? null,
      rawPayload: input.release as object,
      contentHash: dispatchedHash,
      notifiedHash: isTransition
        ? dispatchedHash
        : previous?.notifiedHash ?? null,
      trackName: input.release.trackName,
      sourceEventAt: input.sourceEventAt,
      lastObservedAt: new Date(),
      expiresAt: new Date(
        input.sourceEventAt.getTime() + 7 * 24 * 60 * 60 * 1000,
      ),
    },
  });

  if (!isTransition) {
    return {
      appId: input.appId,
      release: input.release,
      decision: dispatched.decision.kind === "transition" ? "no-change" : dispatched.decision.kind,
      notified: false,
    };
  }

  await enqueueNotification({
    dedupeKey: dedupeKeyFor({
      externalVersionId,
      trackName: input.release.trackName,
      state: input.release.status,
      sourceEventAt: input.sourceEventAt,
    }),
    kind: "STORE_REVIEW" as never,
    payload: cardPayloadFrom({
      appDisplayName: input.appDisplayName,
      packageName: input.packageName,
      trackName: input.release.trackName,
      releaseName: input.release.releaseName,
      normalized,
      previousState: previous?.state ?? null,
      sourceEventAt: input.sourceEventAt,
    }) as never,
    occurredAt: input.sourceEventAt,
    destinations: [DISCORD_RELEASE_OPS_DESTINATION],
  });

  return {
    appId: input.appId,
    release: input.release,
    decision: "transition",
    notified: true,
  };
}

export function deriveTracksStatusHash(input: {
  release: GooglePlayTracksRelease;
  sourceTimestampMs: number;
}): string {
  return hashContentHash({
    externalVersionId: `${input.release.trackName}:${input.release.releaseName}`,
    trackName: input.release.trackName,
    state: input.release.status,
  });
}
