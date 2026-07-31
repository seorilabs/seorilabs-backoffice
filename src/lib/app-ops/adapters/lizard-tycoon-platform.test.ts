/**
 * 플랫폼 어댑터 검증.
 *
 * 실제 HTTP는 client.test.ts가 본다. 여기서는 operation 라우팅과
 * 입력 검증, 그리고 게이트 판단을 확인한다.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isPlatformSupportedOperation,
  shouldUsePlatform,
} from "./lizard-tycoon-platform";

describe("플랫폼 지원 여부", () => {
  it("옮긴 operation은 플랫폼이 처리한다", () => {
    const supported = [
      "iap-ledger.recent-purchases",
      "iap-ledger.account-entitlements",
      "iap-ledger.production-grants",
      "iap-ledger.grant-production-entitlement",
      "iap-ledger.revoke-production-entitlement",
    ];

    for (const op of supported) {
      assert.equal(isPlatformSupportedOperation(op), true, op);
    }
  });

  // 조용히 빈 결과를 주면 운영자가 "데이터 없음"으로 읽는다.
  // 아직 없는 기능임을 분명히 해야 한다.
  it("아직 못 옮긴 operation은 기존 경로에 남는다", () => {
    const unsupported = [
      "iap-ledger.sandbox-testers",
      "iap-ledger.refund-review-queue",
      "iap-ledger.reset-app-store-sandbox",
    ];

    for (const op of unsupported) {
      assert.equal(isPlatformSupportedOperation(op), false, op);
    }
  });
});

describe("게이트", () => {
  it("설정이 없으면 플랫폼을 쓰지 않는다", () => {
    // 이 테스트 환경에는 PLATFORM_ADMIN_* 이 없다.
    // 기존 어댑터가 그대로 처리해야 한다.
    assert.equal(shouldUsePlatform("iap-ledger.recent-purchases"), false);
  });

  it("설정이 있어도 미지원 operation은 넘기지 않는다", () => {
    const original = {
      flag: process.env.FEATURE_PLATFORM_ADMIN,
      url: process.env.PLATFORM_ADMIN_URL,
      key: process.env.PLATFORM_ADMIN_SA_KEY_JSON,
    };

    process.env.FEATURE_PLATFORM_ADMIN = "true";
    process.env.PLATFORM_ADMIN_URL = "https://platform-admin.test";
    process.env.PLATFORM_ADMIN_SA_KEY_JSON = "{}";

    try {
      assert.equal(shouldUsePlatform("iap-ledger.recent-purchases"), true);
      assert.equal(shouldUsePlatform("iap-ledger.sandbox-testers"), false);
    } finally {
      restore("FEATURE_PLATFORM_ADMIN", original.flag);
      restore("PLATFORM_ADMIN_URL", original.url);
      restore("PLATFORM_ADMIN_SA_KEY_JSON", original.key);
    }
  });

  it("플래그만 켜고 주소가 없으면 쓰지 않는다", () => {
    const original = {
      flag: process.env.FEATURE_PLATFORM_ADMIN,
      url: process.env.PLATFORM_ADMIN_URL,
    };

    process.env.FEATURE_PLATFORM_ADMIN = "true";
    delete process.env.PLATFORM_ADMIN_URL;

    try {
      // 반쯤 설정된 상태로 켜지면 런타임에 터진다. 부팅 조건을 다 본다.
      assert.equal(shouldUsePlatform("iap-ledger.recent-purchases"), false);
    } finally {
      restore("FEATURE_PLATFORM_ADMIN", original.flag);
      restore("PLATFORM_ADMIN_URL", original.url);
    }
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
