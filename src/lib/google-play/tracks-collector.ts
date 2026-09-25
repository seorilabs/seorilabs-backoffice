import { createHash } from "node:crypto";
import { persistSubmission } from "@/lib/store-reviews/submissions/persist";
import { normalizeSubmissionState } from "@/lib/store-reviews/submissions/normalizer";
import type { GooglePlayTracksRelease } from "@/lib/google-play/tracks-fetcher";

export interface ApplyGooglePlayTrackResult {
  appId: string;
  release: GooglePlayTracksRelease;
  decision: "transition" | "no-change" | "baseline" | "duplicate";
  notified: boolean;
}

export async function applyGooglePlayTrackRelease(input: {
  appId: string;
  appDisplayName: string;
  packageName: string;
  release: GooglePlayTracksRelease;
  sourceEventAt: Date;
  baselineComplete: boolean;
}): Promise<ApplyGooglePlayTrackResult> {
  const state = ["inProgress", "halted"].includes(input.release.status) &&
    typeof input.release.userFraction === "number"
    ? `inProgress:${input.release.userFraction}` : input.release.status;
  const normalized = normalizeSubmissionState({ store: "GOOGLE_PLAY", state });
  const codesHash = createHash("sha256")
    .update(JSON.stringify([...input.release.versionCodes].sort())).digest("hex");
  const externalVersionId = `${input.release.trackName}:${codesHash}`;
  const externalEventId = createHash("sha256")
    .update(JSON.stringify([input.appId, externalVersionId, state, input.sourceEventAt.toISOString()]))
    .digest("hex");
  const decision = await persistSubmission({
    appId: input.appId,
    store: "GOOGLE_PLAY",
    externalEventId,
    externalVersionId,
    trackName: input.release.trackName,
    state,
    rawPayload: input.release as object,
    sourceEventAt: input.sourceEventAt,
    notifyOnFirstObservation: input.baselineComplete,
    skipNoChange: true,
    card: (previousState) => ({
      kind: "store_submission_state_changed",
      text: `${normalized.emoji} ${normalized.stateLabel}\n앱: ${input.appDisplayName}\n트랙: ${input.release.trackName}\n버전: ${input.release.releaseName}${typeof input.release.userFraction === "number" ? `\n출시 비율: ${Math.round(input.release.userFraction * 100)}%` : ""}\n이전 단계: ${previousState ? normalizeSubmissionState({ store: "GOOGLE_PLAY", state: previousState }).stateLabel : "첫 관측"}`,
      embed: {
        title: `Google Play · ${input.appDisplayName}`,
        color: normalized.storeColorHex,
        timestamp: input.sourceEventAt.toISOString(),
      },
      appId: input.appId, store: "GOOGLE_PLAY", packageName: input.packageName,
    }),
  });
  return { appId: input.appId, release: input.release, decision, notified: decision === "transition" };
}
