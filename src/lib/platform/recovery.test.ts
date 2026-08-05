import assert from "node:assert/strict";
import test from "node:test";

import type { EnqueuePlatformOperationResult } from "@/lib/actions/platform-ops";

import {
  PLATFORM_RECOVERY_LEGACY_STORAGE_KEY,
  canSubmitPlatformRecovery,
  listPlatformRecoveryReferences,
  migrateLegacyPlatformRecoveryReference,
  parsePlatformRecoveryReference,
  platformBlockingEnqueueRecoveryPlan,
  platformRecoveryStorageValue,
  removePlatformRecoveryReference,
  savePlatformRecoveryReference,
  type PlatformRecoveryStorage,
} from "./recovery";
import { platformRequestIdForSubmission } from "./confirmation";

class MemoryStorage implements PlatformRecoveryStorage {
  private readonly values = new Map<string, string>();
  failWrites = false;

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("storage write failed");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test("결과 불명 복구 참조는 비민감 필드만 브라우저 저장소에 남긴다", () => {
  const value = platformRecoveryStorageValue({
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    appSlug: "lizard-tycoon",
    operation: "platform.iap.grant-entitlement",
    platformUserId: "pu_must_not_persist",
    confirmation: "GRANT must-not-persist",
  } as never);
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /pu_must_not_persist|must-not-persist/);
  assert.deepEqual(Object.keys(value).sort(), [
    "appSlug",
    "operation",
    "requestId",
  ]);
});

test("환불 검토 복구 참조도 review와 결정 payload를 저장하지 않는다", () => {
  const value = platformRecoveryStorageValue({
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    appSlug: "lizard-tycoon",
    operation: "platform.iap.decide-refund-review",
    reviewId: "a".repeat(64),
    refundPreference: "DECLINE",
    pendingRefundToken: "must-not-persist",
  } as never);
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /aaaaaaaaaa|DECLINE|must-not-persist/);
  assert.equal(
    parsePlatformRecoveryReference(value)?.operation,
    "platform.iap.decide-refund-review",
  );
});

test("브라우저 저장소의 변조된 request ID와 operation을 거부한다", () => {
  assert.equal(
    parsePlatformRecoveryReference({
      requestId: "not-a-uuid",
      appSlug: "lizard-tycoon",
      operation: "platform.iap.grant-entitlement",
    }),
    null,
  );
  assert.equal(
    parsePlatformRecoveryReference({
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      appSlug: "lizard-tycoon",
      operation: "platform.iap.delete-ledger",
    }),
    null,
  );
});

test("여러 탭의 request ID를 별도 key로 보존하고 하나만 제거한다", () => {
  const storage = new MemoryStorage();
  const first = {
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    appSlug: "lizard-tycoon",
    operation: "platform.iap.grant-entitlement" as const,
  };
  const second = {
    requestId: "223e4567-e89b-42d3-a456-426614174000",
    appSlug: "lizard-tycoon",
    operation: "platform.iap.reset-app-store-sandbox" as const,
  };
  savePlatformRecoveryReference(storage, first);
  savePlatformRecoveryReference(storage, second);
  assert.deepEqual(listPlatformRecoveryReferences(storage), [first, second]);

  removePlatformRecoveryReference(storage, first.requestId);
  assert.deepEqual(listPlatformRecoveryReferences(storage), [second]);
});

test("v1 단일 복구 값을 request별 key로 마이그레이션한다", () => {
  const storage = new MemoryStorage();
  const reference = {
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    appSlug: "lizard-tycoon",
    operation: "platform.iap.revoke-entitlement" as const,
  };
  storage.setItem(
    PLATFORM_RECOVERY_LEGACY_STORAGE_KEY,
    JSON.stringify(reference),
  );
  migrateLegacyPlatformRecoveryReference(storage);

  assert.equal(storage.getItem(PLATFORM_RECOVERY_LEGACY_STORAGE_KEY), null);
  assert.deepEqual(listPlatformRecoveryReferences(storage), [reference]);
});

test("손상된 v1 복구 값은 예외 없이 폐기한다", () => {
  const storage = new MemoryStorage();
  storage.setItem(PLATFORM_RECOVERY_LEGACY_STORAGE_KEY, "{broken");

  assert.doesNotThrow(() => migrateLegacyPlatformRecoveryReference(storage));
  assert.equal(storage.getItem(PLATFORM_RECOVERY_LEGACY_STORAGE_KEY), null);
  assert.deepEqual(listPlatformRecoveryReferences(storage), []);
});

test("v2 저장이 실패하면 유일한 v1 복구 값을 보존한다", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    PLATFORM_RECOVERY_LEGACY_STORAGE_KEY,
    JSON.stringify({
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      appSlug: "lizard-tycoon",
      operation: "platform.iap.grant-entitlement",
    }),
  );
  storage.failWrites = true;

  assert.throws(
    () => migrateLegacyPlatformRecoveryReference(storage),
    /storage write failed/,
  );
  assert.notEqual(storage.getItem(PLATFORM_RECOVERY_LEGACY_STORAGE_KEY), null);
});

test("새로고침 고아 참조는 DB 미존재 확인 뒤에만 동일 ID 재등록을 허용한다", () => {
  const recovered = { fingerprint: null, requestId: "preserved-id" };
  assert.equal(canSubmitPlatformRecovery(recovered, false), false);
  assert.equal(canSubmitPlatformRecovery(recovered, true), true);
  assert.equal(
    platformRequestIdForSubmission("re-entered", recovered, () => "new-id"),
    "preserved-id",
  );
});

test("enqueue blocker DTO는 실제 blocker를 활성화하고 미등록 ID와 신규 ID 차단을 보존한다", () => {
  const attempted = {
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    appSlug: "lizard-tycoon",
    operation: "platform.iap.grant-entitlement" as const,
  };
  const actionResult = {
    ok: false,
    blockingReference: {
      requestId: "223e4567-e89b-42d3-a456-426614174000",
      appSlug: "lizard-tycoon",
      operation: "platform.iap.reset-app-store-sandbox",
      state: "expired_unknown",
    },
  } satisfies EnqueuePlatformOperationResult;

  const plan = platformBlockingEnqueueRecoveryPlan(attempted, actionResult);
  assert.ok(plan);
  assert.equal(
    plan.active.retryRequest.requestId,
    actionResult.blockingReference.requestId,
  );
  assert.equal(plan.active.writeState, "expired_unknown");
  assert.match(plan.active.summary, /원장과 감사 로그 대조/);

  const storage = new MemoryStorage();
  for (const reference of plan.referencesToPreserve) {
    savePlatformRecoveryReference(storage, reference);
  }
  assert.deepEqual(
    listPlatformRecoveryReferences(storage).map(({ requestId }) => requestId),
    [attempted.requestId, actionResult.blockingReference.requestId],
  );
  assert.equal(canSubmitPlatformRecovery(plan.active.retryRequest, false), false);
});
