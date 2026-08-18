import type {
  Lifecycle,
  Prisma,
  StoreReviewStore,
} from "@prisma/client";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import {
  discordChannelId,
  discordDestinations,
  type NotificationDestination,
} from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { listAppStoreReviews } from "@/lib/store-reviews/app-store";
import { createGooglePlayReviewFetcher } from "@/lib/store-reviews/google-play";
import {
  classifyReviewChange,
  reviewContentHash,
  reviewNotificationDedupeKey,
  storeReviewDiscordText,
} from "@/lib/store-reviews/shape";
import type {
  ReviewObservationState,
  StoreReview,
} from "@/lib/store-reviews/types";

export interface ReviewAppTarget {
  id: string;
  displayName: string;
  currentStage: Lifecycle;
  playPackage: string | null;
  iosBundle: string | null;
  marketTargets: Prisma.JsonValue;
}

export interface ReviewRepository {
  initialized(appId: string, store: StoreReviewStore): Promise<boolean>;
  findObservation(
    appId: string,
    store: StoreReviewStore,
    externalReviewId: string,
  ): Promise<ReviewObservationState | null>;
  saveObservation(input: {
    appId: string;
    review: StoreReview;
    contentHash: string;
    baseline: boolean;
    observedAt: Date;
  }): Promise<string>;
  markNotified(id: string, contentHash: string): Promise<void>;
  markSuccessful(appId: string, store: StoreReviewStore, at: Date): Promise<void>;
}

const prismaReviewRepository: ReviewRepository = {
  async initialized(appId, store) {
    return Boolean(await prisma.storeReviewSync.findUnique({
      where: { appId_store: { appId, store } },
      select: { id: true },
    }));
  },
  async findObservation(appId, store, externalReviewId) {
    return prisma.storeReviewObservation.findUnique({
      where: { appId_store_externalReviewId: { appId, store, externalReviewId } },
      select: { id: true, rating: true, contentHash: true, notifiedHash: true },
    });
  },
  async saveObservation(input) {
    const review = input.review;
    const row = await prisma.storeReviewObservation.upsert({
      where: {
        appId_store_externalReviewId: {
          appId: input.appId,
          store: review.store,
          externalReviewId: review.externalReviewId,
        },
      },
      create: {
        appId: input.appId,
        store: review.store,
        externalReviewId: review.externalReviewId,
        rating: review.rating,
        contentHash: input.contentHash,
        notifiedHash: input.baseline ? input.contentHash : null,
        sourceCreatedAt: review.sourceCreatedAt,
        sourceModifiedAt: review.sourceModifiedAt,
        firstObservedAt: input.observedAt,
        lastObservedAt: input.observedAt,
      },
      update: {
        rating: review.rating,
        contentHash: input.contentHash,
        ...(input.baseline ? { notifiedHash: input.contentHash } : {}),
        sourceCreatedAt: review.sourceCreatedAt,
        sourceModifiedAt: review.sourceModifiedAt,
        lastObservedAt: input.observedAt,
      },
      select: { id: true },
    });
    return row.id;
  },
  async markNotified(id, contentHash) {
    await prisma.storeReviewObservation.updateMany({
      where: { id, contentHash },
      data: { notifiedHash: contentHash },
    });
  },
  async markSuccessful(appId, store, at) {
    await prisma.storeReviewSync.upsert({
      where: { appId_store: { appId, store } },
      create: { appId, store, initializedAt: at, lastSuccessfulAt: at },
      update: { lastSuccessfulAt: at },
    });
  },
};

type ReviewEnqueue = (input: {
  dedupeKey: string;
  kind: "STORE_REVIEW";
  payload: Prisma.InputJsonObject;
  occurredAt?: Date;
  destinations: NotificationDestination[];
}) => Promise<string>;

export interface StoreReviewCollectorDependencies {
  repository?: ReviewRepository;
  listApps?: () => Promise<ReviewAppTarget[]>;
  destinations?: () => NotificationDestination[];
  fetchGooglePlay?: (packageName: string) => Promise<StoreReview[]>;
  fetchAppStore?: (bundleId: string) => Promise<StoreReview[]>;
  enqueue?: ReviewEnqueue;
  now?: () => Date;
}

export interface StoreReviewCollectResult {
  targets: number;
  storeCoverage: Record<StoreReviewStore, { targets: number; succeeded: number }>;
  fetched: number;
  baselined: number;
  enqueued: number;
  unchanged: number;
  errors: Array<{ app: string; store: StoreReviewStore; error: string }>;
}

const REVIEWABLE_STAGES = new Set<Lifecycle>(["RELEASE", "LIVEOPS"]);

function marketTargets(value: Prisma.JsonValue): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
        .map((item) => item.toLowerCase())
      : [],
  );
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "알 수 없는 오류").slice(0, 300);
}

async function processReviews(input: {
  app: ReviewAppTarget;
  store: StoreReviewStore;
  reviews: StoreReview[];
  repository: ReviewRepository;
  destinations: NotificationDestination[];
  enqueue: ReviewEnqueue;
  now: () => Date;
  result: StoreReviewCollectResult;
}): Promise<void> {
  const initialized = await input.repository.initialized(input.app.id, input.store);
  for (const review of input.reviews) {
    if (review.store !== input.store) {
      throw new Error(`리뷰 store 불일치: expected=${input.store}`);
    }
    const observedAt = input.now();
    const contentHash = reviewContentHash(review);
    const existing = await input.repository.findObservation(
      input.app.id,
      input.store,
      review.externalReviewId,
    );
    const change = classifyReviewChange({ initialized, existing, contentHash });
    const observationId = await input.repository.saveObservation({
      appId: input.app.id,
      review,
      contentHash,
      baseline: change === "baseline",
      observedAt,
    });
    if (change === "baseline") {
      input.result.baselined++;
      continue;
    }
    if (change === "unchanged") {
      input.result.unchanged++;
      continue;
    }
    await input.enqueue({
      dedupeKey: reviewNotificationDedupeKey({
        appId: input.app.id,
        review,
        contentHash,
      }),
      kind: "STORE_REVIEW",
      payload: {
        text: storeReviewDiscordText({
          appDisplayName: input.app.displayName,
          review,
          change,
          ...(existing ? { previousRating: existing.rating } : {}),
          observedAt,
        }),
        appId: input.app.id,
        store: review.store,
        externalReviewId: review.externalReviewId,
      },
      occurredAt: change === "updated"
        ? review.sourceModifiedAt ?? observedAt
        : review.sourceCreatedAt ?? review.sourceModifiedAt ?? observedAt,
      destinations: input.destinations,
    });
    await input.repository.markNotified(observationId, contentHash);
    input.result.enqueued++;
  }
  await input.repository.markSuccessful(input.app.id, input.store, input.now());
}

export async function collectStoreReviews(
  dependencies: StoreReviewCollectorDependencies = {},
): Promise<StoreReviewCollectResult> {
  const destinations = (dependencies.destinations ?? (() => {
    if (!/^\d+$/.test(discordChannelId("user-reviews"))) return [];
    return discordDestinations(["user-reviews"]);
  }))();
  if (destinations.length !== 1) {
    throw new Error("Discord 목적지 미설정: user-reviews");
  }
  const listApps = dependencies.listApps ?? (() => prisma.app.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      displayName: true,
      currentStage: true,
      playPackage: true,
      iosBundle: true,
      marketTargets: true,
    },
  }));
  const apps = await listApps();
  const targets = apps.flatMap((app) => {
    if (!REVIEWABLE_STAGES.has(app.currentStage)) return [];
    const markets = marketTargets(app.marketTargets);
    return [
      ...(markets.has("play") && app.playPackage
        ? [{ app, store: "GOOGLE_PLAY" as const, externalId: app.playPackage }]
        : []),
      ...(markets.has("appstore") && app.iosBundle
        ? [{ app, store: "APP_STORE" as const, externalId: app.iosBundle }]
        : []),
    ];
  });
  const result: StoreReviewCollectResult = {
    targets: targets.length,
    storeCoverage: {
      GOOGLE_PLAY: { targets: 0, succeeded: 0 },
      APP_STORE: { targets: 0, succeeded: 0 },
    },
    fetched: 0,
    baselined: 0,
    enqueued: 0,
    unchanged: 0,
    errors: [],
  };
  for (const target of targets) result.storeCoverage[target.store].targets++;
  if (targets.length === 0) return result;

  let googleFetcher = dependencies.fetchGooglePlay;
  let appStoreFetcher = dependencies.fetchAppStore;
  for (const target of targets) {
    try {
      if (target.store === "GOOGLE_PLAY" && !googleFetcher) {
        googleFetcher = createGooglePlayReviewFetcher();
      }
      if (target.store === "APP_STORE" && !appStoreFetcher) {
        if (!env.appStoreConnectConfigured()) {
          throw new Error("App Store Connect API 자격증명 미설정");
        }
        appStoreFetcher = listAppStoreReviews;
      }
      const reviews = target.store === "GOOGLE_PLAY"
        ? await googleFetcher!(target.externalId)
        : await appStoreFetcher!(target.externalId);
      result.fetched += reviews.length;
      await processReviews({
        app: target.app,
        store: target.store,
        reviews,
        repository: dependencies.repository ?? prismaReviewRepository,
        destinations,
        enqueue: dependencies.enqueue ?? enqueueNotification,
        now: dependencies.now ?? (() => new Date()),
        result,
      });
      result.storeCoverage[target.store].succeeded++;
    } catch (error) {
      result.errors.push({
        app: target.app.displayName,
        store: target.store,
        error: safeError(error),
      });
    }
  }
  return result;
}
