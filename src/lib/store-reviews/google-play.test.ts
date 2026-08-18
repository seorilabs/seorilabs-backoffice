import assert from "node:assert/strict";
import test from "node:test";
import {
  listGooglePlayReviews,
  parseGooglePlayReviews,
} from "@/lib/store-reviews/google-play";

function page(id: string, nextPageToken?: string) {
  return {
    reviews: [{
      reviewId: id,
      authorName: "저장하면 안 되는 이름",
      comments: [
        { developerComment: { text: "답변" } },
        { userComment: {
          text: `본문 ${id}`,
          starRating: 4,
          reviewerLanguage: "ko",
          lastModified: { seconds: "1787014923", nanos: 120_000_000 },
        } },
      ],
    }],
    ...(nextPageToken ? { tokenPagination: { nextPageToken } } : {}),
  };
}

test("Google Play 응답에서 userComment만 리뷰 형태로 변환한다", () => {
  const parsed = parseGooglePlayReviews(page("review-1", "next-token"));
  assert.equal(parsed.nextPageToken, "next-token");
  assert.deepEqual(parsed.reviews[0], {
    store: "GOOGLE_PLAY",
    externalReviewId: "review-1",
    rating: 4,
    body: "본문 review-1",
    locale: "ko",
    sourceModifiedAt: new Date("2026-08-18T01:02:03.120Z"),
  });
  assert.equal("authorName" in (parsed.reviews[0] as unknown as Record<string, unknown>), false);
});

test("Google Play 리뷰 페이지 토큰과 OAuth bearer를 사용한다", async () => {
  const urls: string[] = [];
  const auth: string[] = [];
  let call = 0;
  const fetcher: typeof fetch = async (input, init) => {
    urls.push(String(input));
    auth.push(new Headers(init?.headers).get("authorization") ?? "");
    call++;
    return Response.json(call === 1 ? page("review-1", "next token") : page("review-2"));
  };
  const reviews = await listGooglePlayReviews("com.seorilabs.test", {
    accessToken: async () => "access-token",
    fetch: fetcher,
  });
  assert.deepEqual(reviews.map((item) => item.externalReviewId), ["review-1", "review-2"]);
  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /applications\/com\.seorilabs\.test\/reviews\?maxResults=100/);
  assert.match(urls[1]!, /token=next\+token/);
  assert.deepEqual(auth, ["Bearer access-token", "Bearer access-token"]);
});
