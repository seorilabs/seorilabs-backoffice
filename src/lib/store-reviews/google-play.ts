import { GoogleAuth, type JWTInput } from "google-auth-library";
import { env } from "@/lib/env";
import { normalizeReviewText } from "@/lib/store-reviews/shape";
import type { StoreReview } from "@/lib/store-reviews/types";

const REVIEWS_URL = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const REVIEW_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

type FetchLike = typeof fetch;

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function googleTimestamp(value: unknown): Date | undefined {
  const item = record(value);
  const seconds = Number(item?.seconds);
  const nanos = Number(item?.nanos ?? 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return undefined;
  const date = new Date(seconds * 1_000 + Math.floor(nanos / 1_000_000));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function parseGooglePlayReviews(value: unknown): {
  reviews: StoreReview[];
  nextPageToken?: string;
} {
  const page = record(value);
  const rawReviews = Array.isArray(page?.reviews) ? page.reviews : [];
  const reviews: StoreReview[] = [];
  for (const rawReview of rawReviews) {
    const item = record(rawReview);
    const reviewId = typeof item?.reviewId === "string" ? item.reviewId.trim() : "";
    const comments = Array.isArray(item?.comments) ? item.comments : [];
    let userComment: Record<string, unknown> | null = null;
    for (const comment of comments) {
      const candidate = record(record(comment)?.userComment);
      if (candidate) userComment = candidate;
    }
    const rating = Number(userComment?.starRating);
    if (!reviewId || !Number.isInteger(rating) || rating < 1 || rating > 5 || !userComment) {
      continue;
    }
    const modifiedAt = googleTimestamp(userComment.lastModified);
    reviews.push({
      store: "GOOGLE_PLAY",
      externalReviewId: reviewId,
      rating,
      body: normalizeReviewText(userComment.text),
      ...(typeof userComment.reviewerLanguage === "string" && userComment.reviewerLanguage.trim()
        ? { locale: userComment.reviewerLanguage.trim() }
        : {}),
      ...(modifiedAt ? { sourceModifiedAt: modifiedAt } : {}),
    });
  }
  const token = record(page?.tokenPagination)?.nextPageToken;
  return {
    reviews,
    ...(typeof token === "string" && token ? { nextPageToken: token } : {}),
  };
}

async function googleApiError(response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  let detail = body;
  try {
    const parsed = record(JSON.parse(body));
    const error = record(parsed?.error);
    if (typeof error?.message === "string") detail = error.message;
  } catch {
    // JSON이 아니면 제한된 원문을 사용한다.
  }
  return new Error(`Google Play reviews API ${response.status}: ${detail.slice(0, 300)}`);
}

export async function listGooglePlayReviews(
  packageName: string,
  dependencies: {
    accessToken: () => Promise<string>;
    fetch?: FetchLike;
    maxPages?: number;
  },
): Promise<StoreReview[]> {
  const accessToken = await dependencies.accessToken();
  if (!accessToken) throw new Error("Google Play access token 발급 실패");
  const fetcher = dependencies.fetch ?? fetch;
  const maxPages = Math.max(1, Math.min(dependencies.maxPages ?? MAX_PAGES, MAX_PAGES));
  const byId = new Map<string, StoreReview>();
  let pageToken = "";
  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({ maxResults: String(PAGE_SIZE) });
    if (pageToken) query.set("token", pageToken);
    const response = await fetcher(
      `${REVIEWS_URL}/${encodeURIComponent(packageName)}/reviews?${query.toString()}`,
      {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw await googleApiError(response);
    const parsed = parseGooglePlayReviews(await response.json());
    for (const review of parsed.reviews) byId.set(review.externalReviewId, review);
    pageToken = parsed.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return [...byId.values()];
}

function parseCredentials(json: string): JWTInput {
  if (!json) throw new Error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON 미설정");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON 형식 오류");
  }
  const parsed = record(value);
  if (!parsed || typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
    throw new Error("Google Play service account 필수 필드 누락");
  }
  return parsed as JWTInput;
}

export function createGooglePlayReviewFetcher(
  credentialsJson = env.googlePlayServiceAccountJson(),
): (packageName: string) => Promise<StoreReview[]> {
  const auth = new GoogleAuth({
    credentials: parseCredentials(credentialsJson),
    scopes: [REVIEW_SCOPE],
  });
  return (packageName) => listGooglePlayReviews(packageName, {
    accessToken: async () => (await auth.getAccessToken()) ?? "",
  });
}
