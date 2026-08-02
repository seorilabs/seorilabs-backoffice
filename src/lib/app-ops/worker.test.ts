import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPlatformWorkerConfiguration,
  completionRedactionForTest,
  expiredPendingUpdateForTest,
  hadPlatformUnknownOutcomeForTest,
  lizardOperationInputForTest,
  platformOperationInputForTest,
  platformSensitiveValuesForTest,
  safeAppOpsErrorForTest,
  shouldRetryPlatformUnknownOutcomeForTest,
  staleRecoveryUpdateForTest,
} from "./worker";
import { PLATFORM_OUTCOME_UNKNOWN_CODE } from "../platform/operations";
import { PlatformOperationUnknownOutcomeError } from "../platform/executor";

test("플랫폼 플래그만 켠 worker는 큐 처리 전에 실패한다", () => {
  assert.doesNotThrow(() =>
    assertPlatformWorkerConfiguration({
      enabled: false,
      writeConfigured: false,
    }),
  );
  assert.doesNotThrow(() =>
    assertPlatformWorkerConfiguration({
      enabled: true,
      writeConfigured: true,
    }),
  );
  assert.throws(
    () =>
      assertPlatformWorkerConfiguration({
        enabled: true,
        writeConfigured: false,
      }),
    /플랫폼 write 설정/,
  );
});

test("worker 오류에서 bearer와 긴 credential 후보를 제거한다", () => {
  const message = safeAppOpsErrorForTest(
    new Error(`Bearer secret-token ${"a".repeat(100)}`),
  );
  assert.doesNotMatch(message, /secret-token/);
  assert.doesNotMatch(message, /a{80}/);
  assert.match(message, /\[REDACTED\]/);
});

test("worker는 Production 감사용 운영자와 사유를 adapter에 전달한다", () => {
  const input = lizardOperationInputForTest({
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    operation: "iap-ledger.grant-production-entitlement",
    intent: "mutate",
    params: {
      player_ref: "uid-1",
      entitlement_id: "sp_galaxy_gecko",
    },
    actorLogin: "magicsih",
    reason: "customer_support_compensation",
  } as never);
  assert.equal(input.actorLogin, "magicsih");
  assert.equal(input.reason, "customer_support_compensation");
  assert.deepEqual(input.params, {
    player_ref: "uid-1",
    entitlement_id: "sp_galaxy_gecko",
  });
});

test("중앙 플랫폼 worker 입력은 AppOperationRun requestId를 그대로 쓴다", () => {
  const input = platformOperationInputForTest({
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    operation: "platform.iap.grant-entitlement",
    params: { platformUserId: "pu_sensitive" },
    actorLogin: "syous",
    reason: "customer_support_compensation",
  } as never);
  assert.equal(input.requestId, "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(input.reason, "customer_support_compensation");
});

test("결과 불명만 한도 내에서 같은 중앙 플랫폼 run을 재시도한다", () => {
  const error = new PlatformOperationUnknownOutcomeError();
  assert.equal(
    shouldRetryPlatformUnknownOutcomeForTest({
      repoFullName: "seorilabs/platform",
      attempts: 1,
      error,
    }),
    true,
  );
  assert.equal(
    shouldRetryPlatformUnknownOutcomeForTest({
      repoFullName: "seorilabs/platform",
      attempts: 3,
      error,
    }),
    false,
  );
  assert.equal(
    shouldRetryPlatformUnknownOutcomeForTest({
      repoFullName: "seorilabs/lizard-tycoon",
      attempts: 1,
      error,
    }),
    false,
  );
});

test("중앙 플랫폼 crash 복구는 reclaim 전에도 unknown 표식과 payload를 보존한다", () => {
  const update = staleRecoveryUpdateForTest(
    { repoFullName: "seorilabs/platform", attempts: 1 },
    new Date("2026-08-02T00:00:00.000Z"),
  );

  assert.equal(update.status, "PENDING");
  assert.equal(update.error, PLATFORM_OUTCOME_UNKNOWN_CODE);
  assert.equal("params" in update, false);
  assert.equal("reason" in update, false);
  assert.equal(
    hadPlatformUnknownOutcomeForTest({
      repoFullName: "seorilabs/platform",
      error: update.error,
    }),
    true,
  );
});

test("만료된 결과 불명 PENDING row는 payload만 지우고 unknown 표식을 보존한다", () => {
  const now = new Date("2026-08-03T00:00:00.000Z");
  const update = expiredPendingUpdateForTest(true, now);

  assert.equal(update.status, "FAILED");
  assert.equal(update.error, PLATFORM_OUTCOME_UNKNOWN_CODE);
  assert.equal(update.reason, null);
  assert.equal(update.redactedAt, now);
  assert.match(update.summary, /결과 미확인/);
});

test("플랫폼 오류에서 PUID, entitlement, confirmation, reason을 제거한다", () => {
  const run = {
    repoFullName: "seorilabs/platform",
    params: {
      platformUserId: "pu_sensitive_user",
      entitlementId: "sp_sensitive_entitlement",
      serverConfirmation: "CONFIRM sensitive operation",
    },
    reason: "customer_support_compensation",
  } as never;
  const values = platformSensitiveValuesForTest(run);
  const message = safeAppOpsErrorForTest(
    new Error(
      "pu_sensitive_user sp_sensitive_entitlement CONFIRM sensitive operation customer_support_compensation",
    ),
    values,
  );
  assert.doesNotMatch(
    message,
    /pu_sensitive|sp_sensitive|CONFIRM sensitive|customer_support_compensation/,
  );
  assert.match(message, /\[REDACTED\]/);
});

test("플랫폼 run은 최종 완료 즉시 params와 reason을 함께 제거한다", () => {
  const platform = completionRedactionForTest("seorilabs/platform");
  assert.equal("params" in platform, true);
  assert.equal(platform.reason, null);

  const legacy = completionRedactionForTest("seorilabs/lizard-tycoon");
  assert.equal("params" in legacy, true);
  assert.equal("reason" in legacy, false);
});
