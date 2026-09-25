import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchSubmissionObservation,
} from "@/lib/store-reviews/submissions/collector";

test("baseline 입력은 notify=false 이고 normalized/state 가 채워진다", () => {
  const result = dispatchSubmissionObservation({
    store: "APP_STORE",
    externalEventId: "EVT-1",
    state: "IN_REVIEW",
    previousState: null,
    lastNotifiedHash: null,
  });
  assert.equal(result.notify, false);
  assert.equal(result.decision.kind, "baseline");
  assert.equal(result.normalized.stateLabel, "심사 중");
  assert.equal(result.normalized.storeColorHex, 0x0a84ff);
});

test("state 전이면 notify 가 이전 state 를 담아 반환된다", () => {
  const result = dispatchSubmissionObservation({
    store: "GOOGLE_PLAY",
    externalEventId: "track-1",
    state: "completed",
    previousState: "inProgress",
    lastNotifiedHash: null,
  });
  assert.notEqual(result.notify, false);
  if (result.notify === false) return;
  assert.equal(result.notify.previousState, "inProgress");
  assert.equal(result.normalized.stateLabel, "출시 완료");
  assert.equal(result.normalized.emoji, "✓");
  assert.equal(result.decision.kind, "transition");
});

test("중복 contentHash 면 notify=false 이고 duplicate 결정이다", () => {
  const first = dispatchSubmissionObservation({
    store: "APP_STORE",
    externalEventId: "EVT-2",
    state: "REJECTED",
    previousState: "IN_REVIEW",
    lastNotifiedHash: null,
  });
  // 첫 dispatch 의 hash 를 lastNotifiedHash 로 넣어 다시 dispatch
  const second = dispatchSubmissionObservation({
    store: "APP_STORE",
    externalEventId: "EVT-2",
    state: "REJECTED",
    previousState: "IN_REVIEW",
    lastNotifiedHash: first.decision.contentHash,
  });
  assert.equal(second.notify, false);
  assert.equal(second.decision.kind, "duplicate");
});

test("state 가 동일하고 hash 도 다르면 no-change", () => {
  const result = dispatchSubmissionObservation({
    store: "APP_STORE",
    externalEventId: "EVT-3",
    state: "IN_REVIEW",
    previousState: "IN_REVIEW",
    lastNotifiedHash: null,
  });
  assert.equal(result.notify, false);
  assert.equal(result.decision.kind, "no-change");
});
