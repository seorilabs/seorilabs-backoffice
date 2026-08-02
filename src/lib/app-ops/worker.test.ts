import assert from "node:assert/strict";
import test from "node:test";

import {
  PLATFORM_MIN_EXECUTION_WINDOW_MS_FOR_TEST,
  activeProcessingWhereForTest,
  assertPlatformResultBindingForTest,
  assertPlatformWorkerConfiguration,
  canStartPlatformRemoteForTest,
  claimExpiryThresholdForTest,
  completionWriteWhereForTest,
  completionRedactionForTest,
  executeWithinClaimWindowForTest,
  expiredPendingUpdateForTest,
  expiredPlatformProcessingWhereForTest,
  expiredTerminalRowsWhereForTest,
  hadPlatformUnknownOutcomeForTest,
  lizardOperationInputForTest,
  platformOperationInputForTest,
  platformSensitiveValuesForTest,
  safeAppOpsErrorForTest,
  shouldRetryPlatformUnknownOutcomeForTest,
  staleRecoveryLiveGuardForTest,
  staleRecoveryWhereForTest,
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

test("중앙 플랫폼 결과는 claim row의 requestId와 operation에 다시 결합한다", () => {
  const run = {
    repoFullName: "seorilabs/platform",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    operation: "platform.iap.grant-entitlement",
  } as const;
  const result = {
    version: 1,
    requestId: run.requestId,
    operation: run.operation,
    status: "success",
    summary: "ok",
    completedAt: "2026-08-03T00:00:00.000Z",
  } as const;

  assert.doesNotThrow(() => assertPlatformResultBindingForTest(run, result));
  assert.throws(
    () =>
      assertPlatformResultBindingForTest(run, {
        ...result,
        requestId: "223e4567-e89b-42d3-a456-426614174000",
      }),
    PlatformOperationUnknownOutcomeError,
  );
  assert.throws(
    () =>
      assertPlatformResultBindingForTest(run, {
        ...result,
        operation: "platform.iap.revoke-entitlement",
      }),
    PlatformOperationUnknownOutcomeError,
  );
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

test("stale recovery의 TTL guard는 플랫폼에만 적용해 기존 앱 PROCESSING을 고착시키지 않는다", () => {
  const now = new Date("2026-08-03T00:00:00.000Z");
  assert.deepEqual(staleRecoveryLiveGuardForTest("seorilabs/platform", now), {
    expiresAt: { gt: now },
    redactedAt: null,
  });
  assert.deepEqual(
    staleRecoveryLiveGuardForTest("seorilabs/lizard-tycoon", now),
    {},
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

test("플랫폼 claim은 20초 HTTP timeout보다 큰 60초 실행 창을 요구한다", () => {
  const startedAt = new Date("2026-08-03T00:00:00.000Z");
  const threshold = claimExpiryThresholdForTest(
    "seorilabs/platform",
    startedAt,
  );

  assert.ok(PLATFORM_MIN_EXECUTION_WINDOW_MS_FOR_TEST > 20_000);
  assert.equal(
    threshold.getTime() - startedAt.getTime(),
    PLATFORM_MIN_EXECUTION_WINDOW_MS_FOR_TEST,
  );
  assert.equal(
    claimExpiryThresholdForTest("seorilabs/lizard-tycoon", startedAt),
    startedAt,
  );
  assert.equal(
    canStartPlatformRemoteForTest(
      "seorilabs/platform",
      startedAt,
      new Date(startedAt.getTime() + 60_000),
    ),
    false,
  );
  assert.equal(
    canStartPlatformRemoteForTest(
      "seorilabs/platform",
      startedAt,
      new Date(startedAt.getTime() + 60_001),
    ),
    true,
  );
  assert.equal(
    canStartPlatformRemoteForTest(
      "seorilabs/platform",
      startedAt,
      new Date(startedAt.getTime() - 1),
    ),
    false,
  );
  assert.equal(
    canStartPlatformRemoteForTest(
      "seorilabs/lizard-tycoon",
      startedAt,
      new Date(startedAt.getTime() - 1),
    ),
    true,
  );
});

test("만료되었거나 60초 미만 남은 platform claim은 remote mutation을 시작하지 않는다", async () => {
  const now = new Date("2026-08-03T00:00:00.000Z");
  let remoteCalls = 0;
  const remote = async () => {
    remoteCalls += 1;
    return "called";
  };

  assert.deepEqual(
    await executeWithinClaimWindowForTest(
      "seorilabs/platform",
      now,
      new Date(now.getTime() - 1),
      remote,
    ),
    { started: false },
  );
  assert.deepEqual(
    await executeWithinClaimWindowForTest(
      "seorilabs/platform",
      now,
      new Date(now.getTime() + 60_000),
      remote,
    ),
    { started: false },
  );
  assert.equal(remoteCalls, 0);
});

test("late completion CAS는 아직 redaction되지 않은 PROCESSING row만 갱신한다", () => {
  const claimedAt = new Date("2026-08-03T00:00:00.000Z");
  const claim = {
    id: "run-1",
    repoFullName: "seorilabs/platform",
    attempts: 2,
    startedAt: claimedAt,
  } as never;
  assert.deepEqual(activeProcessingWhereForTest(claim), {
    id: "run-1",
    status: "PROCESSING",
    redactedAt: null,
    attempts: 2,
    startedAt: claimedAt,
  });
  assert.deepEqual(
    completionWriteWhereForTest(claim),
    activeProcessingWhereForTest(claim),
  );
});

test("old worker 세대는 recovery 후 새 platform claim 세대와 CAS가 일치하지 않는다", () => {
  const workerA = {
    id: "run-1",
    repoFullName: "seorilabs/platform",
    attempts: 1,
    startedAt: new Date("2026-08-03T00:00:00.000Z"),
  };
  const workerB = {
    ...workerA,
    attempts: 2,
    startedAt: new Date("2026-08-03T00:11:00.000Z"),
  };

  assert.notDeepEqual(
    activeProcessingWhereForTest(workerA),
    activeProcessingWhereForTest(workerB),
  );
  assert.deepEqual(
    staleRecoveryWhereForTest(workerA, new Date("2026-08-03T00:10:00.000Z")),
    {
      id: "run-1",
      status: "PROCESSING",
      expiresAt: { gt: new Date("2026-08-03T00:10:00.000Z") },
      redactedAt: null,
      attempts: 1,
      startedAt: workerA.startedAt,
    },
  );
});

test("기존 앱 completion은 플랫폼 TTL CAS를 적용하지 않는다", () => {
  assert.deepEqual(
    completionWriteWhereForTest({
      id: "run-1",
      repoFullName: "seorilabs/lizard-tycoon",
      attempts: 2,
      startedAt: new Date("2026-08-03T00:00:00.000Z"),
    } as never),
    { id: "run-1" },
  );
  assert.deepEqual(
    staleRecoveryWhereForTest(
      {
        id: "run-1",
        repoFullName: "seorilabs/lizard-tycoon",
        attempts: 2,
        startedAt: new Date("2026-08-03T00:00:00.000Z"),
      } as never,
      new Date("2026-08-03T00:10:00.000Z"),
    ),
    { id: "run-1", status: "PROCESSING" },
  );
});

test("TTL 정리는 만료된 플랫폼 PROCESSING row도 unknown으로 닫고 redaction한다", () => {
  const now = new Date("2026-08-03T00:00:00.000Z");
  assert.deepEqual(expiredPlatformProcessingWhereForTest(now), {
    repoFullName: "seorilabs/platform",
    expiresAt: { lte: now },
    redactedAt: null,
    status: "PROCESSING",
  });

  const update = expiredPendingUpdateForTest(true, now);
  assert.equal(update.status, "FAILED");
  assert.equal(update.error, PLATFORM_OUTCOME_UNKNOWN_CODE);
  assert.equal(update.reason, null);
  assert.equal(update.redactedAt, now);
});

test("terminal TTL redaction은 조회 뒤 PENDING으로 바뀐 row를 건드리지 않는 CAS다", () => {
  const now = new Date("2026-08-03T00:00:00.000Z");
  assert.deepEqual(expiredTerminalRowsWhereForTest(["run-1"], now), {
    id: { in: ["run-1"] },
    expiresAt: { lte: now },
    redactedAt: null,
    status: { in: ["SUCCEEDED", "FAILED"] },
  });
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
