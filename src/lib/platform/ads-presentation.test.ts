import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PlatformUserAds } from "./client";
import {
  activeAdsSuppressionGrant,
  adsAssuranceLabel,
  adsConfigDriftWarning,
  adsLookupState,
  adsQueueDisplay,
} from "./ads-presentation";

function user(
  reasons: Array<"operator" | "ad_free">,
  appUsesAds = true,
): PlatformUserAds {
  return {
    appId: "happy-farm",
    platformUserId: "pu_1",
    supportCode: "SUPPORT",
    isAnonymous: false,
    authType: "firebase",
    lastSeenAt: "2026-08-09T00:00:00Z",
    policy: {
      appUsesAds,
      adsEnabled: appUsesAds && reasons.length === 0,
      disabledBy: reasons,
      checkedAt: "2026-08-09T00:00:00Z",
    },
    auditHistory: [],
  };
}

describe("광고 정책 조회 상태", () => {
  it("idle, loading, not-found, read-failure를 구분한다", () => {
    assert.equal(adsLookupState({ requested: false, loading: false }), "idle");
    assert.equal(adsLookupState({ requested: true, loading: true }), "loading");
    assert.equal(
      adsLookupState({
        requested: true,
        loading: false,
        errorCode: "not_found",
      }),
      "not_found",
    );
    assert.equal(
      adsLookupState({
        requested: true,
        loading: false,
        errorCode: "platform_unavailable",
      }),
      "read_failure",
    );
  });

  it("허용, 운영자 차단, ad_free, 두 원인, 광고 미사용 앱을 구분한다", () => {
    assert.equal(
      adsLookupState({ requested: true, loading: false, user: user([]) }),
      "allowed",
    );
    assert.equal(
      adsLookupState({
        requested: true,
        loading: false,
        user: user(["operator"]),
      }),
      "suppressed",
    );
    assert.equal(
      adsLookupState({
        requested: true,
        loading: false,
        user: user(["ad_free"]),
      }),
      "suppressed",
    );
    assert.equal(
      adsLookupState({
        requested: true,
        loading: false,
        user: user(["operator", "ad_free"]),
      }),
      "suppressed",
    );
    assert.equal(
      adsLookupState({
        requested: true,
        loading: false,
        user: user([], false),
      }),
      "not_applicable",
    );
  });
});

describe("광고 운영 mutation 상태", () => {
  it("queue 대기, 실행, 성공, 실패, 결과 미확인을 구분한다", () => {
    assert.equal(adsQueueDisplay({ ok: true, found: false }), "대기");
    assert.equal(
      adsQueueDisplay({ ok: true, found: true, status: "in_progress" }),
      "실행 중",
    );
    assert.equal(
      adsQueueDisplay({
        ok: true,
        found: true,
        status: "completed",
        conclusion: "success",
      }),
      "완료",
    );
    assert.equal(
      adsQueueDisplay({
        ok: true,
        found: true,
        status: "completed",
        conclusion: "failure",
      }),
      "실패",
    );
    assert.equal(
      adsQueueDisplay({ ok: true, outcomeUnknown: true }),
      "결과 미확인",
    );
  });

  it("active grant는 실제 revoke 이력을 제외한다", () => {
    const value = user(["operator"]);
    value.auditHistory = [
      {
        requestId: "grant-1",
        appId: value.appId,
        platformUserId: value.platformUserId,
        actorLogin: "admin",
        reason: "incident_recovery",
        operation: "grant",
        applied: true,
        createdAt: "2026-08-09T00:00:00Z",
      },
      {
        requestId: "revoke-1",
        grantRequestId: "grant-1",
        appId: value.appId,
        platformUserId: value.platformUserId,
        actorLogin: "admin",
        reason: "incident_recovery",
        operation: "revoke",
        applied: true,
        createdAt: "2026-08-09T00:01:00Z",
      },
      {
        requestId: "grant-2",
        appId: value.appId,
        platformUserId: value.platformUserId,
        actorLogin: "admin",
        reason: "incident_recovery",
        operation: "grant",
        applied: true,
        createdAt: "2026-08-09T00:02:00Z",
      },
    ];
    assert.equal(activeAdsSuppressionGrant(value), "grant-2");
  });
});

it("server_verified와 client_confirmed 문구를 섞지 않는다", () => {
  assert.equal(adsAssuranceLabel("server_verified"), "서버 서명 검증");
  assert.equal(adsAssuranceLabel("client_confirmed"), "클라이언트 확인");
});

it("앱 로컬 설정이 registry보다 새로우면 불일치를 경고한다", () => {
  assert.match(
    adsConfigDriftWarning("2026-08-09T00:00:00Z", "2026-08-09T00:01:00Z") ?? "",
    /불일치/,
  );
  assert.equal(
    adsConfigDriftWarning("2026-08-09T00:02:00Z", "2026-08-09T00:01:00Z"),
    null,
  );
});
