import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PlatformAuthUserResult,
  PlatformIapConsole,
  PlatformOverviewStatus,
  PlatformPresenceView,
  PlatformRefundReviewPanel,
  loadAvailablePresenceSnapshot,
} from "./index";

describe("플랫폼 표현 컴포넌트", () => {
  const presenceSnapshot = {
    totalActiveSessions: 0,
    measuredAt: "2026-08-26T12:00:00Z",
    activeTtlSeconds: 150,
    apps: [],
  };

  it("Edge 정상일 때 실제 0명을 유효한 현재값으로 그린다", () => {
    const html = renderToStaticMarkup(
      createElement(PlatformPresenceView, {
        state: "available",
        current: presenceSnapshot,
        lastHealthy: presenceSnapshot,
      }),
    );

    assert.match(html, /Edge 정상/);
    assert.match(html, /전체 최근 활성/);
    assert.match(html, />0<span[^>]*>명/);
    assert.doesNotMatch(html, /동접 알 수 없음/);
  });

  it("Edge 장애 중에는 만료 결과를 0명으로 오인하지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(PlatformPresenceView, {
        state: "unavailable",
        current: null,
        lastHealthy: { ...presenceSnapshot, totalActiveSessions: 7 },
        error: "RPI Edge가 응답하지 않습니다.",
      }),
    );

    assert.match(html, /동접 알 수 없음/);
    assert.match(html, /마지막 정상값 7명/);
    assert.doesNotMatch(html, /전체 최근 활성/);
    assert.doesNotMatch(html, /마지막 정상값 0명/);
  });

  it("Edge만 실패하면 DB 숫자를 현재값으로 채택하지 않는다", async () => {
    let dbCalled = false;
    await assert.rejects(
      loadAvailablePresenceSnapshot({
        assertEdgeReady: async () => {
          throw new Error("edge unavailable");
        },
        fetchSnapshot: async () => {
          dbCalled = true;
          return presenceSnapshot;
        },
      }),
      /edge unavailable/,
    );
    assert.equal(dbCalled, false);
  });

  it("Edge 정상·DB 실패의 부분 장애도 unknown으로 전파한다", async () => {
    await assert.rejects(
      loadAvailablePresenceSnapshot({
        assertEdgeReady: async () => undefined,
        fetchSnapshot: async () => {
          throw new Error("DB unavailable");
        },
      }),
      /DB unavailable/,
    );
  });

  it("Edge와 DB가 정상일 때 0명 snapshot을 현재값으로 유지한다", async () => {
    const snapshot = await loadAvailablePresenceSnapshot({
      assertEdgeReady: async () => undefined,
      fetchSnapshot: async () => presenceSnapshot,
    });
    assert.equal(snapshot.totalActiveSessions, 0);
  });

  it("개요에서 연결 상태와 비어 있는 capability를 구분한다", () => {
    const html = renderToStaticMarkup(
      createElement(PlatformOverviewStatus, {
        connection: "degraded",
        environment: "sandbox",
        deadLetterCount: 3,
      }),
    );

    assert.match(html, /점검 필요/);
    assert.match(html, /Sandbox 원장/);
    assert.match(html, /3건 · 확인 필요/);
    assert.match(html, /확인된 기능이 없습니다/);
  });

  it("개별 조회가 실패해도 원장 환경을 그리고 실패한 구획을 따로 알린다", () => {
    // 예전에는 감사 기록 조회 실패 하나가 환경 표시까지 지우고
    // "연결 실패"로 보이게 만들었다.
    const html = renderToStaticMarkup(
      createElement(PlatformOverviewStatus, {
        connection: "degraded",
        environment: "production",
        deadLetterCount: 0,
        sectionFailures: [
          {
            section: "operatorRecords",
            label: "운영자 변경 이력",
            error: "운영 기록에 노출할 수 없는 감사 값이 있어요",
          },
        ],
      }),
    );

    assert.match(html, /Production 원장/);
    assert.match(html, /운영자 변경 이력/);
    assert.match(html, /노출할 수 없는 감사 값/);
    assert.doesNotMatch(html, /연결 실패/);
  });

  it("사용자 지표를 활성 정의와 함께 표시한다", () => {
    // 값이 서로의 부분 문자열이 되지 않게 고른다. 12,345와 2,345처럼
    // 겹치면 라벨이 뒤바뀌어도 단순 포함 검사가 통과해 버린다.
    const html = renderToStaticMarkup(
      createElement(PlatformOverviewStatus, {
        connection: "connected",
        environment: "production",
        metrics: {
          totalUsers: 91250,
          hourlyActiveUsers: 58,
          dailyActiveUsers: 431,
          weeklyActiveUsers: 7806,
          activitySource: "session_last_seen",
          measuredAt: "2026-08-07T13:21:28Z",
        },
      }),
    );

    // 라벨과 값을 붙여서 확인한다. 각각 따로 검사하면 세 숫자가
    // 엉뚱한 카드에 들어가도 통과한다.
    const card = (label: string, value: string) =>
      new RegExp(`${label}</div><div[^>]*>${value}</div>`);

    assert.match(html, card("전체 사용자", "91,250"));
    assert.match(html, card("1시간 활성", "58"));
    assert.match(html, card("DAU", "431"));
    assert.match(html, card("WAU", "7,806"));

    // 정의를 안 적으면 GA4 DAU와 숫자가 다른 것이 버그로 읽힌다.
    assert.match(html, /세션 발급/);
    assert.match(html, /RPI Edge의 최근 150초 heartbeat/);
  });

  it("지표 0은 미확인이 아니라 0으로 그린다", () => {
    // 0을 대시로 그리면 "사용자가 없다"와 "집계를 못 읽었다"가
    // 화면에서 같아 보인다.
    const html = renderToStaticMarkup(
      createElement(PlatformOverviewStatus, {
        connection: "connected",
        environment: "production",
        metrics: {
          totalUsers: 0,
          hourlyActiveUsers: 0,
          dailyActiveUsers: 0,
          weeklyActiveUsers: 0,
          activitySource: "session_last_seen",
          measuredAt: "2026-08-07T13:21:28Z",
        },
      }),
    );

    assert.match(html, /전체 사용자<\/div><div[^>]*>0<\/div>/);
    assert.doesNotMatch(html, /전체 사용자<\/div><div[^>]*>—<\/div>/);
  });

  it("제외된 기록이 있으면 목록이 불완전하다고 경고한다", () => {
    // 감사 이력에서 조용한 누락은 잘못된 결론으로 이어진다.
    // 짧아진 목록을 보고 "지급한 적 없다"고 판단하면 안 된다.
    const html = renderToStaticMarkup(
      createElement(PlatformOverviewStatus, {
        connection: "degraded",
        environment: "sandbox",
        hiddenOperatorRecordCount: 2,
        hiddenOrderCount: 5,
      }),
    );

    assert.match(html, /운영자 변경 이력 2건 제외됨/);
    assert.match(html, /최근 주문 5건 제외됨/);
    assert.match(html, /없는 것으로 판단하지 마세요/);
    // 어디서 원인을 찾는지도 알려야 한다. 원장 접근 권한이 없으므로
    // 로그가 유일한 단서다.
    assert.match(html, /invalid_fields/);
  });

  it("제외된 기록이 없으면 경고를 띄우지 않는다", () => {
    // 늘 떠 있는 경고는 아무도 안 본다.
    const html = renderToStaticMarkup(
      createElement(PlatformOverviewStatus, {
        connection: "connected",
        environment: "sandbox",
        hiddenOperatorRecordCount: 0,
        hiddenOrderCount: 0,
      }),
    );

    assert.doesNotMatch(html, /제외됨/);
  });

  it("지표 미지원은 장애가 아니라 배포 대기로 안내한다", () => {
    const html = renderToStaticMarkup(
      createElement(PlatformOverviewStatus, {
        connection: "connected",
        environment: "production",
        metrics: null,
        metricsUnsupported: true,
      }),
    );

    assert.match(html, /플랫폼 배포 후 표시됩니다/);
  });

  it("인증 조회 결과에서 자격증명 원문과 PII 추가 필드를 렌더링하지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(PlatformAuthUserResult, {
        state: "found",
        user: {
          appId: "sample-app",
          platformUserId: "pu_safe",
          supportCode: "SAFE-CODE",
          isAnonymous: false,
          blocked: null,
          email: "must-not-render@example.com",
          idToken: "must-not-render-id-token",
        } as never,
      }),
    );

    assert.match(html, /pu_safe/);
    assert.match(html, /SAFE-CODE/);
    assert.match(html, /차단 상태 미확인/);
    assert.doesNotMatch(html, /must-not-render/);
  });

  it("IAP 주문 객체에 원문 receipt와 구매 토큰이 섞여도 렌더링하지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(PlatformIapConsole, {
        environment: "production",
        deadLetterCount: 0,
        orders: [
          {
            orderKey: "order-safe",
            appId: "sample-app",
            platformUserId: "pu_safe",
            entitlementId: "premium",
            market: "app_store",
            productId: "premium.product",
            state: "active",
            purchasedAt: "2026-08-16T17:52:42Z",
            observedAt: "2026-09-02T03:53:53Z",
            receipt: "must-not-render-receipt",
            purchaseToken: "must-not-render-purchase-token",
          },
        ] as never,
        operatorRecords: [
          {
            requestId: "revoke-request-safe",
            grantRequestId: "grant-request-safe",
            kind: "revoke",
            appId: "sample-app",
            platformUserId: "pu_safe",
            entitlementId: "premium",
          },
        ],
      }),
    );

    assert.match(html, /Production 원장/);
    assert.match(html, /order-safe/);
    assert.match(html, /구매 2026\. 8\. 17\. 오전 2:52/);
    assert.match(html, /최근 확인 2026\. 9\. 2\. 오후 12:53/);
    assert.match(html, /동일 주문 재확인은 새 IAP 지급 알림을 만들지 않습니다/);
    assert.match(html, /원 지급 grant-request-safe/);
    assert.doesNotMatch(html, /must-not-render/);
  });

  it("환불 검토 패널은 safe queue 경계와 health count를 설명한다", () => {
    const html = renderToStaticMarkup(
      createElement(PlatformRefundReviewPanel, {
        apps: [{ slug: "lizard-tycoon", displayName: "도마뱀 키우기" }],
        environment: "production",
        pendingCount: 3,
        dueSoonCount: 1,
        failedCount: 2,
      }),
    );
    assert.match(html, /Google Play 환불 검토/);
    assert.match(html, /token·order ID 없이/);
    assert.match(html, /미응답 3/);
    assert.match(html, /1시간 이내 1/);
    assert.match(html, /실패 2/);
    assert.doesNotMatch(html, /pendingRefundToken|ciphertext/);
  });
});
