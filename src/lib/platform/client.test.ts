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
  reply: { status: number; body: unknown; raw?: string },
  run: (client: import("./client").PlatformClient) => Promise<T>,
): Promise<T> {
  const { PlatformClient } = await import("./client");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => {
    const text = reply.raw !== undefined ? reply.raw : JSON.stringify(reply.body);
    return new Response(text, {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

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
      { status: 200, body: { ok: true, result: { orders: [] } } },
      (c) => c.recentOrders(),
    );
    assert.deepEqual(got, []);
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

describe("운영자 조작", () => {
  it("지급 결과를 그대로 전달한다", async () => {
    const got = await withClient(
      { status: 200, body: { ok: true, result: { applied: true, entitlements: ["sp_a"] } } },
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
      { status: 200, body: { ok: true, result: { applied: false, entitlements: ["sp_a"] } } },
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
});

describe("플랫폼 관리 조회", () => {
  it("SKU 없이 정렬된 entitlement ID 목록만 전달한다", async () => {
    const result = await withClient(
      {
        status: 200,
        body: {
          ok: true,
          result: { entitlements: ["premium", "starter"] },
        },
      },
      (c) => c.catalogEntitlements(),
    );

    assert.deepEqual(result, ["premium", "starter"]);
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
