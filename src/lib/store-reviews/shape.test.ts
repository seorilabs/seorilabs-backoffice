import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyReviewChange,
  reviewContentHash,
  reviewNotificationDedupeKey,
  storeReviewDiscordText,
} from "@/lib/store-reviews/shape";
import type { StoreReview } from "@/lib/store-reviews/types";

const review: StoreReview = {
  store: "GOOGLE_PLAY",
  externalReviewId: "review-1",
  rating: 3,
  body: "재미있어요",
  locale: "ko",
  sourceModifiedAt: new Date("2026-08-18T01:02:03Z"),
};

test("리뷰 fingerprint는 표시 내용만 반영하고 줄바꿈·공백을 정규화한다", () => {
  assert.equal(
    reviewContentHash(review),
    reviewContentHash({ ...review, body: "  재미있어요\r\n" }),
  );
  assert.notEqual(reviewContentHash(review), reviewContentHash({ ...review, rating: 5 }));
});

test("최초 수집은 기준선, 이후 신규·변경·미변경을 notified hash로 판정한다", () => {
  const hash = reviewContentHash(review);
  assert.equal(classifyReviewChange({ initialized: false, existing: null, contentHash: hash }), "baseline");
  assert.equal(classifyReviewChange({ initialized: true, existing: null, contentHash: hash }), "new");
  assert.equal(classifyReviewChange({
    initialized: true,
    existing: { id: "1", rating: 3, contentHash: hash, notifiedHash: null },
    contentHash: hash,
  }), "new");
  assert.equal(classifyReviewChange({
    initialized: true,
    existing: { id: "1", rating: 3, contentHash: hash, notifiedHash: hash },
    contentHash: hash,
  }), "unchanged");
  assert.equal(classifyReviewChange({
    initialized: true,
    existing: { id: "1", rating: 3, contentHash: hash, notifiedHash: "old" },
    contentHash: hash,
  }), "updated");
});

test("수정 시각을 포함한 짧은 dedupe key와 한국어 Discord 본문을 만든다", () => {
  const contentHash = reviewContentHash(review);
  const first = reviewNotificationDedupeKey({ appId: "app-1", review, contentHash });
  const revertedLater = reviewNotificationDedupeKey({
    appId: "app-1",
    review: { ...review, sourceModifiedAt: new Date("2026-08-18T02:02:03Z") },
    contentHash,
  });
  assert.notEqual(first, revertedLater);
  assert.ok(first.length < 191);

  const text = storeReviewDiscordText({
    appDisplayName: "해피 *팜*",
    review: { ...review, rating: 5, title: "좋은 [게임]" },
    change: "updated",
    previousRating: 3,
  });
  assert.match(text, /Google Play 리뷰 수정/);
  assert.match(text, /5\/5 · 이전 3\/5/);
  assert.match(text, /해피 \\\*팜\\\*/);
  assert.match(text, /> 재미있어요/);
});
