import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  isOpsAlert,
  operationalEventFacts,
  operationalEventLine,
  parseOperationalEvent,
  verifyOperationalEventSignature,
} from "@/lib/platform/operational-events";

const NOW = new Date("2026-08-17T10:30:00.000Z");

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
  const line = operationalEventLine(sample, "해피팜", NOW);
  assert.match(line, /신규 계정/);
  assert.match(line, /\*\*해피팜\*\*/);
  assert.doesNotMatch(line, /eventId|platformUserId/);
  // 훑어 읽는 로그라 한 줄이어야 한다.
  assert.equal(line.includes("\n"), false);
});

test("AppsInToss 로그인 referrer는 받고 사용자 식별자는 계속 거부한다", () => {
  const withReferrer = { ...sample, attributes: { authType: "apps_in_toss", referrer: "SANDBOX" } };
  assert.deepEqual(parseOperationalEvent(withReferrer), withReferrer);
  assert.equal(
    parseOperationalEvent({ ...sample, attributes: { authType: "apps_in_toss", supportCode: "LT-1234" } }),
    null,
  );
  assert.match(operationalEventLine(withReferrer, "도마뱀 테라리움", NOW), /유입 SANDBOX/);
});

test("Firebase 로그인 공급자는 받고 계정 생성 경로와 함께 표시한다", () => {
  const withProvider = {
    ...sample,
    attributes: { authType: "firebase_bridge", signInProvider: "google.com", anonymous: false },
  };
  assert.deepEqual(parseOperationalEvent(withProvider), withProvider);
  const line = operationalEventLine(withProvider, "우리 아기 기록", NOW);
  assert.match(line, /firebase_bridge/);
  assert.match(line, /google\.com/);
});

test("공급자·빌드를 모르는 구버전 클라이언트는 없는 줄을 지어내지 않는다", () => {
  const facts = operationalEventFacts({
    ...sample,
    attributes: { authType: "firebase_bridge", anonymous: false },
  });
  // 모르는 값은 unknown 으로 채우지 않고 항목 자체를 빼야 로그가 짧게 읽힌다.
  assert.deepEqual(facts.facts, ["firebase_bridge"]);
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
  assert.equal(
    operationalEventLine(firstSeen, "도마뱀 테라리움", NOW),
    "🚀 **도마뱀 테라리움** 새 버전 첫 유입 · v1.2.5 · godot-native-android · gd/0.6.8 · 19:00",
  );
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
  const line = operationalEventLine(withBuild, "도마뱀 테라리움", NOW);
  assert.match(line, /v1\.2\.5/);
  assert.match(line, /godot-native-android/);
});

// 장애 요약은 DB 에 영구 저장되고 장애 카드 제목이 된다. 표시 문자열을 잘라 만들면
// 표시를 한 줄로 바꿀 때 요약이 통째로 망가진다.
test("장애 요약은 표시가 아니라 사실에서 나온다", () => {
  const failed = {
    ...sample,
    eventId: "iap_58542708455af9fd9f3d88aec5025cd8",
    type: "iap.completion_failed" as const,
    outcome: "failed",
    attributes: { platform: "app_store", errorCode: "E_NETWORK" },
  };
  const { headline, icon } = operationalEventFacts(failed);
  assert.equal(headline, "IAP 마켓 완료 처리 실패");
  // 이모지·마크업이 섞이면 장애 카드가 자기 아이콘과 겹쳐 두 번 그린다.
  assert.equal(/[*]|❌/.test(headline), false);
  assert.equal(icon, "❌");
});
