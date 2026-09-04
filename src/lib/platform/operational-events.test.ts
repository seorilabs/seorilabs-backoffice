import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  isOpsAlert,
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

test("Firebase 로그인 공급자는 받고 계정 생성 경로와 함께 표시한다", () => {
  const withProvider = {
    ...sample,
    attributes: { authType: "firebase_bridge", signInProvider: "google.com", anonymous: false },
  };
  assert.deepEqual(parseOperationalEvent(withProvider), withProvider);
  const message = operationalEventMessage(withProvider, "우리 아기 기록");
  assert.match(message, /인증: firebase_bridge/);
  assert.match(message, /로그인: google\.com/);
});

test("공급자를 모르는 게스트 계정은 로그인 줄을 지어내지 않는다", () => {
  const message = operationalEventMessage(
    { ...sample, attributes: { authType: "firebase_bridge", anonymous: false } },
    "우리 아기 기록",
  );
  assert.match(message, /인증: firebase_bridge/);
  assert.doesNotMatch(message, /로그인:/);
});

test("새 버전 첫 유입 이벤트를 받고 버전·런타임·SDK를 표시한다", () => {
  const firstSeen = {
    ...sample,
    eventId: "app_version_58542708455af9fd9f3d88aec5025cd8",
    type: "app.version.first_seen" as const,
    outcome: "observed",
    attributes: { appVersion: "1.2.5", runtime: "godot-native-android", sdk: "gd/0.6.8" },
  };
  assert.deepEqual(parseOperationalEvent(firstSeen), firstSeen);
  const message = operationalEventMessage(firstSeen, "도마뱀 테라리움");
  assert.match(message, /새 버전 첫 유입/);
  assert.match(message, /버전: 1\.2\.5/);
  assert.match(message, /런타임: godot-native-android/);
  assert.match(message, /SDK: gd\/0\.6\.8/);
});

test("새 버전 첫 유입은 장애 알림이 아니고 사용자 식별자를 계속 거부한다", () => {
  assert.equal(isOpsAlert("app.version.first_seen"), false);
  assert.equal(
    parseOperationalEvent({
      ...sample,
      type: "app.version.first_seen" as const,
      attributes: { appVersion: "1.2.5", platformUserId: "pu_secret" },
    }),
    null,
  );
});

test("신규 계정 이벤트도 버전과 런타임을 받는다", () => {
  const withBuild = {
    ...sample,
    attributes: { authType: "firebase", appVersion: "1.2.5", runtime: "godot-native-android", anonymous: false },
  };
  assert.deepEqual(parseOperationalEvent(withBuild), withBuild);
  const message = operationalEventMessage(withBuild, "도마뱀 테라리움");
  assert.match(message, /버전: 1\.2\.5/);
  assert.match(message, /런타임: godot-native-android/);
});
