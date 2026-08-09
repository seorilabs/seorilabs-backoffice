/**
 * 플랫폼 Admin API 클라이언트 검증.
 *
 * OIDC 토큰 발급은 google-auth-library의 몫이라 여기서 검증하지 않는다.
 * 확인하는 것은 envelope 해석과 오류 전파다 — 그게 틀리면 운영자가
 * 실패를 성공으로 읽는다.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { PlatformApiError } from "./client";

/**
 * readEnvelope만 떼어내 검증한다.
 *
 * 실제 클래스는 생성자에서 SA JSON을 파싱하고 GoogleAuth를 만든다.
 * 그 경로를 타지 않고 응답 해석 로직만 확인하려면 같은 규칙을
 * 여기 재현해야 하는데, 그러면 테스트가 구현을 따라 하는 꼴이 된다.
 *
 * 대신 fetch를 갈아끼워 실제 클라이언트를 통과시킨다.
 */
async function withClient<T>(
  reply: {
    status: number;
    body: unknown;
    raw?: string;
    inspectRequest?: (input: string | URL | Request, init?: RequestInit) => void;
  },
  run: (client: import("./client").PlatformClient) => Promise<T>,
): Promise<T> {
  const { PlatformClient } = await import("./client");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      reply.inspectRequest?.(input, init);
      const text =
        reply.raw !== undefined ? reply.raw : JSON.stringify(reply.body);
      return new Response(text, {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  ) as unknown as typeof fetch;

  const client = new PlatformClient({
    baseUrl: "https://platform-admin.test",
    serviceAccountJson: JSON.stringify(fakeServiceAccount()),
  });

  // getIdTokenClient가 실제 Google에 붙지 않게 막는다.
  const auth = (client as unknown as { auth: Record<string, unknown> }).auth;
  auth.getIdTokenClient = async () => ({
    idTokenProvider: { fetchIdToken: async () => "fake-id-token" },
  });

  try {
    return await run(client);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** 형식만 맞는 가짜 서비스 계정. 실제로 서명에 쓰지 않는다. */
function fakeServiceAccount() {
  return {
    type: "service_account",
    project_id: "seorilabs-platform",
    private_key_id: "fake",
    private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
    client_email: "backoffice-admin@seorilabs-platform.iam.gserviceaccount.com",
    client_id: "0",
    token_uri: "https://oauth2.googleapis.com/token",
  };
}

describe("PlatformClient 생성", () => {
  it("주소가 없으면 거부한다", async () => {
    const { PlatformClient } = await import("./client");
    assert.throws(
      () => new PlatformClient({ baseUrl: "", serviceAccountJson: "{}" }),
      /주소가 필요/,
    );
  });

  it("서비스 계정이 없으면 거부한다", async () => {
    const { PlatformClient } = await import("./client");
    assert.throws(
      () => new PlatformClient({ baseUrl: "https://x.test", serviceAccountJson: "  " }),
      /서비스 계정이 필요/,
    );
  });

  it("서비스 계정 JSON이 깨졌으면 거부한다", async () => {
    const { PlatformClient } = await import("./client");
    assert.throws(
      () => new PlatformClient({ baseUrl: "https://x.test", serviceAccountJson: "{{{" }),
      /해석하지 못했습니다/,
    );
  });
});

describe("응답 해석", () => {
  it("성공 응답에서 result를 꺼낸다", async () => {
    const got = await withClient(
      { status: 200, body: { ok: true, result: { environment: "sandbox", deadLetterCount: 2 } } },
      (c) => c.health(),
    );

    assert.equal(got.environment, "sandbox");
    assert.equal(got.deadLetterCount, 2);
  });

  it("환경 불일치 목록을 그대로 전달한다", async () => {
    const got = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            environment: "production",
            deadLetterCount: 0,
            environmentMismatches: [
              { appId: "lizard-tycoon", registry: "sandbox", ledger: "production" },
            ],
          },
        },
      },
      (c) => c.health(),
    );

    assert.equal(got.environmentMismatches.length, 1);
    assert.equal(got.environmentMismatches[0].appId, "lizard-tycoon");
    assert.equal(got.environmentMismatches[0].registry, "sandbox");
    assert.equal(got.environmentMismatches[0].ledger, "production");
  });

  it("환경 불일치 필드가 없어도 health 조회는 성공한다", async () => {
    // 구버전 Admin API 호환. 이 필드 하나 때문에 상태 화면 전체가
    // 닫히면 정작 문제를 볼 창구가 사라진다.
    const got = await withClient(
      { status: 200, body: { ok: true, result: { environment: "sandbox", deadLetterCount: 0 } } },
      (c) => c.health(),
    );

    assert.deepEqual(got.environmentMismatches, []);
    assert.equal(got.pendingRefundReviewCount, 0);
    assert.equal(got.dueSoonRefundReviewCount, 0);
    assert.equal(got.failedRefundReviewCount, 0);
    assert.equal(got.refundReviewAvailable, false);
  });

  it("환불 검토 health count를 검증해 전달한다", async () => {
    const got = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            environment: "production",
            deadLetterCount: 0,
            pendingRefundReviewCount: 3,
            dueSoonRefundReviewCount: 1,
            failedRefundReviewCount: 2,
          },
        },
      },
      (c) => c.health(),
    );
    assert.equal(got.pendingRefundReviewCount, 3);
    assert.equal(got.dueSoonRefundReviewCount, 1);
    assert.equal(got.failedRefundReviewCount, 2);
    assert.equal(got.refundReviewAvailable, true);
  });

  it("형식이 깨진 환경 불일치 항목만 버리고 나머지는 보여준다", async () => {
    const got = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            environment: "production",
            deadLetterCount: 0,
            environmentMismatches: [
              { appId: "", registry: "sandbox", ledger: "production" },
              { appId: "ok-app", registry: "sandbox", ledger: "production" },
              { appId: "no-ledger", registry: "sandbox" },
              "문자열",
            ],
          },
        },
      },
      (c) => c.health(),
    );

    assert.equal(got.environmentMismatches.length, 1);
    assert.equal(got.environmentMismatches[0].appId, "ok-app");
  });

  it("목록 필드가 없으면 빈 결과로 오인하지 않는다", async () => {
    await assert.rejects(
      () =>
        withClient({ status: 200, body: { ok: true, result: {} } }, (c) =>
          c.recentOrders(),
        ),
      (error: unknown) =>
        error instanceof PlatformApiError &&
        error.code === "platform_response_invalid",
    );
  });

  it("명시적인 빈 목록만 빈 결과로 전달한다", async () => {
    const got = await withClient(
      {
        status: 200,
        body: { ok: true, result: { orders: [], hiddenOrderCount: 0 } },
      },
      (c) => c.recentOrders(),
    );
    assert.deepEqual(got, { orders: [], hidden: 0 });
  });

  it("제외 건수를 읽어 목록이 불완전함을 전달한다", async () => {
    const got = await withClient(
      {
        status: 200,
        body: { ok: true, result: { orders: [], hiddenOrderCount: 4 } },
      },
      (c) => c.recentOrders(),
    );
    assert.equal(got.hidden, 4);
  });

  it("제외 건수를 주지 않는 구버전 Admin API도 목록은 읽는다", async () => {
    // rolling deploy 중 잠깐 구버전을 만난다. 건수를 모르는 것이
    // 목록을 통째로 못 읽는 것보다 낫다.
    const got = await withClient(
      { status: 200, body: { ok: true, result: { orders: [] } } },
      (c) => c.recentOrders(),
    );
    assert.deepEqual(got, { orders: [], hidden: 0 });
  });

  it("운영자 이력의 지급·회수 제외 건수를 합산한다", async () => {
    const got = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            grants: [],
            revocations: [],
            hiddenGrantCount: 2,
            hiddenRevocationCount: 3,
          },
        },
      },
      (c) => c.operatorRecords(),
    );
    assert.equal(got.hidden, 5);
  });

  it("상태 필드가 빠지면 연결 성공으로 오인하지 않는다", async () => {
    await assert.rejects(
      () =>
        withClient(
          { status: 200, body: { ok: true, result: { environment: "production" } } },
          (c) => c.health(),
        ),
      (error: unknown) =>
        error instanceof PlatformApiError &&
        error.code === "platform_response_invalid",
    );
  });

  it("오류 응답을 PlatformApiError로 던진다", async () => {
    await assert.rejects(
      () =>
        withClient(
          {
            status: 409,
            body: {
              ok: false,
              error: { code: "purchase_owned_by_another_user", message: "다른 계정" },
            },
          },
          (c) => c.health(),
        ),
      (err: unknown) => {
        assert.ok(err instanceof PlatformApiError);
        assert.equal(err.code, "purchase_owned_by_another_user");
        assert.equal(err.status, 409);
        return true;
      },
    );
  });

  // 상태 코드와 ok가 어긋나면 어느 쪽을 믿을지 정할 수 없다.
  // 지급 여부가 걸린 응답에서 추측으로 진행하면 안 된다.
  it("2xx인데 ok가 false면 거부한다", async () => {
    await assert.rejects(
      () =>
        withClient(
          { status: 200, body: { ok: false, error: { code: "x", message: "y" } } },
          (c) => c.health(),
        ),
      (err: unknown) => {
        assert.ok(err instanceof PlatformApiError);
        assert.equal(err.code, "platform_response_invalid");
        return true;
      },
    );
  });

  it("4xx인데 ok가 true면 거부한다", async () => {
    await assert.rejects(
      () => withClient({ status: 400, body: { ok: true, result: {} } }, (c) => c.health()),
      (err: unknown) => {
        assert.ok(err instanceof PlatformApiError);
        assert.equal(err.code, "platform_response_invalid");
        return true;
      },
    );
  });

  it("JSON이 아니면 거부한다", async () => {
    await assert.rejects(
      () =>
        withClient({ status: 502, body: null, raw: "<html>Bad Gateway</html>" }, (c) =>
          c.health(),
        ),
      (err: unknown) => {
        assert.ok(err instanceof PlatformApiError);
        assert.equal(err.code, "platform_response_invalid");
        return true;
      },
    );
  });

  it("ok 필드가 없으면 거부한다", async () => {
    await assert.rejects(
      () => withClient({ status: 200, body: { result: {} } }, (c) => c.health()),
      (err: unknown) => {
        assert.ok(err instanceof PlatformApiError);
        return true;
      },
    );
  });

  // 서버가 필드를 추가해도 백오피스가 깨지면 안 된다.
  it("미지 필드를 무시한다", async () => {
    const got = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: { environment: "production", deadLetterCount: 0, 미래필드: 1 },
          최상위미래필드: "x",
        },
      },
      (c) => c.health(),
    );
    assert.equal(got.environment, "production");
  });
});

describe("전체 요청 timeout", () => {
  it("token이 timeout 뒤 완료돼도 remote fetch를 시작하지 않는다", async () => {
    const { PlatformClient } = await import("./client");
    let resolveToken: ((token: string) => void) | undefined;
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          ok: true,
          result: { environment: "sandbox", deadLetterCount: 0 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new PlatformClient({
      baseUrl: "https://platform-admin.test",
      serviceAccountJson: JSON.stringify(fakeServiceAccount()),
      timeoutMs: 5,
    });
    const auth = (client as unknown as { auth: Record<string, unknown> }).auth;
    auth.getIdTokenClient = async () => ({
      idTokenProvider: {
        fetchIdToken: () =>
          new Promise<string>((resolve) => {
            resolveToken = resolve;
          }),
      },
    });

    try {
      await assert.rejects(
        () => client.health(),
        (error: unknown) =>
          error instanceof PlatformApiError &&
          error.code === "network_error" &&
          error.status === 0 &&
          /제한 시간/.test(error.message),
      );
      resolveToken?.("late-token");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("광고 Admin 응답", () => {
  const safeClaim = {
    claimId: "cl_1",
    appId: "happy-farm",
    placement: "harvest_boost",
    provider: "admob",
    clientPlatform: "android",
    reward: { key: "harvest_boost", amount: 1 },
    state: "confirmed",
    assurance: "server_verified",
    createdAt: "2026-08-09T00:00:00Z",
    confirmedAt: "2026-08-09T00:00:05Z",
    expiresAt: "2026-08-10T00:00:00Z",
  };

  it("사용자 광고 정책은 원본 신원 없이 안전한 인증 유형만 전달한다", async () => {
    const got = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            appId: "happy-farm",
            platformUserId: "pu_01J00000000000000000000000",
            supportCode: "HF-ABC12345",
            isAnonymous: false,
            authType: "apps_in_toss",
            lastSeenAt: "2026-08-09T00:00:00Z",
            policy: {
              appUsesAds: true,
              adsEnabled: true,
              disabledBy: [],
              checkedAt: "2026-08-09T00:00:00Z",
            },
            auditHistory: [],
          },
        },
      },
      (client) => client.userAds("pu_01J00000000000000000000000"),
    );
    assert.equal(got.authType, "apps_in_toss");
    assert.equal("userKey" in got, false);
  });

  it("Claim의 safe 필드와 assurance만 전달한다", async () => {
    const got = await withClient(
      { status: 200, body: { ok: true, result: { claims: [safeClaim] } } },
      (client) => client.adClaims({ appId: "happy-farm" }),
    );
    assert.equal(got[0]?.assurance, "server_verified");
    assert.equal(got[0]?.claimId, "cl_1");
  });

  it("Claim에 transaction 또는 사용자 원본 필드가 섞이면 전체를 거부한다", async () => {
    for (const leaked of [
      { transactionId: "raw-transaction" },
      { platformUserId: "pu_secret" },
      { nested: { signature: "raw-signature" } },
    ]) {
      await assert.rejects(
        () => withClient(
          {
            status: 200,
            body: { ok: true, result: { claims: [{ ...safeClaim, ...leaked }] } },
          },
          (client) => client.adClaims({}),
        ),
        (error: unknown) =>
          error instanceof PlatformApiError && error.code === "platform_response_invalid",
      );
    }
  });

  it("앱 설정의 registry sync 시각과 suffix만 전달한다", async () => {
    const got = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            appId: "happy-farm",
            providers: ["admob", "apps_in_toss"],
            registrySyncedAt: "2026-08-09T00:00:00Z",
            placements: [{
              id: "harvest_boost",
              format: "rewarded",
              providers: { admob: { androidAdUnitSuffix: "1234567890" } },
              reward: { key: "harvest_boost", min_amount: 1, max_amount: 1 },
              dailyLimit: 20,
              cooldownSeconds: 30,
            }],
          },
        },
      },
      (client) => client.adsConfig("happy-farm"),
    );
    assert.equal(got.registrySyncedAt, "2026-08-09T00:00:00Z");
    assert.equal(got.placements[0]?.providers.admob?.androidAdUnitSuffix, "1234567890");
  });
});

describe("환불 검토", () => {
  const reviewId = "a".repeat(64);

  it("민감 필드 없는 앱별 queue만 전달한다", async () => {
    const got = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            appId: "lizard-tycoon",
            environment: "production",
            refundReviews: [
              {
                reviewId,
                appId: "lizard-tycoon",
                expectedEnvironment: "production",
                state: "pending",
                refundReason: 1,
                receivedAt: "2026-08-05T00:00:00Z",
                dueAt: "2026-08-06T00:00:00Z",
              },
            ],
          },
        },
        inspectRequest(input) {
          assert.equal(
            String(input),
            "https://platform-admin.test/v1/admin/apps/lizard-tycoon/iap/refund-reviews?limit=50",
          );
        },
      },
      (c) => c.refundReviews("lizard-tycoon"),
    );
    assert.equal(got[0]?.reviewId, reviewId);
    assert.equal(got[0]?.state, "pending");
  });

  it("queue에 token 또는 ciphertext가 섞이면 전체를 거부한다", async () => {
    await assert.rejects(
      () =>
        withClient(
          {
            status: 200,
            body: {
              ok: true,
              result: {
                appId: "lizard-tycoon",
                environment: "production",
                refundReviews: [
                  {
                    reviewId,
                    appId: "lizard-tycoon",
                    expectedEnvironment: "production",
                    state: "pending",
                    refundReason: 1,
                    receivedAt: "2026-08-05T00:00:00Z",
                    dueAt: "2026-08-06T00:00:00Z",
                    pendingRefundToken: "must-not-cross",
                  },
                ],
              },
            },
          },
          (c) => c.refundReviews("lizard-tycoon"),
        ),
      (error: unknown) =>
        error instanceof PlatformApiError &&
        error.code === "platform_response_invalid",
    );
  });

  it("결정 body에서 경로 필드를 분리하고 target echo를 대조한다", async () => {
    const got = await withClient(
      {
        status: 202,
        body: {
          ok: true,
          result: {
            applied: true,
            requestId: "req-1",
            appId: "lizard-tycoon",
            reviewId,
            expectedEnvironment: "production",
            state: "decided",
            refundPreference: "DECLINE",
            sampleContentProvided: false,
            operation: "refund_review_decision",
          },
        },
        inspectRequest(input, init) {
          assert.equal(
            String(input),
            `https://platform-admin.test/v1/admin/apps/lizard-tycoon/iap/refund-reviews/${reviewId}/decision`,
          );
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          assert.equal(body.appId, undefined);
          assert.equal(body.reviewId, undefined);
          assert.equal(body.sampleContentProvided, false);
          assert.equal(init?.headers && (init.headers as Record<string, string>)["X-Seori-Actor"], "syous");
        },
      },
      (c) =>
        c.decideRefundReview(
          {
            requestId: "req-1",
            appId: "lizard-tycoon",
            reviewId,
            expectedEnvironment: "production",
            refundPreference: "DECLINE",
            sampleContentProvided: false,
            reason: "verified_fulfillment",
            confirmation: `RESPOND REFUND lizard-tycoon ${reviewId} DECLINE`,
          },
          "syous",
        ),
    );
    assert.equal(got.applied, true);
  });

  it("exact replay의 전달 실패 상태도 영구 결정 결과로 전달한다", async () => {
    const got = await withClient(
      {
        status: 202,
        body: {
          ok: true,
          result: {
            applied: false,
            requestId: "req-terminal",
            appId: "lizard-tycoon",
            reviewId,
            expectedEnvironment: "production",
            state: "failed",
            refundPreference: "NEUTRAL",
            sampleContentProvided: false,
            operation: "refund_review_decision",
          },
        },
      },
      (c) =>
        c.decideRefundReview(
          {
            requestId: "req-terminal",
            appId: "lizard-tycoon",
            reviewId,
            expectedEnvironment: "production",
            refundPreference: "NEUTRAL",
            sampleContentProvided: false,
            reason: "insufficient_evidence",
            confirmation: `RESPOND REFUND lizard-tycoon ${reviewId} NEUTRAL`,
          },
          "syous",
        ),
    );
    assert.equal(got.applied, false);
    assert.equal(got.state, "failed");
  });
});

describe("운영자 조작", () => {
  it("지급 결과를 그대로 전달한다", async () => {
    const got = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            applied: true,
            entitlements: ["sp_a"],
            requestId: "req-1",
            appId: "lizard-tycoon",
            platformUserId: "pu_1",
            entitlementId: "sp_a",
            expectedEnvironment: "production",
            operation: "grant",
          },
        },
      },
      (c) =>
        c.grantEntitlement(
          {
            requestId: "req-1",
            platformUserId: "pu_1",
            entitlementId: "sp_a",
            reason: "customer_support_compensation",
            appId: "lizard-tycoon",
            expectedEnvironment: "production",
            confirmation: "GRANT lizard-tycoon pu_1 sp_a",
          },
          "syous",
        ),
    );

    assert.equal(got.applied, true);
    assert.deepEqual(got.entitlements, ["sp_a"]);
  });

  // 이미 처리된 요청은 실패가 아니다. 운영자가 재시도해도 안전하다는 신호다.
  it("멱등 재요청은 applied=false로 온다", async () => {
    const got = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            applied: false,
            entitlements: ["sp_a"],
            requestId: "req-1",
            appId: "lizard-tycoon",
            platformUserId: "pu_1",
            entitlementId: "sp_a",
            expectedEnvironment: "production",
            operation: "revoke",
            grantRequestId: "grant-1",
          },
        },
      },
      (c) =>
        c.revokeEntitlement(
          {
            requestId: "req-1",
            platformUserId: "pu_1",
            entitlementId: "sp_a",
            reason: "incorrect_grant_correction",
            appId: "lizard-tycoon",
            expectedEnvironment: "production",
            confirmation: "REVOKE lizard-tycoon pu_1 sp_a grant-1",
            grantRequestId: "grant-1",
          },
          "syous",
        ),
    );

    assert.equal(got.applied, false);
  });

  it("조작 성공 응답 target이 요청과 다르면 결과 불명으로 분류할 오류를 낸다", async () => {
    await assert.rejects(
      () =>
        withClient(
          {
            status: 200,
            body: {
              ok: true,
              result: {
                applied: true,
                entitlements: ["sp_a"],
                requestId: "other-request",
                appId: "other-app",
                platformUserId: "pu_other",
                entitlementId: "sp_other",
                expectedEnvironment: "sandbox",
                operation: "revoke",
              },
            },
          },
          (c) =>
            c.grantEntitlement(
              {
                requestId: "req-1",
                platformUserId: "pu_1",
                entitlementId: "sp_a",
                reason: "customer_support_compensation",
                appId: "lizard-tycoon",
                expectedEnvironment: "production",
                confirmation: "GRANT lizard-tycoon pu_1 sp_a",
              },
              "syous",
            ),
        ),
      (error: unknown) =>
        error instanceof PlatformApiError &&
        error.code === "platform_response_invalid",
    );
  });

  it("사유가 없으면 플랫폼이 거부한 것을 그대로 올린다", async () => {
    await assert.rejects(
      () =>
        withClient(
          {
            status: 400,
            body: { ok: false, error: { code: "request_invalid", message: "지급 사유가 필요해요" } },
          },
          (c) =>
            c.grantEntitlement(
              {
                requestId: "r",
                platformUserId: "pu_1",
                entitlementId: "sp_a",
                reason: "" as never,
                appId: "a",
                expectedEnvironment: "production",
                confirmation: "GRANT a pu_1 sp_a",
              },
              "syous",
            ),
        ),
      (err: unknown) => {
        assert.ok(err instanceof PlatformApiError);
        assert.equal(err.code, "request_invalid");
        return true;
      },
    );
  });

  it("sandbox reset 응답 PUID가 요청과 다르면 거부한다", async () => {
    await assert.rejects(
      () =>
        withClient(
          {
            status: 200,
            body: {
              ok: true,
              result: { platformUserId: "pu_other", resetOrderKeys: [] },
            },
          },
          (c) =>
            c.resetAppStoreSandbox(
              {
                requestId: "req-1",
                platformUserId: "pu_expected",
                reason: "internal_validation",
                appId: "lizard-tycoon",
                expectedEnvironment: "sandbox",
                confirmation: "RESET lizard-tycoon pu_expected",
                appleClearedConfirmed: true,
              },
              "syous",
            ),
        ),
      (error: unknown) =>
        error instanceof PlatformApiError &&
        error.code === "platform_response_invalid",
    );
  });
});

describe("플랫폼 관리 조회", () => {
  it("sandbox reset durable intent 상태만 대상과 결합해 전달한다", async () => {
    const result = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            requestId: "req-1",
            appId: "lizard-tycoon",
            state: "prepared",
            expectedEnvironment: "sandbox",
            operation: "sandbox_reset",
            platformUserId: "pu_must_not_leak",
            resetOrderKeys: ["order_must_not_leak"],
          },
        },
      },
      (c) => c.sandboxResetStatus("req-1", "lizard-tycoon"),
    );

    assert.deepEqual(result, {
      requestId: "req-1",
      appId: "lizard-tycoon",
      state: "prepared",
      expectedEnvironment: "sandbox",
      operation: "sandbox_reset",
    });
    assert.doesNotMatch(JSON.stringify(result), /pu_must|order_must/);

    const closed = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            requestId: "req-1",
            appId: "lizard-tycoon",
            state: "closed_not_started",
            expectedEnvironment: "sandbox",
            operation: "sandbox_reset",
          },
        },
      },
      (c) => c.sandboxResetStatus("req-1", "lizard-tycoon"),
    );
    assert.equal(closed?.state, "closed_not_started");
  });

  it("sandbox reset status 404만 durable intent absent로 해석한다", async () => {
    const result = await withClient(
      {
        status: 404,
        body: {
          ok: false,
          error: {
            code: "sandbox_reset_not_found",
            message: "not found",
          },
        },
      },
      (c) => c.sandboxResetStatus("req-1", "lizard-tycoon"),
    );
    assert.equal(result, null);

    await assert.rejects(
      () =>
        withClient(
          {
            status: 404,
            body: {
              ok: false,
              error: { code: "other_not_found", message: "not found" },
            },
          },
          (c) => c.sandboxResetStatus("req-1", "lizard-tycoon"),
        ),
      (error: unknown) =>
        error instanceof PlatformApiError && error.code === "other_not_found",
    );
  });

  it("sandbox reset 재개 응답을 requestId와 app에 다시 결합한다", async () => {
    let sent: { url: string; method?: string; body?: string } | undefined;
    const result = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            requestId: "req-1",
            appId: "lizard-tycoon",
            platformUserId: "pu_01J00000000000000000000000",
            expectedEnvironment: "sandbox",
            operation: "sandbox_reset",
            resetOrderKeys: [],
          },
        },
        inspectRequest(input, init) {
          sent = {
            url: String(input),
            method: init?.method,
            body: typeof init?.body === "string" ? init.body : undefined,
          };
        },
      },
      (c) =>
        c.resumeSandboxReset(
          {
            requestId: "req-1",
            appId: "lizard-tycoon",
            confirmation: "RESUME RESET lizard-tycoon req-1",
          },
          "syous",
        ),
    );
    assert.equal(result.requestId, "req-1");
    assert.equal(result.appId, "lizard-tycoon");
    assert.deepEqual(sent, {
      url: "https://platform-admin.test/v1/admin/iap/sandbox-resets/req-1/resume",
      method: "POST",
      body: JSON.stringify({
        appId: "lizard-tycoon",
        confirmation: "RESUME RESET lizard-tycoon req-1",
      }),
    });
  });

  it("sandbox reset 미시작 종료를 write endpoint와 target에 결합한다", async () => {
    let sent: { url: string; method?: string; body?: string } | undefined;
    const result = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            requestId: "req-1",
            appId: "lizard-tycoon",
            state: "closed_not_started",
            expectedEnvironment: "sandbox",
            operation: "sandbox_reset",
            applied: true,
          },
        },
        inspectRequest(input, init) {
          sent = {
            url: String(input),
            method: init?.method,
            body: typeof init?.body === "string" ? init.body : undefined,
          };
        },
      },
      (c) =>
        c.closeSandboxResetNotStarted(
          {
            requestId: "req-1",
            appId: "lizard-tycoon",
            confirmation: "CLOSE RESET lizard-tycoon req-1",
          },
          "syous",
        ),
    );
    assert.equal(result.state, "closed_not_started");
    assert.equal(result.applied, true);
    assert.deepEqual(sent, {
      url: "https://platform-admin.test/v1/admin/iap/sandbox-resets/req-1/close-not-started",
      method: "POST",
      body: JSON.stringify({
        appId: "lizard-tycoon",
        confirmation: "CLOSE RESET lizard-tycoon req-1",
      }),
    });
  });

  it("SKU 없이 정렬된 entitlement ID 목록만 전달한다", async () => {
    const result = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            appId: "lizard-tycoon",
            entitlements: ["premium", "starter"],
          },
        },
      },
      (c) => c.catalogEntitlements("lizard-tycoon"),
    );

    assert.deepEqual(result, {
      appId: "lizard-tycoon",
      entitlements: ["premium", "starter"],
    });
  });

  it("앱별 카탈로그 응답의 appId가 요청과 다르면 거부한다", async () => {
    await assert.rejects(
      () =>
        withClient(
          {
            status: 200,
            body: {
              ok: true,
              result: { appId: "other-app", entitlements: ["premium"] },
            },
          },
          (c) => c.catalogEntitlements("lizard-tycoon"),
        ),
      (error: unknown) =>
        error instanceof PlatformApiError &&
        error.code === "platform_response_invalid",
    );
  });

  it("PII 없는 인증 사용자 결과를 전달한다", async () => {
    const user = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: {
            user: {
              platformUserId: "pu_01JTEST",
              appId: "lizard-tycoon",
              supportCode: "LT-ABC12345",
              isAnonymous: false,
              createdAt: "2026-08-01T00:00:00Z",
              lastSeenAt: "2026-08-02T00:00:00Z",
            },
          },
        },
      },
      (c) => c.user("LT-ABC12345"),
    );

    assert.equal(user.platformUserId, "pu_01JTEST");
    assert.equal(user.supportCode, "LT-ABC12345");
    assert.equal("appUserId" in user, false);
  });

  it("사용자 조회 응답이 요청한 PUID와 다르면 거부한다", async () => {
    await assert.rejects(
      () =>
        withClient(
          {
            status: 200,
            body: {
              ok: true,
              result: {
                user: {
                  platformUserId: "pu_01JWRONG000000000000000000",
                  appId: "lizard-tycoon",
                  supportCode: "LT-ABC12345",
                  isAnonymous: false,
                  createdAt: "2026-08-01T00:00:00Z",
                  lastSeenAt: "2026-08-02T00:00:00Z",
                },
              },
            },
          },
          (c) => c.user("pu_01J00000000000000000000000"),
        ),
      (error: unknown) =>
        error instanceof PlatformApiError &&
        error.code === "platform_response_invalid",
    );
  });

  it("사용자 객체가 없으면 성공으로 오인하지 않는다", async () => {
    await assert.rejects(
      () => withClient({ status: 200, body: { ok: true, result: {} } }, (c) => c.user("x")),
      (err: unknown) => {
        assert.ok(err instanceof PlatformApiError);
        assert.equal(err.code, "platform_response_invalid");
        return true;
      },
    );
  });

  it("entitlement 응답 PUID가 요청과 다르면 거부한다", async () => {
    await assert.rejects(
      () =>
        withClient(
          {
            status: 200,
            body: {
              ok: true,
              result: { platformUserId: "pu_other", entitlements: [] },
            },
          },
          (c) => c.userEntitlements("pu_expected"),
        ),
      (error: unknown) =>
        error instanceof PlatformApiError &&
        error.code === "platform_response_invalid",
    );
  });

  it("점검 모드 결과를 전달한다", async () => {
    const result = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: { appId: "lizard-tycoon", active: true, minutes: 30 },
        },
      },
      (c) => c.setMaintenance("lizard-tycoon", 30, "syous"),
    );

    assert.equal(result.active, true);
    assert.equal(result.minutes, 30);
  });
});
