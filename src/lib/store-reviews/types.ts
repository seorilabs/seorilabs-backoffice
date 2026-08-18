import type { StoreReviewStore } from "@prisma/client";

export interface StoreReview {
  store: StoreReviewStore;
  externalReviewId: string;
  rating: number;
  title?: string;
  body: string;
  locale?: string;
  sourceCreatedAt?: Date;
  sourceModifiedAt?: Date;
}

export type ReviewChangeKind = "baseline" | "new" | "updated" | "unchanged";

export interface ReviewObservationState {
  id: string;
  rating: number;
  contentHash: string;
  notifiedHash: string | null;
}
