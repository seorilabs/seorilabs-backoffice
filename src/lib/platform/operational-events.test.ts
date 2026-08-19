import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  operationalEventMessage,
  parseOperationalEvent,
  verifyOperationalEventSignature,
} from "@/lib/platform/operational-events";

const sample = {
  version: 1 as const,
  eventId: "evt_identity_123456",
  occurredAt: "2026-08-17T10:00:00.000Z",
  type: "identity.created" as const,
  appId: "happy-farm",
  outcome: "ok",
  attributes: { authType: "firebase", anonymous: false },
};

test("허용된 확정 이벤트만 파싱하고 사용자 식별자 키를 거부한다", () => {
  assert.deepEqual(parseOperationalEvent(sample), sample);
  assert.equal(
    parseOperationalEvent({ ...sample, attributes: { platformUserId: "pu_secret" } }),
    null,
  );
});

test("서명과 5분 replay window를 검증한다", () => {
  const rawBody = JSON.stringify(sample);
  const timestamp = "1786960800";
  const secret = "test-secret";
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  assert.equal(
    verifyOperationalEventSignature({
      rawBody,
      timestampHeader: timestamp,
      signatureHeader: `v1=${signature}`,
      secret,
      now: new Date("2026-08-17T10:00:00Z"),
    }),
    true,
  );
  assert.equal(
    verifyOperationalEventSignature({
      rawBody,
      timestampHeader: timestamp,
      signatureHeader: `v1=${signature}`,
      secret,
      now: new Date("2026-08-17T10:06:00Z"),
    }),
    false,
  );
});

test("이벤트 메시지에 사용자 ID 없이 운영 정보만 표시한다", () => {
  const message = operationalEventMessage(sample, "해피팜");
  assert.match(message, /신규 Platform 사용자/);
  assert.match(message, /해피팜/);
  assert.doesNotMatch(message, /eventId|platformUserId/);
});

test("AppsInToss 로그인 referrer는 받고 사용자 식별자는 계속 거부한다", () => {
  const withReferrer = { ...sample, attributes: { authType: "apps_in_toss", referrer: "SANDBOX" } };
  assert.deepEqual(parseOperationalEvent(withReferrer), withReferrer);
  assert.equal(
    parseOperationalEvent({ ...sample, attributes: { authType: "apps_in_toss", supportCode: "LT-1234" } }),
    null,
  );
  assert.match(operationalEventMessage(withReferrer, "도마뱀 테라리움"), /유입: SANDBOX/);
});
