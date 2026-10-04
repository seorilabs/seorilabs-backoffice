import { createHash } from "node:crypto";
import { persistSubmission } from "@/lib/store-reviews/submissions/persist";
import { normalizeSubmissionState } from "@/lib/store-reviews/submissions/normalizer";
import { encodePlayState, PLAY_UNAVAILABLE } from "@/lib/google-play/release-state";
import type { GooglePlayTracksRelease } from "@/lib/google-play/tracks-fetcher";
import type { Prisma } from "@prisma/client";

interface TrackInput {
  appId: string;
  appDisplayName: string;
  packageName: string;
  release: GooglePlayTracksRelease;
  sourceEventAt: Date;
}

export function googlePlaySubmissionCard(input: TrackInput, state: string, previousState: string | null, firstPublishedObservedAt: Date | null): Prisma.InputJsonObject {
  const normalized = normalizeSubmissionState({ store: "GOOGLE_PLAY", state, trackName: input.release.trackName });
  return {
    kind: "store_submission_state_changed",
    text: `${normalized.emoji} ${normalized.stateLabel}\n앱: ${input.appDisplayName}\n트랙: ${input.release.trackName}\n버전: ${input.release.releaseName} · 코드 ${input.release.versionCodes.join(", ")}\n이전 단계: ${previousState ? normalizeSubmissionState({ store: "GOOGLE_PLAY", state: previousState, trackName: input.release.trackName }).stateLabel : "첫 관측"}${firstPublishedObservedAt ? `\n${input.release.trackName.split(":").at(-1) === "production" ? "공개" : "제공"} 확인 시각: ${firstPublishedObservedAt.toISOString()}` : ""}`,
    embed: { title: `Google Play · ${input.appDisplayName}`, color: normalized.storeColorHex, timestamp: input.sourceEventAt.toISOString() },
    appId: input.appId, store: "GOOGLE_PLAY", packageName: input.packageName,
  };
}

export function googlePlaySubmissionWrites(input: TrackInput) {
  const state = input.release.unavailableReason || !input.release.lifecycle ? PLAY_UNAVAILABLE : encodePlayState({
    lifecycle: input.release.lifecycle, status: input.release.status, userFraction: input.release.userFraction ?? null,
  });
  // 여러 artifact의 구성 변경에도 각 버전의 기준 상태를 유지한다.
  return [...new Set(input.release.versionCodes)].map((versionCode) => {
    const externalVersionId = createHash("sha256").update(JSON.stringify([input.packageName, input.release.trackName, versionCode])).digest("hex");
    const externalEventId = createHash("sha256").update(JSON.stringify([input.appId, externalVersionId, state, input.sourceEventAt.toISOString()])).digest("hex");
    return {
      appId: input.appId, store: "GOOGLE_PLAY", externalEventId, externalVersionId,
      trackName: input.release.trackName, state, rawPayload: input.release as object,
      sourceEventAt: input.sourceEventAt,
      card: (previousState: string | null, firstPublishedObservedAt?: Date | null) => googlePlaySubmissionCard({ ...input, release: { ...input.release, versionCodes: [versionCode] } }, state, previousState, firstPublishedObservedAt ?? null),
    } as const;
  });
}

export async function applyGooglePlayTrackRelease(input: TrackInput) {
  const decisions = [];
  for (const write of googlePlaySubmissionWrites(input)) decisions.push(await persistSubmission(write));
  return { appId: input.appId, release: input.release, decisions, notified: decisions.includes("transition") };
}
