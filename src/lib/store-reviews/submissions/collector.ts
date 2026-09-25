import type { StoreReviewStore } from "@prisma/client";

import {
  decideSubmissionDedupe,
  type SubmissionDedupeDecision,
} from "@/lib/store-reviews/submissions/store-agnostic-dedupe";
import {
  normalizeSubmissionState,
  type NormalizedState,
} from "@/lib/store-reviews/submissions/normalizer";

export interface SubmissionDispatchInput {
  store: StoreReviewStore;
  externalEventId: string;
  state: string;
  trackName?: string | null;
  externalVersionId?: string | null;
  previousState: string | null;
  lastNotifiedHash: string | null;
}

export type SubmissionDispatchNotify =
  | false
  | { previousState: string | null };

export interface SubmissionDispatchResult {
  readonly store: StoreReviewStore;
  readonly externalEventId: string;
  readonly state: string;
  readonly normalized: NormalizedState;
  readonly decision: SubmissionDedupeDecision;
  readonly notify: SubmissionDispatchNotify;
}

export function dispatchSubmissionObservation(
  input: SubmissionDispatchInput,
): SubmissionDispatchResult {
  const normalized = normalizeSubmissionState({
    store: input.store,
    state: input.state,
  });
  const decision = decideSubmissionDedupe({
    store: input.store,
    externalEventId: input.externalEventId,
    state: input.state,
    previousState: input.previousState,
    lastNotifiedHash: input.lastNotifiedHash,
  });
  const notify: SubmissionDispatchNotify =
    decision.kind === "transition" ? { previousState: decision.previousState } : false;
  return {
    store: input.store,
    externalEventId: input.externalEventId,
    state: input.state,
    normalized,
    decision,
    notify,
  };
}
