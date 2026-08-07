import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PlatformAuthUserResult,
  PlatformIapConsole,
  PlatformOverviewStatus,
  PlatformRefundReviewPanel,
} from "./index";

describe("플랫폼 표현 컴포넌트", () => {
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
    const html = renderToStaticMarkup(
      createElement(PlatformOverviewStatus, {
        connection: "connected",
        environment: "production",
        metrics: {
          totalUsers: 12345,
          dailyActiveUsers: 678,
          weeklyActiveUsers: 2345,
          activitySource: "session_last_seen",
          measuredAt: "2026-08-07T13:21:28Z",
        },
      }),
    );

    assert.match(html, /12,345/);
    assert.match(html, /678/);
    assert.match(html, /2,345/);
    // 정의를 안 적으면 GA4 DAU와 숫자가 다른 것이 버그로 읽힌다.
    assert.match(html, /세션 발급/);
    assert.match(html, /동시 접속은 현재 플랫폼이 측정하지 않습니다/);
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
