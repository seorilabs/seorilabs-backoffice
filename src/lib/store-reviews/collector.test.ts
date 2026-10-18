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
  readonly notifications = new Set<string>();

  async notificationExists(dedupeKey: string) {
    return this.notifications.has(dedupeKey);
  }
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
  slug: "test-game",
  status: "ACTIVE" as const,
  displayName: "테스트 게임",
  currentStage: "LIVEOPS" as const,
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

test("개발 단계와 무관하게 선언한 마켓의 리뷰를 수집한다", async () => {
  const fetched: string[] = [];
  const result = await collectStoreReviews({
    repository: new MemoryReviewRepository(),
    listApps: async () => [
      { ...app, id: "planning", currentStage: "PLANNING", iosBundle: null, marketTargets: ["play"] },
      { ...app, id: "qa", currentStage: "QA", iosBundle: null, marketTargets: ["play"] },
      { ...app, id: "release", currentStage: "RELEASE", iosBundle: null, marketTargets: ["play"] },
      { ...app, id: "liveops", currentStage: "LIVEOPS", iosBundle: null, marketTargets: ["play"] },
    ],
    destinations: () => destination,
    fetchGooglePlay: async (packageName) => {
      fetched.push(packageName);
      return [];
    },
    enqueue: async (input) => input.dedupeKey,
  });
  assert.equal(result.targets, 4);
  assert.equal(result.storeCoverage.GOOGLE_PLAY.targets, 4);
  assert.equal(result.storeCoverage.GOOGLE_PLAY.succeeded, 4);
  assert.deepEqual(fetched, Array(4).fill(app.playPackage));
});

test("같은 store의 일부 앱 실패는 성공 범위와 오류를 함께 남긴다", async () => {
  const result = await collectStoreReviews({
    repository: new MemoryReviewRepository(),
    listApps: async () => [
      { ...app, id: "allowed", playPackage: "com.seorilabs.allowed", iosBundle: null, marketTargets: ["play"] },
      { ...app, id: "denied", playPackage: "com.seorilabs.denied", iosBundle: null, marketTargets: ["play"] },
    ],
    destinations: () => destination,
    fetchGooglePlay: async (packageName) => {
      if (packageName.endsWith("denied")) throw new Error("권한 없음");
      return [];
    },
    enqueue: async (input) => input.dedupeKey,
  });
  assert.deepEqual(result.storeCoverage.GOOGLE_PLAY, { targets: 2, succeeded: 1 });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.app, "테스트 게임");
});


test("비활성 앱과 미선언 마켓과 식별자 없는 마켓은 제외한다", async () => {
  const fetched: string[] = [];
  const result = await collectStoreReviews({
    repository: new MemoryReviewRepository(),
    listApps: async () => [
      { ...app, status: "PAUSED" as const },
      { ...app, id: "undeclared", marketTargets: ["web"] },
      { ...app, id: "missing", playPackage: null, iosBundle: null },
      { ...app, id: "allowed", marketTargets: ["play"] },
    ],
    destinations: () => destination,
    fetchGooglePlay: async (id) => { fetched.push(id); return []; },
    fetchAppStore: async () => { throw Error("호출하면 안 됨"); },
  });
  assert.equal(result.targets, 1);
  assert.deepEqual(fetched, [app.playPackage]);
});

test("명시한 앱과 마켓과 리뷰 ID만 기존 기준선에서도 복구하고 재실행은 중복 처리하지 않는다", async () => {
  const repository = new MemoryReviewRepository();
  const events: string[] = [];
  const other = { ...google, externalReviewId: "g-other" };
  const deps = {
    repository,
    listApps: async () => [app, { ...app, id: "other", slug: "other" }],
    destinations: () => destination,
    fetchGooglePlay: async () => [google, other],
    fetchAppStore: async () => [apple],
    enqueue: async (input: { dedupeKey: string }) => {
      repository.notifications.add(input.dedupeKey);
      events.push(input.dedupeKey);
      return input.dedupeKey;
    },
  };
  await collectStoreReviews(deps);
  const options = { appSlug: app.slug, store: "GOOGLE_PLAY" as const, notifyReviewIds: [google.externalReviewId] };
  const restored = await collectStoreReviews(deps, options);
  assert.equal(restored.targets, 1);
  assert.equal(restored.enqueued, 1);
  assert.equal(restored.unchanged, 0);
  assert.equal(events.length, 1);
  const repeated = await collectStoreReviews(deps, options);
  assert.equal(repeated.enqueued, 0);
  assert.equal(events.length, 1);
});

test("첫 복구의 enqueue 실패 뒤 일반 실행과 복구 재실행은 누락 리뷰를 재시도한다", async () => {
  const repository = new MemoryReviewRepository();
  const deps = {
    repository, listApps: async () => [app], destinations: () => destination,
    fetchGooglePlay: async () => [google], fetchAppStore: async () => [],
    enqueue: async () => { throw Error("enqueue 실패"); },
  };
  const options = { appSlug: app.slug, store: "GOOGLE_PLAY" as const, notifyReviewIds: [google.externalReviewId] };
  const failed = await collectStoreReviews(deps, options);
  assert.equal(failed.errors.length, 1);
  assert.equal(await repository.initialized(app.id, "GOOGLE_PLAY"), false);
  const events: string[] = [];
  const retried = await collectStoreReviews({ ...deps, enqueue: async (input) => {
    events.push(input.dedupeKey); repository.notifications.add(input.dedupeKey); return input.dedupeKey;
  } });
  assert.equal(retried.enqueued, 1);
  assert.equal(events.length, 1);
  assert.equal((await collectStoreReviews({ ...deps, enqueue: async () => { throw Error("중복"); } }, options)).enqueued, 0);
});

test("범위 없는 복구와 대상 없는 지정 실행은 API를 부르기 전에 거부한다", async () => {
  const deps = { repository: new MemoryReviewRepository(), listApps: async () => [app], destinations: () => destination,
    fetchGooglePlay: async () => { throw Error("호출하면 안 됨"); } };
  await assert.rejects(collectStoreReviews(deps, { notifyReviewIds: ["g-1"] }), /앱과 마켓/);
  await assert.rejects(collectStoreReviews(deps, { appSlug: "missing" }), /수집 대상 없음/);
});

test("공식 API에 없는 복구 ID는 관측이나 기준선을 남기지 않는다", async () => {
  const repository = new MemoryReviewRepository();
  const result = await collectStoreReviews({ repository, listApps: async () => [app],
    destinations: () => destination, fetchGooglePlay: async () => [google],
    enqueue: async () => { throw Error("호출하면 안 됨"); },
  }, { appSlug: app.slug, store: "GOOGLE_PLAY", notifyReviewIds: ["missing"] });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!.error, /복구 리뷰 ID/);
  assert.equal(repository.observations.size, 0);
  assert.equal(repository.sync.size, 0);
});


test("첫 복구는 지정하지 않은 과거 리뷰의 기준선을 앞당기지 않는다", async () => {
  const repository = new MemoryReviewRepository();
  const events: string[] = [];
  const deps = {
    repository, listApps: async () => [app], destinations: () => destination,
    fetchGooglePlay: async () => [google, { ...google, externalReviewId: "old" }],
    fetchAppStore: async () => [],
    enqueue: async (input: { dedupeKey: string }) => {
      events.push(input.dedupeKey); repository.notifications.add(input.dedupeKey); return input.dedupeKey;
    },
  };
  const restored = await collectStoreReviews(deps, {
    appSlug: app.slug, store: "GOOGLE_PLAY", notifyReviewIds: [google.externalReviewId],
  });
  assert.equal(restored.enqueued, 1);
  assert.equal(repository.observations.size, 1);
  assert.equal(await repository.initialized(app.id, "GOOGLE_PLAY"), false);
  const normal = await collectStoreReviews(deps);
  assert.equal(normal.baselined, 2);
  assert.equal(normal.enqueued, 0);
  assert.equal(events.length, 1);
  assert.equal(await repository.initialized(app.id, "GOOGLE_PLAY"), true);
});


test("enqueue 뒤 markNotified가 실패해도 일반 재시도가 기존 알림 payload를 다시 쓰지 않는다", async () => {
  const repository = new MemoryReviewRepository();
  const original = repository.markNotified.bind(repository);
  repository.markNotified = async () => { throw Error("mark 실패"); };
  const events: string[] = [];
  const deps = { repository, listApps: async () => [app], destinations: () => destination,
    fetchGooglePlay: async () => [google], fetchAppStore: async () => [],
    enqueue: async (input: { dedupeKey: string }) => {
      events.push(input.dedupeKey); repository.notifications.add(input.dedupeKey); return input.dedupeKey;
    },
  };
  await collectStoreReviews(deps, { appSlug: app.slug, store: "GOOGLE_PLAY", notifyReviewIds: [google.externalReviewId] });
  repository.markNotified = original;
  const retried = await collectStoreReviews(deps);
  assert.equal(retried.unchanged, 1);
  assert.equal(retried.enqueued, 0);
  assert.equal(events.length, 1);
});

test("기준선 뒤 내용이 바뀐 리뷰를 복구하면 수정 리뷰로 분류한다", async () => {
  const repository = new MemoryReviewRepository();
  const deps = { repository, listApps: async () => [app], destinations: () => destination,
    fetchGooglePlay: async () => [google], fetchAppStore: async () => [],
  };
  await collectStoreReviews(deps);
  const changes: unknown[] = [];
  await collectStoreReviews({ ...deps, fetchGooglePlay: async () => [{ ...google, rating: 5 }],
    enqueue: async (input) => { changes.push(input.payload.change); return input.dedupeKey; },
  }, { appSlug: app.slug, store: "GOOGLE_PLAY", notifyReviewIds: [google.externalReviewId] });
  assert.deepEqual(changes, ["updated"]);
});
