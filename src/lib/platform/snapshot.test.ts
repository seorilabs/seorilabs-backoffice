import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PlatformApiError, type PlatformHealth } from "@/lib/platform/client";
import { buildPlatformIapSnapshot } from "@/lib/platform/snapshot-build";
import { platformSnapshotErrorMessage } from "@/lib/platform/snapshot";

const HEALTH: PlatformHealth = {
  environment: "sandbox",
  deadLetterCount: 0,
  refundReviewAvailable: true,
  pendingRefundReviewCount: 0,
  dueSoonRefundReviewCount: 0,
  failedRefundReviewCount: 0,
  environmentMismatches: [],
};

function ok<T>(value: T): PromiseSettledResult<T> {
  return { status: "fulfilled", value };
}

function failed(reason: unknown): PromiseSettledResult<never> {
  return { status: "rejected", reason };
}

const CHECKED_AT = "2026-08-07T13:21:28.000Z";

describe("플랫폼 snapshot 조립", () => {
  it("감사 기록 조회가 실패해도 원장 환경과 dead-letter는 남는다", () => {
    // 실제 사고다. 네 조회를 Promise.all로 묶어 둔 탓에 레거시 감사
    // 레코드 하나가 계약 검증에 걸리자 개요 화면 전체가 죽고
    // "Admin API 연결 실패 / 환경 미확인"이라는 틀린 원인이 떴다.
    const snapshot = buildPlatformIapSnapshot(
      {
        health: ok({ ...HEALTH, deadLetterCount: 3 }),
        orders: ok([]),
        operatorRecords: failed(
          new PlatformApiError(
            "ledger_state_invalid",
            "운영 기록에 노출할 수 없는 감사 값이 있어요",
            422,
          ),
        ),
        metrics: ok(null),
      },
      CHECKED_AT,
    );

    assert.equal(snapshot.health?.environment, "sandbox");
    assert.equal(snapshot.health?.deadLetterCount, 3);
    assert.equal(snapshot.failures.length, 1);
    assert.equal(snapshot.failures[0].section, "operatorRecords");
    assert.equal(snapshot.failures[0].label, "운영자 변경 이력");
    assert.match(snapshot.failures[0].error, /노출할 수 없는 감사 값/);
    assert.deepEqual(snapshot.operatorRecords, []);
  });

  it("Admin API 원문 오류 메시지를 그대로 전달한다", () => {
    // 원인을 화면에서 지우면 운영자가 진단할 방법이 없다.
    const snapshot = buildPlatformIapSnapshot(
      {
        health: ok(HEALTH),
        orders: failed(
          new PlatformApiError("ledger_state_invalid", "주문 원장이 이상해요", 422),
        ),
        operatorRecords: ok({ grants: [], revocations: [] }),
        metrics: ok(null),
      },
      CHECKED_AT,
    );

    assert.equal(snapshot.failures[0].error, "주문 원장이 이상해요");
    assert.equal(snapshot.failures[0].code, "ledger_state_invalid");
  });

  it("알 수 없는 오류의 원문은 브라우저로 내보내지 않는다", () => {
    const snapshot = buildPlatformIapSnapshot(
      {
        health: ok(HEALTH),
        orders: ok([]),
        operatorRecords: ok({ grants: [], revocations: [] }),
        metrics: failed(new Error("connect ECONNREFUSED 10.0.0.5:443")),
      },
      CHECKED_AT,
    );

    assert.doesNotMatch(JSON.stringify(snapshot), /10\.0\.0\.5/);
    assert.equal(snapshot.failures[0].code, "platform_unavailable");
  });

  it("health가 실패해도 나머지 조회 결과는 살아 있다", () => {
    const snapshot = buildPlatformIapSnapshot(
      {
        health: failed(new PlatformApiError("network_error", "연결 실패", 0)),
        orders: ok([]),
        operatorRecords: ok({ grants: [], revocations: [] }),
        metrics: ok({
          totalUsers: 10,
          dailyActiveUsers: 2,
          weeklyActiveUsers: 5,
          activitySource: "session_last_seen",
          measuredAt: CHECKED_AT,
        }),
      },
      CHECKED_AT,
    );

    assert.equal(snapshot.health, null);
    assert.equal(snapshot.metrics?.totalUsers, 10);
    assert.equal(snapshot.failures.length, 1);
    assert.equal(snapshot.failures[0].section, "health");
  });

  it("지표 미지원은 실패가 아니라 null이다", () => {
    // 구버전 Admin API를 만난 rolling deploy 중과 진짜 장애를 화면이
    // 구분해야 한다. 둘 다 빨간 경고로 보이면 경고가 무시된다.
    const snapshot = buildPlatformIapSnapshot(
      {
        health: ok(HEALTH),
        orders: ok([]),
        operatorRecords: ok({ grants: [], revocations: [] }),
        metrics: ok(null),
      },
      CHECKED_AT,
    );

    assert.equal(snapshot.metrics, null);
    assert.deepEqual(snapshot.failures, []);
  });

  it("단일 배너 화면을 위해 구획 실패를 한 줄로 요약한다", () => {
    const snapshot = buildPlatformIapSnapshot(
      {
        health: ok(HEALTH),
        orders: ok([]),
        operatorRecords: failed(
          new PlatformApiError("ledger_state_invalid", "감사 값이 이상해요", 422),
        ),
        metrics: ok(null),
      },
      CHECKED_AT,
    );

    assert.equal(
      platformSnapshotErrorMessage(snapshot),
      "운영자 변경 이력: 감사 값이 이상해요",
    );
  });

  it("실패가 없으면 요약 문구도 없다", () => {
    const snapshot = buildPlatformIapSnapshot(
      {
        health: ok(HEALTH),
        orders: ok([]),
        operatorRecords: ok({ grants: [], revocations: [] }),
        metrics: ok(null),
      },
      CHECKED_AT,
    );

    assert.equal(platformSnapshotErrorMessage(snapshot), null);
  });

  it("운영자 지급·회수를 최신순으로 합친다", () => {
    const record = (requestId: string, createdAt: string) => ({
      requestId,
      platformUserId: "pu_01J00000000000000000000000",
      entitlementId: "premium",
      actorLogin: "syous",
      reason: "customer_support_compensation" as const,
      appId: "lizard-tycoon",
      createdAt,
      kind: "grant" as const,
    });

    const snapshot = buildPlatformIapSnapshot(
      {
        health: ok(HEALTH),
        orders: ok([]),
        operatorRecords: ok({
          grants: [record("old", "2026-08-01T00:00:00Z")],
          revocations: [
            { ...record("new", "2026-08-05T00:00:00Z"), kind: "revoke" as const },
          ],
        }),
        metrics: ok(null),
      },
      CHECKED_AT,
    );

    assert.deepEqual(
      snapshot.operatorRecords.map((r) => r.requestId),
      ["new", "old"],
    );
  });
});
