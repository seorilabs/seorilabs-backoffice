import {
  ASC_BASE,
  asc,
  asArray,
  type JsonApiDoc,
} from "@/lib/app-store/asc-client";
import { normalizeReviewText } from "@/lib/store-reviews/shape";
import type { StoreReview } from "@/lib/store-reviews/types";

const MAX_PAGES = 5;

type AscRequest = (path: string, init?: RequestInit) => Promise<JsonApiDoc>;

function date(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function nextPath(next: string | undefined): string {
  if (!next) return "";
  return next.startsWith(ASC_BASE) ? next.slice(ASC_BASE.length) : next;
}

export function parseAppStoreReviews(doc: JsonApiDoc): StoreReview[] {
  const reviews: StoreReview[] = [];
  for (const item of asArray(doc.data)) {
    const attributes = item.attributes ?? {};
    const rating = Number(attributes.rating);
    if (!item.id || !Number.isInteger(rating) || rating < 1 || rating > 5) continue;
    const createdAt = date(attributes.createdDate);
    const title = normalizeReviewText(attributes.title);
    const locale = normalizeReviewText(attributes.territory);
    reviews.push({
      store: "APP_STORE",
      externalReviewId: item.id,
      rating,
      body: normalizeReviewText(attributes.body),
      ...(title ? { title } : {}),
      ...(locale ? { locale } : {}),
      ...(createdAt ? { sourceCreatedAt: createdAt } : {}),
    });
  }
  return reviews;
}

export async function listAppStoreReviews(
  bundleId: string,
  request: AscRequest = asc,
  maxPages = MAX_PAGES,
): Promise<StoreReview[]> {
  const appDoc = await request(
    `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`,
  );
  const app = asArray(appDoc.data)[0];
  if (!app) throw new Error(`App Store Connect 앱 없음(bundleId=${bundleId})`);

  const byId = new Map<string, StoreReview>();
  let path = `/v1/apps/${encodeURIComponent(app.id)}/customerReviews?sort=-createdDate&limit=200`;
  const pages = Math.max(1, Math.min(maxPages, MAX_PAGES));
  for (let page = 0; page < pages && path; page++) {
    const doc = await request(path);
    for (const review of parseAppStoreReviews(doc)) {
      byId.set(review.externalReviewId, review);
    }
    path = nextPath(doc.links?.next);
  }
  return [...byId.values()];
}
