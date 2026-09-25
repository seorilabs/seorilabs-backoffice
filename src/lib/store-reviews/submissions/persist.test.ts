import assert from "node:assert/strict";
import test from "node:test";
import { shouldNotifySubmission } from "@/lib/store-reviews/submissions/persist";

const at = new Date("2026-09-25T06:00:00Z");

test("첫 Play 폴링은 기준선, 완료 뒤 처음 나타난 릴리스는 알림", () => {
  assert.equal(shouldNotifySubmission({
    decision: "baseline", notifyOnFirstObservation: false,
    previousObservedAt: null, sourceEventAt: at,
  }), false);
  assert.equal(shouldNotifySubmission({
    decision: "baseline", notifyOnFirstObservation: true,
    previousObservedAt: null, sourceEventAt: at,
  }), true);
});

test("Apple 첫 상태 변경은 알리고 오래된 역순 이벤트는 보내지 않는다", () => {
  assert.equal(shouldNotifySubmission({
    decision: "transition", notifyOnFirstObservation: true,
    previousObservedAt: null, sourceEventAt: at,
  }), true);
  assert.equal(shouldNotifySubmission({
    decision: "transition", notifyOnFirstObservation: true,
    previousObservedAt: at, sourceEventAt: new Date(at.getTime() - 1000),
  }), false);
});
