/**
 * 플랫폼 어댑터 검증.
 *
 * 실제 HTTP는 client.test.ts가 본다. 여기서는 operation 라우팅과
 * 입력 검증, 그리고 게이트 판단을 확인한다.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

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

describe("인수조건", () => {
  const baseInput = {
    requestId: "aop_01JXYZ",
    operation: "iap-ledger.grant-production-entitlement",
    intent: "grant",
    params: { platformUserId: "pu_1", entitlementId: "sp_galaxy_gecko" },
    actorLogin: "syous",
    reason: "CS 보상",
  };

  /**
   * 플랫폼 경로가 켜진 상태를 만든다.
   *
   * async여야 한다. run()의 Promise를 기다리지 않고 env를 되돌리면
   * 클라이언트가 생성되는 시점에는 이미 설정이 사라져 있다.
   */
  async function withPlatformEnv<T>(run: () => Promise<T>): Promise<T> {
    const saved = {
      flag: process.env.FEATURE_PLATFORM_ADMIN,
      url: process.env.PLATFORM_ADMIN_URL,
      key: process.env.PLATFORM_ADMIN_SA_KEY_JSON,
    };
    process.env.FEATURE_PLATFORM_ADMIN = "true";
    process.env.PLATFORM_ADMIN_URL = "https://platform-admin.test";
    process.env.PLATFORM_ADMIN_SA_KEY_JSON = JSON.stringify({
      type: "service_account",
      client_email: "backoffice-admin@seorilabs-platform.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
      token_uri: "https://oauth2.googleapis.com/token",
    });
    try {
      return await run();
    } finally {
      restore("FEATURE_PLATFORM_ADMIN", saved.flag);
      restore("PLATFORM_ADMIN_URL", saved.url);
      restore("PLATFORM_ADMIN_SA_KEY_JSON", saved.key);
    }
  }

  // AC-1: 앱 SA 키 없이 동작한다.
  //
  // 플랫폼 어댑터는 firebase-admin을 import하지 않는다. import하면
  // 앱마다 SA 키를 보관해야 하고, 그것이 이 변경의 이유였다.
  it("AC-1 · 플랫폼 어댑터가 앱 자격증명을 쓰지 않는다", async () => {
    const source = await readFile(
      new URL("./lizard-tycoon-platform.ts", import.meta.url),
      "utf8",
    );

    // 주석에는 나올 수 있다. import 문만 본다.
    const imports = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line))
      .join("\n");

    assert.ok(
      !imports.includes("firebase-admin"),
      "firebase-admin을 import하면 앱 SA 키가 다시 필요해진다",
    );
    assert.ok(
      !source.includes("process.env.LIZARD_TYCOON_APP_OPS_SA_KEY_JSON"),
      "앱 SA 키 환경변수를 읽는다",
    );
    // 대신 플랫폼 클라이언트를 쓴다
    assert.ok(imports.includes("PlatformClient"), "플랫폼 클라이언트를 import하지 않는다");
  });

  // AC-2: requestId가 그대로 플랫폼에 전달된다.
  //
  // 멱등 보장 자체는 플랫폼 원장의 책임이다. 백오피스의 책임은
  // 백오피스가 만든 멱등 키를 변형 없이 넘기는 것이다.
  // 여기서 바꾸면 재시도할 때마다 새 요청이 되어 보상이 중복된다.
  it("AC-2 · requestId를 변형 없이 넘긴다", async () => {
    const { executeLizardTycoonPlatformOperation } = await import(
      "./lizard-tycoon-platform"
    );

    let sentBody: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ok: true, result: { applied: true, entitlements: [] } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      await withPlatformEnv(async () => {
        const mod = await import("../../platform/client");
        // OIDC 발급을 막는다. 실제 Google에 붙지 않는다.
        const proto = mod.PlatformClient.prototype as unknown as Record<string, unknown>;
        const original = proto["request"];
        proto["request"] = async function (
          this: unknown,
          method: string,
          path: string,
          body?: unknown,
        ) {
          sentBody = body as Record<string, unknown>;
          return { applied: true, entitlements: [] };
        };
        try {
          await executeLizardTycoonPlatformOperation(baseInput as never);
        } finally {
          proto["request"] = original;
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(sentBody?.["requestId"], "aop_01JXYZ");
  });

  // AC-3: 사유가 없으면 네트워크를 타기 전에 거부한다.
  //
  // 플랫폼도 거부하지만 왕복을 아끼고, 무엇보다 이유 없는 지급은
  // 나중에 아무도 설명할 수 없다.
  it("AC-3 · 사유가 없으면 거부한다", async () => {
    const { executeLizardTycoonPlatformOperation } = await import(
      "./lizard-tycoon-platform"
    );

    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await withPlatformEnv(async () => {
        await assert.rejects(
          () =>
            executeLizardTycoonPlatformOperation({
              ...baseInput,
              reason: "   ",
            } as never),
          /사유가 필요/,
        );
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(called, false, "사유 없이 네트워크를 탔다");
  });

  // AC-4: 누가 눌렀는지가 플랫폼에 전달된다.
  //
  // 서비스 계정만으로는 사람을 알 수 없다. 플랫폼은 이 값을
  // 감사 원장의 actorLogin에 넣는다.
  it("AC-4 · actorLogin을 X-Seori-Actor로 넘긴다", async () => {
    const { PlatformClient } = await import("../../platform/client");

    let gotActor: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      gotActor = headers["X-Seori-Actor"];
      return new Response(
        JSON.stringify({ ok: true, result: { applied: true, entitlements: [] } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const client = new PlatformClient({
        baseUrl: "https://platform-admin.test",
        serviceAccountJson: JSON.stringify({
          type: "service_account",
          client_email: "x@y.iam.gserviceaccount.com",
          private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
          token_uri: "https://oauth2.googleapis.com/token",
        }),
      });
      const auth = (client as unknown as { auth: Record<string, unknown> }).auth;
      auth["getIdTokenClient"] = async () => ({
        idTokenProvider: { fetchIdToken: async () => "tok" },
      });

      await client.grantEntitlement(
        {
          requestId: "r",
          platformUserId: "pu_1",
          entitlementId: "sp_a",
          reason: "보상",
          appId: "lizard-tycoon",
        },
        "syous",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(gotActor, "syous");
  });
});
