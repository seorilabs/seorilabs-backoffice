import { NotificationKind, Prisma, type StoreReviewStore } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dispatchSubmissionObservation } from "@/lib/store-reviews/submissions/collector";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { DISCORD_RELEASE_OPS } from "@/lib/notifications/destinations";
import { decodePlayState, PLAY_STATE_PREFIX, PLAY_UNAVAILABLE } from "@/lib/google-play/release-state";
import { normalizeSubmissionState } from "@/lib/store-reviews/submissions/normalizer";
import { submissionContentHash } from "@/lib/store-reviews/submissions/store-agnostic-dedupe";

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
  card: (previousState: string | null, firstPublishedObservedAt?: Date | null) => Prisma.InputJsonObject;
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
  if (input.store === "GOOGLE_PLAY") return persistPlaySubmission(input);
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

// Play의 기준 상태는 원본 payload가 만료돼도 남는 관측 행이다.
// sync 행의 UPDATE 잠금을 먼저 잡고 READ COMMITTED로 뒤따른 관측을 읽는다.
export async function persistPlaySubmission(
  input: SubmissionWrite,
  db: Pick<typeof prisma, "$transaction"> = prisma,
): Promise<"baseline" | "duplicate" | "transition" | "no-change"> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        await tx.storeReviewSubmissionSync.upsert({
          where: { appId_store: { appId: input.appId, store: "GOOGLE_PLAY" } },
          create: { appId: input.appId, store: "GOOGLE_PLAY" },
          update: { updatedAt: new Date() },
        });
        const scope = { appId: input.appId, store: "GOOGLE_PLAY" as const, externalVersionId: input.externalVersionId, trackName: input.trackName };
        const latest = await tx.storeReviewSubmissionObservation.findFirst({
          where: scope, orderBy: [{ lastObservedAt: "desc" }, { createdAt: "desc" }],
        });
        if (latest && input.sourceEventAt <= latest.lastObservedAt) return "duplicate";
        const previous = await tx.storeReviewSubmissionObservation.findFirst({
          where: { ...scope, state: { startsWith: PLAY_STATE_PREFIX, not: PLAY_UNAVAILABLE } },
          orderBy: [{ sourceEventAt: "desc" }, { createdAt: "desc" }],
        });
        const valid = decodePlayState(input.state);
        const state = valid ? input.state : PLAY_UNAVAILABLE;
        const kind = !valid ? "no-change" : !previous ? "baseline" : previous.state === state ? "no-change" : "transition";
        const unchanged = valid && previous?.state === state ? previous : latest?.state === state ? latest : null;
        if (unchanged) {
          await tx.storeReviewSubmissionObservation.update({
            where: { id: unchanged.id }, data: { lastObservedAt: input.sourceEventAt },
          });
          return "no-change";
        }
        const contentHash = submissionContentHash({ store: "GOOGLE_PLAY", externalEventId: input.externalVersionId, state, trackName: input.trackName });
        const firstPublished = await tx.storeReviewSubmissionObservation.findFirst({
          where: { ...scope, state: { startsWith: `${PLAY_STATE_PREFIX}PUBLISHED:` } },
          orderBy: { sourceEventAt: "asc" }, select: { sourceEventAt: true },
        });
        await tx.storeReviewSubmissionObservation.create({
          data: {
            ...scope, externalEventId: input.externalEventId, state,
            stateLabel: normalizeSubmissionState({ store: "GOOGLE_PLAY", state, trackName: input.trackName }).stateLabel,
            previousState: previous?.state ?? null, rawPayload: input.rawPayload,
            contentHash, notifiedHash: kind === "transition" ? contentHash : previous?.notifiedHash ?? null,
            sourceEventAt: input.sourceEventAt, firstObservedAt: input.sourceEventAt, lastObservedAt: input.sourceEventAt,
            expiresAt: new Date(input.sourceEventAt.getTime() + 7 * 24 * 60 * 60_000),
          },
        });
        if (kind === "transition") await enqueueNotification({
          dedupeKey: `store-submission:GOOGLE_PLAY:${input.externalEventId}`,
          kind: NotificationKind.STORE_REVIEW,
          payload: input.card(previous?.state ?? null, firstPublished?.sourceEventAt ?? (valid?.lifecycle === "PUBLISHED" ? input.sourceEventAt : null)),
          occurredAt: input.sourceEventAt,
          destinations: [{ provider: "DISCORD", key: DISCORD_RELEASE_OPS }],
        }, tx);
        return kind;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      // 최초 sync 행 생성 경합 또는 DB deadlock만 전체 트랜잭션을 재시도한다.
      if (attempt < 2 && error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) continue;
      throw error;
    }
  }
}
