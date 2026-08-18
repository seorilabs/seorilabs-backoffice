import assert from "node:assert/strict";
import test from "node:test";
import type { JsonApiDoc } from "@/lib/app-store/asc-client";
import { listAppStoreReviews } from "@/lib/store-reviews/app-store";

function review(id: string): JsonApiDoc {
  return {
    data: [{
      type: "customerReviews",
      id,
      attributes: {
        rating: 5,
        title: `제목 ${id}`,
        body: `본문 ${id}`,
        reviewerNickname: "저장하면 안 되는 이름",
        createdDate: "2026-08-18T05:00:00Z",
        territory: "KOR",
      },
    }],
  };
}

test("bundle ID로 App Store app을 찾고 customerReviews를 페이지 순회한다", async () => {
  const paths: string[] = [];
  const request = async (path: string): Promise<JsonApiDoc> => {
    paths.push(path);
    if (paths.length === 1) return { data: { type: "apps", id: "asc-app-1" } };
    if (paths.length === 2) {
      return {
        ...review("review-1"),
        links: { next: "https://api.appstoreconnect.apple.com/v1/apps/asc-app-1/customerReviews?cursor=next" },
      };
    }
    return review("review-2");
  };
  const reviews = await listAppStoreReviews("com.seorilabs.test", request);
  assert.match(paths[0]!, /filter\[bundleId\]=com\.seorilabs\.test/);
  assert.equal(paths[1], "/v1/apps/asc-app-1/customerReviews?sort=-createdDate&limit=200");
  assert.equal(paths[2], "/v1/apps/asc-app-1/customerReviews?cursor=next");
  assert.deepEqual(reviews.map((item) => item.externalReviewId), ["review-1", "review-2"]);
  assert.deepEqual(reviews[0], {
    store: "APP_STORE",
    externalReviewId: "review-1",
    rating: 5,
    title: "제목 review-1",
    body: "본문 review-1",
    locale: "KOR",
    sourceCreatedAt: new Date("2026-08-18T05:00:00Z"),
  });
  assert.equal("reviewerNickname" in (reviews[0] as unknown as Record<string, unknown>), false);
});
