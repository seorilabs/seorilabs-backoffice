import { createHash } from "node:crypto";

import type { StoreReviewStore } from "@prisma/client";

export interface SubmissionContentHashInput {
  store: StoreReviewStore;
  externalEventId: string;
  state: string;
  actor?: string | null;
  trackName?: string | null;
}

export function submissionContentHash(
  input: SubmissionContentHashInput,
): string {
  const canonical = JSON.stringify({
    store: input.store,
    state: input.state,
    actor: input.actor ?? null,
    track: input.trackName ?? null,
    event: input.externalEventId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export type SubmissionDedupeDecision =
  | { kind: "baseline"; contentHash: string }
  | { kind: "duplicate"; contentHash: string }
  | { kind: "transition"; contentHash: string; previousState: string }
  | { kind: "no-change"; contentHash: string };

export interface SubmissionDedupeInput {
  store: StoreReviewStore;
  externalEventId: string;
  state: string;
  previousState: string | null;
  lastNotifiedHash: string | null;
}

export function decideSubmissionDedupe(
  input: SubmissionDedupeInput,
): SubmissionDedupeDecision {
  const contentHash = submissionContentHash({
    store: input.store,
    externalEventId: input.externalEventId,
    state: input.state,
  });

  if (input.previousState === null) {
    return { kind: "baseline", contentHash };
  }
  if (input.lastNotifiedHash && input.lastNotifiedHash === contentHash) {
    return { kind: "duplicate", contentHash };
  }
  if (input.previousState !== input.state) {
    return {
      kind: "transition",
      contentHash,
      previousState: input.previousState,
    };
  }
  return { kind: "no-change", contentHash };
}
