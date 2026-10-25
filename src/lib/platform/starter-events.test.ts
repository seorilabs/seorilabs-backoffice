import assert from "node:assert/strict";
import test from "node:test";
import { operationalEventFacts, parseOperationalEvent } from "./operational-events";

test("스타터 계정 복구와 우편 이벤트를 받고 개인정보 속성은 거부한다", () => {
  for (const [type, outcome, headline, attrs] of [
    ["identity.recovered", "recovered", "계정 복구", { provider: "google" }],
    ["inbox.issued", "issued", "우편 발송", { messageIdHash: "a".repeat(64), rewardCount: 1 }],
    ["inbox.claimed", "claimed", "우편 수령", { messageIdHash: "a".repeat(64), rewardCount: 1 }],
  ] as const) {
    const value = {
      version: 1, eventId: "starter_event_0123456789", occurredAt: "2026-10-25T08:00:00Z",
      type, outcome, appId: "starter-game",
      attributes: { ...attrs, platformUserId: "pu_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    };
    const parsed = parseOperationalEvent(value);
    assert.ok(parsed, `${type} must be accepted`);
    assert.equal(operationalEventFacts(parsed).headline, headline);
    for (const extra of [{ email: "private@example.com" }, { receiptToken: "private-token" }, { title: "private mail" }]) {
      assert.equal(parseOperationalEvent({ ...value, attributes: { ...value.attributes, ...extra } }), null);
    }
  }
});
