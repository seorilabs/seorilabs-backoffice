import { prisma } from "@/lib/prisma";
import { persistSubmission } from "@/lib/store-reviews/submissions/persist";
import { normalizeSubmissionState } from "@/lib/store-reviews/submissions/normalizer";
import type { AppleSubmissionEvent } from "@/lib/app-store/submission-events";

export interface ReceiveAppStoreSubmissionResult {
  externalEventId: string;
  decision: "baseline" | "duplicate" | "transition" | "no-change" | "ignored";
  notified: boolean;
}

export async function receiveAppStoreSubmissionEvent(
  event: AppleSubmissionEvent,
): Promise<ReceiveAppStoreSubmissionResult> {
  const app = event.bundleId
    ? await prisma.app.findFirst({
        where: { iosBundle: event.bundleId },
        select: { id: true, displayName: true, marketTargets: true },
      })
    : null;
  if (!app || !Array.isArray(app.marketTargets) || !app.marketTargets.includes("appstore")) {
    return { externalEventId: event.externalEventId, decision: "ignored", notified: false };
  }
  const normalized = normalizeSubmissionState({ store: "APP_STORE", state: event.state });
  const decision = await persistSubmission({
    appId: app.id,
    store: "APP_STORE",
    externalEventId: event.externalEventId,
    externalVersionId: event.externalVersionId,
    trackName: null,
    state: event.state,
    rawPayload: event.rawPayload as object,
    sourceEventAt: event.sourceEventAt,
    card: (previousState) => ({
      kind: "store_submission_state_changed",
      text: `${normalized.emoji} ${normalized.stateLabel}\n앱: ${app.displayName ?? app.id}\n버전: ${event.externalVersionLabel ?? "확인 중"}\n이전 단계: ${previousState ? normalizeSubmissionState({ store: "APP_STORE", state: previousState }).stateLabel : "첫 관측"}`,
      embed: {
        title: `App Store · ${app.displayName ?? app.id}`,
        color: normalized.storeColorHex,
        timestamp: event.sourceEventAt.toISOString(),
      },
      appId: app.id, store: "APP_STORE", externalVersionId: event.externalVersionId,
    }),
  });
  return { externalEventId: event.externalEventId, decision, notified: decision === "transition" };
}
