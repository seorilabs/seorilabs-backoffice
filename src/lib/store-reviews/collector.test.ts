import assert from "node:assert/strict";
import test from "node:test";
import type { StoreReviewStore } from "@prisma/client";
import {
  collectStoreReviews,
  type ReviewRepository,
} from "@/lib/store-reviews/collector";
import type {
  ReviewObservationState,
  StoreReview,
} from "@/lib/store-reviews/types";

class MemoryReviewRepository implements ReviewRepository {
  readonly sync = new Set<string>();
  readonly observations = new Map<string, ReviewObservationState>();

  private key(appId: string, store: StoreReviewStore, reviewId = "") {
    return `${appId}:${store}:${reviewId}`;
  }

  async initialized(appId: string, store: StoreReviewStore) {
    return this.sync.has(this.key(appId, store));
  }

  async findObservation(appId: string, store: StoreReviewStore, externalReviewId: string) {
    return this.observations.get(this.key(appId, store, externalReviewId)) ?? null;
  }

  async saveObservation(input: {
    appId: string;
    review: StoreReview;
    contentHash: string;
    baseline: boolean;
  }) {
    const key = this.key(input.appId, input.review.store, input.review.externalReviewId);
    const existing = this.observations.get(key);
    this.observations.set(key, {
      id: key,
      rating: input.review.rating,
      contentHash: input.contentHash,
      notifiedHash: input.baseline ? input.contentHash : existing?.notifiedHash ?? null,
    });
    return key;
  }

  async markNotified(id: string, contentHash: string) {
    const existing = this.observations.get(id)!;
    this.observations.set(id, { ...existing, notifiedHash: contentHash });
  }

  async markSuccessful(appId: string, store: StoreReviewStore) {
    this.sync.add(this.key(appId, store));
  }
}

const app = {
  id: "app-1",
  displayName: "테스트 게임",
  playPackage: "com.seorilabs.test",
  iosBundle: "com.seorilabs.test",
  marketTargets: ["play", "appstore"],
};

const google: StoreReview = {
  store: "GOOGLE_PLAY",
  externalReviewId: "g-1",
  rating: 3,
  body: "괜찮아요",
  sourceModifiedAt: new Date("2026-08-18T00:00:00Z"),
};

const apple: StoreReview = {
  store: "APP_STORE",
  externalReviewId: "a-1",
  rating: 4,
  title: "좋아요",
  body: "재미있어요",
  sourceModifiedAt: new Date("2026-08-18T00:00:00Z"),
};

const destination = [{ provider: "DISCORD" as const, key: "user-reviews" as const }];

test("첫 실행은 기준선만 만들고 다음 신규·변경 리뷰만 enqueue한다", async () => {
  const repository = new MemoryReviewRepository();
  let googleReviews = [google];
  let appleReviews = [apple];
  const events: Array<{ dedupeKey: string; text: unknown }> = [];
  const dependencies = {
    repository,
    listApps: async () => [app],
    destinations: () => destination,
    fetchGooglePlay: async () => googleReviews,
    fetchAppStore: async () => appleReviews,
    enqueue: async (input: { dedupeKey: string; payload: { text?: unknown } }) => {
      events.push({ dedupeKey: input.dedupeKey, text: input.payload.text });
      return input.dedupeKey;
    },
    now: () => new Date("2026-08-18T06:00:00Z"),
  };

  const baseline = await collectStoreReviews(dependencies);
  assert.equal(baseline.baselined, 2);
  assert.equal(baseline.enqueued, 0);
  assert.equal(events.length, 0);

  const unchanged = await collectStoreReviews(dependencies);
  assert.equal(unchanged.unchanged, 2);
  assert.equal(events.length, 0);

  googleReviews = [{
    ...google,
    rating: 5,
    body: "업데이트 후 좋아졌어요",
    sourceModifiedAt: new Date("2026-08-18T07:00:00Z"),
  }];
  appleReviews = [apple, {
    ...apple,
    externalReviewId: "a-2",
    rating: 5,
    body: "새 리뷰",
    sourceModifiedAt: new Date("2026-08-18T07:00:00Z"),
  }];
  const changed = await collectStoreReviews(dependencies);
  assert.equal(changed.enqueued, 2);
  assert.equal(events.length, 2);
  assert.match(String(events[0]!.text), /리뷰 수정/);
  assert.match(String(events[0]!.text), /이전 3\/5/);
  assert.match(String(events[1]!.text), /새 리뷰/);
});

test("enqueue 실패 뒤에도 notifiedHash를 남기지 않아 다음 실행이 같은 신호를 재시도한다", async () => {
  const repository = new MemoryReviewRepository();
  const base = {
    repository,
    listApps: async () => [{ ...app, iosBundle: null, marketTargets: ["play"] }],
    destinations: () => destination,
    fetchGooglePlay: async () => [google],
    now: () => new Date("2026-08-18T06:00:00Z"),
  };
  await collectStoreReviews({ ...base, enqueue: async () => "baseline-unused" });

  const changed = {
    ...google,
    rating: 5,
    sourceModifiedAt: new Date("2026-08-18T07:00:00Z"),
  };
  let failedKey = "";
  const failed = await collectStoreReviews({
    ...base,
    fetchGooglePlay: async () => [changed],
    enqueue: async (input) => {
      failedKey = input.dedupeKey;
      throw new Error("DB unavailable");
    },
  });
  assert.equal(failed.errors.length, 1);

  let retriedKey = "";
  const retried = await collectStoreReviews({
    ...base,
    fetchGooglePlay: async () => [changed],
    enqueue: async (input) => {
      retriedKey = input.dedupeKey;
      return input.dedupeKey;
    },
  });
  assert.equal(retried.enqueued, 1);
  assert.equal(retriedKey, failedKey);
});

test("user-reviews 채널이 없으면 API 호출과 기준선 생성을 시작하지 않는다", async () => {
  let listed = false;
  await assert.rejects(
    collectStoreReviews({
      destinations: () => [],
      listApps: async () => {
        listed = true;
        return [app];
      },
    }),
    /Discord 목적지 미설정: user-reviews/,
  );
  assert.equal(listed, false);
});

test("수집 대상과 다른 store의 리뷰는 기준선으로 저장하지 않는다", async () => {
  const repository = new MemoryReviewRepository();
  const result = await collectStoreReviews({
    repository,
    listApps: async () => [{ ...app, iosBundle: null, marketTargets: ["play"] }],
    destinations: () => destination,
    fetchGooglePlay: async () => [apple],
    enqueue: async (input) => input.dedupeKey,
  });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.error ?? "", /리뷰 store 불일치/);
  assert.equal(await repository.initialized(app.id, "GOOGLE_PLAY"), false);
});
