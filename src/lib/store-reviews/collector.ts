import type { AppStatus, Prisma, StoreReviewStore } from "@prisma/client";
import {
  beginCollection,
  completeCollection,
  collectionErrorCode,
} from "@/lib/insights/collection";
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
  validateReviewOptions,
  type StoreReviewCollectOptions,
} from "@/lib/store-reviews/options";
import {
  classifyReviewChange,
  reviewContentHash,
  reviewNotificationDedupeKey,
  reviewRatingColor,
  storeReviewDiscordText,
} from "@/lib/store-reviews/shape";
import type {
  ReviewObservationState,
  StoreReview,
} from "@/lib/store-reviews/types";

export interface ReviewAppTarget {
  id: string;
  slug: string;
  status: AppStatus;
  displayName: string;
  playPackage: string | null;
  iosBundle: string | null;
  marketTargets: Prisma.JsonValue;
}

export interface ReviewRepository {
  notificationExists(dedupeKey: string): Promise<boolean>;
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
  beginCollection?(appId: string, store: StoreReviewStore): Promise<string>;
  completeCollection?(
    id: string,
    count: number | null,
    error?: unknown,
  ): Promise<void>;
  markSuccessful(
    appId: string,
    store: StoreReviewStore,
    at: Date,
  ): Promise<void>;
}

const prismaReviewRepository: ReviewRepository = {
  async notificationExists(dedupeKey) {
    return Boolean(
      await prisma.notificationEvent.findUnique({
        where: { dedupeKey },
        select: { id: true },
      }),
    );
  },
  async beginCollection(appId, store) {
    return (await beginCollection(`reviews:${store}`, appId, appId)).id;
  },
  async completeCollection(id, count, error) {
    const code = error ? collectionErrorCode(error) : undefined;
    await completeCollection(id, {
      status:
        code === "SOURCE_PERMISSION_REQUIRED"
          ? "needs_input"
          : code
            ? "failed"
            : count
              ? "observed"
              : "empty",
      dataThrough: error ? undefined : new Date(),
      coverage: { observations: count },
      errorCode: code,
    });
  },
  async initialized(appId, store) {
    return Boolean(
      await prisma.storeReviewSync.findUnique({
        where: { appId_store: { appId, store } },
        select: { id: true },
      }),
    );
  },
  async findObservation(appId, store, externalReviewId) {
    return prisma.storeReviewObservation.findUnique({
      where: {
        appId_store_externalReviewId: { appId, store, externalReviewId },
      },
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
  storeCoverage: Record<
    StoreReviewStore,
    { targets: number; succeeded: number }
  >;
  fetched: number;
  baselined: number;
  enqueued: number;
  unchanged: number;
  errors: Array<{ app: string; store: StoreReviewStore; error: string }>;
}

function marketTargets(value: Prisma.JsonValue): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.toLowerCase())
      : [],
  );
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "알 수 없는 오류").slice(
    0,
    300,
  );
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
  notifyReviewIds: ReadonlySet<string>;
}): Promise<void> {
  const initialized = await input.repository.initialized(
    input.app.id,
    input.store,
  );
  for (const review of input.reviews) {
    if (input.notifyReviewIds.size && !input.notifyReviewIds.has(review.externalReviewId)) {
      continue;
    }
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
    const dedupeKey = reviewNotificationDedupeKey({ appId: input.app.id, review, contentHash });
    const recovering = input.notifyReviewIds.has(review.externalReviewId);
    const pendingNotification = existing?.notifiedHash === null;
    const alreadyQueued = (recovering || pendingNotification) &&
      await input.repository.notificationExists(dedupeKey);
    const change = alreadyQueued
      ? "unchanged"
      : recovering
        ? (existing?.notifiedHash && existing.notifiedHash !== contentHash ? "updated" : "new")
        : classifyReviewChange({
            initialized: initialized || pendingNotification,
            existing,
            contentHash,
          });
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
      if (alreadyQueued) await input.repository.markNotified(observationId, contentHash);
      input.result.unchanged++;
      continue;
    }
    await input.enqueue({
      dedupeKey,
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
        review: {
          body: [review.title, review.body]
            .filter(Boolean)
            .join(" · ")
            .slice(0, 2000),
          locale:
            review.store === "APP_STORE"
              ? `국가 ${review.locale ?? "제공 안됨"}`
              : `언어 ${review.locale ?? "제공 안됨"} · 국가 제공 안됨`,
          version: review.appVersion ?? "제공 안됨",
        },
        report: { category: "internal", reason: "GROUPED_REVIEW_CONTENT" },
        // 별점이 상자 색으로 먼저 읽히게 한다. 낮은 별점은 대응이 필요한 신호다.
        rating: review.rating,
        change,
        embed: {
          title: `${input.app.displayName} · ${review.store === "GOOGLE_PLAY" ? "Google Play" : "App Store"} 리뷰 ${review.rating}/5`,
          color: reviewRatingColor(review.rating),
          timestamp: (
            review.sourceModifiedAt ??
            review.sourceCreatedAt ??
            observedAt
          ).toISOString(),
        },
      },
      occurredAt:
        change === "updated"
          ? (review.sourceModifiedAt ?? observedAt)
          : (review.sourceCreatedAt ?? review.sourceModifiedAt ?? observedAt),
      destinations: input.destinations,
    });
    await input.repository.markNotified(observationId, contentHash);
    input.result.enqueued++;
  }
  // 일부 ID의 복구는 전체 마켓의 최초 기준선을 대신하지 않는다.
  if (!input.notifyReviewIds.size) {
    await input.repository.markSuccessful(input.app.id, input.store, input.now());
  }
}

export async function collectStoreReviews(
  dependencies: StoreReviewCollectorDependencies = {},
  options: StoreReviewCollectOptions = {},
): Promise<StoreReviewCollectResult> {
  validateReviewOptions(options);
  const notifyReviewIds = new Set(options.notifyReviewIds);
  const destinations = (
    dependencies.destinations ??
    (() => {
      if (!/^\d+$/.test(discordChannelId("user-reviews"))) return [];
      return discordDestinations(["user-reviews"]);
    })
  )();
  if (destinations.length !== 1) {
    throw new Error("Discord 목적지 미설정: user-reviews");
  }
  const listApps =
    dependencies.listApps ??
    (() =>
      prisma.app.findMany({
        where: { status: "ACTIVE" },
        select: {
          id: true,
          slug: true,
          status: true,
          displayName: true,
          playPackage: true,
          iosBundle: true,
          marketTargets: true,
        },
      }));
  const apps = await listApps();
  const targets = apps.flatMap((app) => {
    if (app.status !== "ACTIVE" || (options.appSlug && app.slug !== options.appSlug)) {
      return [];
    }
    const markets = marketTargets(app.marketTargets);
    return [
      ...(markets.has("play") && app.playPackage
        ? [{ app, store: "GOOGLE_PLAY" as const, externalId: app.playPackage }]
        : []),
      ...(markets.has("appstore") && app.iosBundle
        ? [{ app, store: "APP_STORE" as const, externalId: app.iosBundle }]
        : []),
    ].filter((target) => !options.store || target.store === options.store);
  });
  if ((options.appSlug || options.store) && targets.length === 0) {
    throw new Error("지정한 앱과 마켓의 수집 대상 없음");
  }
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
    const repository = dependencies.repository ?? prismaReviewRepository;
    const collectionId = await repository.beginCollection?.(
      target.app.id,
      target.store,
    );
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
      const reviews =
        target.store === "GOOGLE_PLAY"
          ? await googleFetcher!(target.externalId)
          : await appStoreFetcher!(target.externalId);
      result.fetched += reviews.length;
      const returnedIds = new Set(reviews.map((review) => review.externalReviewId));
      if ([...notifyReviewIds].some((id) => !returnedIds.has(id))) {
        throw new Error("공식 API에 요청한 복구 리뷰 ID가 없습니다");
      }
      await processReviews({
        app: target.app,
        store: target.store,
        reviews,
        repository: dependencies.repository ?? prismaReviewRepository,
        destinations,
        enqueue: dependencies.enqueue ?? enqueueNotification,
        now: dependencies.now ?? (() => new Date()),
        result,
        notifyReviewIds,
      });
      if (collectionId) {
        await repository.completeCollection?.(
          collectionId,
          notifyReviewIds.size || reviews.length,
        );
      }
      result.storeCoverage[target.store].succeeded++;
    } catch (error) {
      if (collectionId)
        await repository.completeCollection?.(collectionId, null, error);
      result.errors.push({
        app: target.app.displayName,
        store: target.store,
        error: safeError(error),
      });
    }
  }
  return result;
}
