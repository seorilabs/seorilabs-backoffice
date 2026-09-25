import assert from "node:assert/strict";
import test from "node:test";

import {
  decideSubmissionDedupe,
  submissionContentHash,
} from "@/lib/store-reviews/submissions/store-agnostic-dedupe";

test("previousState 가 null 이면 baseline 으로 결정된다", () => {
  const result = decideSubmissionDedupe({
    store: "APP_STORE",
    externalEventId: "EVT-1",
    state: "IN_REVIEW",
    previousState: null,
    lastNotifiedHash: null,
  });
  assert.equal(result.kind, "baseline");
  assert.equal(typeof result.contentHash, "string");
  assert.equal(result.contentHash.length, 64);
});

test("previousState 가 같으면 no-change 로 결정되고 알림이 없다", () => {
  const result = decideSubmissionDedupe({
    store: "APP_STORE",
    externalEventId: "EVT-1",
    state: "IN_REVIEW",
    previousState: "IN_REVIEW",
    lastNotifiedHash: null,
  });
  assert.equal(result.kind, "no-change");
});

test("previousState 와 state 가 다르면 transition 으로 결정된다", () => {
  const result = decideSubmissionDedupe({
    store: "APP_STORE",
    externalEventId: "EVT-1",
    state: "REJECTED",
    previousState: "IN_REVIEW",
    lastNotifiedHash: "old-hash",
  });
  assert.equal(result.kind, "transition");
  if (result.kind !== "transition") return;
  assert.equal(result.previousState, "IN_REVIEW");
  assert.notEqual(result.contentHash, "old-hash");
});

test("lastNotifiedHash 가 contentHash 와 일치하면 duplicate 로 결정된다", () => {
  const content = submissionContentHash({
    store: "APP_STORE",
    externalEventId: "EVT-1",
    state: "REJECTED",
  });
  const result = decideSubmissionDedupe({
    store: "APP_STORE",
    externalEventId: "EVT-1",
    state: "REJECTED",
    previousState: "IN_REVIEW",
    lastNotifiedHash: content,
  });
  assert.equal(result.kind, "duplicate");
  assert.equal(result.contentHash, content);
});

test("contentHash 가 store/state/eventId 가 다르면 달라진다", () => {
  const a = submissionContentHash({
    store: "APP_STORE",
    externalEventId: "EVT-1",
    state: "REJECTED",
  });
  const b = submissionContentHash({
    store: "APP_STORE",
    externalEventId: "EVT-2",
    state: "REJECTED",
  });
  const c = submissionContentHash({
    store: "GOOGLE_PLAY",
    externalEventId: "EVT-1",
    state: "halted",
  });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});
