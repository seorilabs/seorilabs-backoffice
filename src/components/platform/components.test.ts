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
