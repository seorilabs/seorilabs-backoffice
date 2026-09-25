import { NotificationKind, Prisma, type StoreReviewStore } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dispatchSubmissionObservation } from "@/lib/store-reviews/submissions/collector";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { DISCORD_RELEASE_OPS } from "@/lib/notifications/destinations";

export interface SubmissionWrite {
  appId: string;
  store: StoreReviewStore;
  externalEventId: string;
  externalVersionId: string;
  trackName: string | null;
  state: string;
  rawPayload: Prisma.InputJsonValue;
  sourceEventAt: Date;
  initialPreviousState?: string | null;
  notifyOnFirstObservation?: boolean;
  card: (previousState: string | null) => Prisma.InputJsonObject;
  skipNoChange?: boolean;
}

export function shouldNotifySubmission(input: {
  decision: "baseline" | "duplicate" | "transition" | "no-change";
  notifyOnFirstObservation: boolean;
  previousObservedAt: Date | null;
  sourceEventAt: Date;
}): boolean {
  if (input.previousObservedAt && input.sourceEventAt < input.previousObservedAt) return false;
  return input.decision === "transition" ||
    (input.decision === "baseline" && input.notifyOnFirstObservation);
}

export async function persistSubmission(input: SubmissionWrite): Promise<"baseline" | "duplicate" | "transition" | "no-change"> {
  try {
    return await prisma.$transaction(async (tx) => {
      const duplicate = await tx.storeReviewSubmissionObservation.findUnique({
        where: { store_externalEventId: { store: input.store, externalEventId: input.externalEventId } },
        select: { id: true },
      });
      if (duplicate) return "duplicate";
      const previous = await tx.storeReviewSubmissionObservation.findFirst({
        where: { appId: input.appId, store: input.store, externalVersionId: input.externalVersionId },
        orderBy: { sourceEventAt: "desc" },
        select: { state: true, notifiedHash: true, sourceEventAt: true },
      });
      const decision = dispatchSubmissionObservation({
        store: input.store, externalEventId: input.externalEventId, state: input.state,
        trackName: input.trackName, externalVersionId: input.externalVersionId,
        previousState: previous?.state ?? input.initialPreviousState ?? null,
        lastNotifiedHash: previous?.notifiedHash ?? null,
      });
      const kind = decision.decision.kind;
      if (kind === "no-change" && input.skipNoChange) return "no-change";
      const notify = shouldNotifySubmission({
        decision: kind,
        notifyOnFirstObservation: input.notifyOnFirstObservation ?? false,
        previousObservedAt: previous?.sourceEventAt ?? null,
        sourceEventAt: input.sourceEventAt,
      });
      await tx.storeReviewSubmissionObservation.create({
        data: {
          appId: input.appId, store: input.store, externalEventId: input.externalEventId,
          externalVersionId: input.externalVersionId, trackName: input.trackName,
          state: input.state, stateLabel: decision.normalized.stateLabel,
          previousState: previous?.state ?? input.initialPreviousState ?? null,
          rawPayload: input.rawPayload,
          contentHash: decision.decision.contentHash,
          notifiedHash: notify ? decision.decision.contentHash : previous?.notifiedHash ?? null,
          sourceEventAt: input.sourceEventAt,
          expiresAt: new Date(input.sourceEventAt.getTime() + 7 * 24 * 60 * 60_000),
        },
      });
      if (notify) {
        await enqueueNotification({
          dedupeKey: `store-submission:${input.store}:${input.externalEventId}`,
          kind: NotificationKind.STORE_REVIEW,
          payload: input.card(previous?.state ?? input.initialPreviousState ?? null),
          occurredAt: input.sourceEventAt,
          destinations: [{ provider: "DISCORD", key: DISCORD_RELEASE_OPS }],
        }, tx);
      }
      return notify ? "transition" : kind === "transition" ? "no-change" : kind;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return "duplicate";
    }
    throw error;
  }
}
