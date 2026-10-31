import assert from "node:assert/strict";
import test from "node:test";

import { PLATFORM_OPERATION_KEYS } from "./operations";
import { platformIapRecoveryView } from "./iap-recovery-view";

test("남은 광고 회수는 Sandbox 초기화가 아닌 광고 관리 복구로 표시한다", () => {
  assert.deepEqual(platformIapRecoveryView("platform.ads.revoke-suppression"), {
    label: "광고 차단 회수",
    manualOperation: null,
    destination: { href: "/platform/ads", label: "광고 관리" },
  });
});

test("IAP 입력 선택값은 지급, 회수와 Sandbox 초기화 세 작업만 복원한다", () => {
  const manual = new Set([
    "platform.iap.grant-entitlement",
    "platform.iap.revoke-entitlement",
    "platform.iap.reset-app-store-sandbox",
  ]);
  for (const operation of PLATFORM_OPERATION_KEYS) {
    const view = platformIapRecoveryView(operation);
    assert.equal(view.manualOperation, manual.has(operation) ? operation : null);
    assert.equal(view.destination === null, manual.has(operation) || operation === "platform.iap.decide-refund-review");
  }
});

test("다른 관리 작업은 해당 복구 화면으로 안내하고 IAP 작업으로 복원하지 않는다", () => {
  for (const [operation, label, href, destinationLabel] of [
    ["platform.ads.grant-suppression", "광고 차단 지급", "/platform/ads", "광고 관리"],
    ["platform.iap.set-economy-tester", "크리스털 시험 계정 변경", "/platform/iap/crystal-testers", "크리스털 시험 계정 관리"],
    ["platform.inbox.issue", "Starter 우편 발송", "/platform/inbox", "우편 관리"],
    ["platform.config.set-update-policy", "업데이트 정책 변경", "/platform/updates", "업데이트 정책 관리"],
  ] as const) {
    assert.deepEqual(platformIapRecoveryView(operation), {
      label,
      manualOperation: null,
      destination: { href, label: destinationLabel },
    });
  }
});

test("환불 검토의 기존 IAP 복구 흐름과 실제 작업 이름을 유지한다", () => {
  assert.deepEqual(platformIapRecoveryView("platform.iap.decide-refund-review"), {
    label: "Google Play 환불 검토 결정",
    manualOperation: null,
    destination: null,
  });
});
