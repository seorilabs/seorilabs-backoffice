import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import {
  cancelAppStoreReviewSubmission,
  removeAppStoreReviewSubmissionItem,
  submitAppStoreForReview,
} from "@/lib/app-store/submit";

const BUNDLE_ID = "com.seorilabs.lizardtycoon";
const VERSION = "1.1.6";

/** ASC 요청 1건의 기록. 상태 가드가 실제로 write 를 막았는지 보려면 메서드까지 봐야 한다. */
interface AscCall {
  method: string;
  path: string;
  body: string;
}

/**
 * ASC 는 ES256 JWT 를 요구하므로 테스트용 P-256 키를 그때그때 만든다.
 * 실제 자격증명을 쓰지 않고 mintToken 경로를 그대로 통과시키기 위한 것.
 */
function ascEnv(): Record<string, string> {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    APP_STORE_CONNECT_API_KEY_ID: "TESTKEYID",
    APP_STORE_CONNECT_ISSUER_ID: "00000000-0000-0000-0000-000000000000",
    APP_STORE_CONNECT_PRIVATE_KEY_BASE64: Buffer.from(
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ).toString("base64"),
  };
}

/**
 * ASC 응답을 라우팅으로 세운다.
 * - 앱 조회 → app-1
 * - 버전 조회 → version-1
 * - 열린 제출 목록 → submissions
 * - 제출 항목 조회 → 그 제출이 들고 있는 버전 id 목록
 */
async function withAsc(
  fixture: {
    versionState?: string;
    submissions: Array<{ id: string; state: string }>;
    itemsBySubmission?: Record<string, Array<{ id: string; versionId: string }>>;
  },
  run: (calls: AscCall[]) => Promise<void>,
): Promise<void> {
  const env = ascEnv();
  const previousEnv = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const previousFetch = globalThis.fetch;
  const calls: AscCall[] = [];

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    calls.push({ method: String(init?.method ?? "GET"), path, body: String(init?.body ?? "") });

    const json = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (url.pathname === "/v1/apps") return json([{ id: "app-1", type: "apps" }]);
    if (url.pathname === "/v1/apps/app-1/appStoreVersions") {
      return json([
        {
          id: "version-1",
          type: "appStoreVersions",
          attributes: { appStoreState: fixture.versionState ?? "PREPARE_FOR_SUBMISSION" },
        },
      ]);
    }
    if (url.pathname === "/v1/reviewSubmissions") {
      return json(
        fixture.submissions.map((s) => ({
          id: s.id,
          type: "reviewSubmissions",
          attributes: { state: s.state },
        })),
      );
    }
    const items = url.pathname.match(/^\/v1\/reviewSubmissions\/([^/]+)\/items$/);
    if (items) {
      return json(
        (fixture.itemsBySubmission?.[items[1]] ?? []).map((item) => ({
          id: item.id,
          type: "reviewSubmissionItems",
          relationships: { appStoreVersion: { data: { id: item.versionId, type: "appStoreVersions" } } },
        })),
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    await run(calls);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of previousEnv) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const opts = { bundleId: BUNDLE_ID, marketingVersion: VERSION };

test("심사 생성 후 READY_FOR_REVIEW 버전을 실제 심사에 제출한다", async () => {
  await withAsc(
    {
      versionState: "READY_FOR_REVIEW",
      submissions: [{ id: "sub-1", state: "READY_FOR_REVIEW" }],
      itemsBySubmission: { "sub-1": [{ id: "item-1", versionId: "version-1" }] },
    },
    async (calls) => {
      const result = await submitAppStoreForReview(opts);
      assert.deepEqual(result, {
        reviewSubmissionId: "sub-1",
        versionId: "version-1",
        submitted: true,
      });
      const patch = calls.find(
        (call) => call.method === "PATCH" && call.path === "/v1/reviewSubmissions/sub-1",
      );
      assert.ok(patch, "미제출 reviewSubmission 을 제출한다");
      assert.deepEqual(JSON.parse(patch.body).data.attributes, { submitted: true });
      assert.ok(
        !calls.some((call) => call.method === "POST" && call.path === "/v1/reviewSubmissionItems"),
        "이미 연결된 심사 항목을 중복 생성하지 않는다",
      );
    },
  );
});

test("이미 심사 대기 중인 앱 버전은 다시 제출하지 않는다", async () => {
  await withAsc(
    {
      versionState: "WAITING_FOR_REVIEW",
      submissions: [{ id: "sub-1", state: "WAITING_FOR_REVIEW" }],
      itemsBySubmission: { "sub-1": [{ id: "item-1", versionId: "version-1" }] },
    },
    async (calls) => {
      await assert.rejects(submitAppStoreForReview(opts), /WAITING_FOR_REVIEW/);
      assert.ok(!calls.some((call) => call.method === "PATCH"));
    },
  );
});

test("심사 삭제는 미제출 항목만 지운다", async () => {
  await withAsc(
    {
      submissions: [{ id: "sub-1", state: "READY_FOR_REVIEW" }],
      itemsBySubmission: { "sub-1": [{ id: "item-1", versionId: "version-1" }] },
    },
    async (calls) => {
      const result = await removeAppStoreReviewSubmissionItem(opts);
      assert.equal(result.removed, true);
      assert.ok(
        calls.some((c) => c.method === "DELETE" && c.path === "/v1/reviewSubmissionItems/item-1"),
        "미제출 항목은 DELETE 로 제거한다",
      );
    },
  );
});

test("이미 제출된 심사는 삭제하지 않고 제출 취소를 안내한다", async () => {
  for (const state of ["WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES", "COMPLETING"]) {
    await withAsc(
      {
        submissions: [{ id: "sub-1", state }],
        itemsBySubmission: { "sub-1": [{ id: "item-1", versionId: "version-1" }] },
      },
      async (calls) => {
        await assert.rejects(
          removeAppStoreReviewSubmissionItem(opts),
          (e: Error) => e.message.includes(state) && e.message.includes("제출 취소"),
          state,
        );
        assert.ok(!calls.some((c) => c.method === "DELETE"), `${state}: 삭제 요청을 보내지 않는다`);
      },
    );
  }
});

test("삭제할 항목이 없으면 요청을 보내지 않는다", async () => {
  await withAsc({ submissions: [] }, async (calls) => {
    await assert.rejects(removeAppStoreReviewSubmissionItem(opts), /삭제할 심사 항목이 없습니다/);
    assert.ok(!calls.some((c) => c.method === "DELETE"));
  });
});

test("제출 취소는 심사 대기·진행 중인 제출만 회수한다", async () => {
  for (const state of ["WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES"]) {
    await withAsc(
      {
        submissions: [{ id: "sub-9", state }],
        itemsBySubmission: { "sub-9": [{ id: "item-1", versionId: "version-1" }] },
      },
      async (calls) => {
        const result = await cancelAppStoreReviewSubmission(opts);
        assert.equal(result.reviewSubmissionId, "sub-9");
        const patch = calls.find(
          (c) => c.method === "PATCH" && c.path === "/v1/reviewSubmissions/sub-9",
        );
        assert.ok(patch, `${state}: 취소 PATCH 를 보낸다`);
        assert.deepEqual(JSON.parse(patch.body).data.attributes, { canceled: true });
      },
    );
  }
});

test("아직 제출하지 않았거나 ASC 가 처리 중인 심사는 취소하지 않는다", async () => {
  for (const state of ["READY_FOR_REVIEW", "CANCELING", "COMPLETING"]) {
    await withAsc(
      {
        submissions: [{ id: "sub-9", state }],
        itemsBySubmission: { "sub-9": [{ id: "item-1", versionId: "version-1" }] },
      },
      async (calls) => {
        await assert.rejects(
          cancelAppStoreReviewSubmission(opts),
          (e: Error) => e.message.includes(state),
          state,
        );
        assert.ok(!calls.some((c) => c.method === "PATCH"), `${state}: 취소 요청을 보내지 않는다`);
      },
    );
  }
});

test("취소할 제출이 아예 없으면 요청을 보내지 않는다", async () => {
  await withAsc({ submissions: [] }, async (calls) => {
    await assert.rejects(cancelAppStoreReviewSubmission(opts), /취소할 심사 제출이 없습니다/);
    assert.ok(!calls.some((c) => c.method === "PATCH"));
  });
});

test("심사 항목 조회는 to-one 관계를 include 해 버전을 식별한다", async () => {
  // ASC 는 include 로 요청하지 않은 관계에 data 를 넣지 않는다. 빠지면 항목을 영영 못 찾는다.
  await withAsc(
    {
      submissions: [{ id: "sub-1", state: "READY_FOR_REVIEW" }],
      itemsBySubmission: { "sub-1": [{ id: "item-1", versionId: "version-1" }] },
    },
    async (calls) => {
      await removeAppStoreReviewSubmissionItem(opts);
      const itemsCall = calls.find((c) => c.path.startsWith("/v1/reviewSubmissions/sub-1/items"));
      assert.ok(itemsCall);
      assert.match(itemsCall.path, /include=appStoreVersion/);
    },
  );
});

test("여러 열린 제출 중 이 버전을 담은 제출을 상태 판단 근거로 삼는다", async () => {
  await withAsc(
    {
      submissions: [
        { id: "sub-old", state: "COMPLETING" },
        { id: "sub-mine", state: "WAITING_FOR_REVIEW" },
      ],
      itemsBySubmission: {
        "sub-old": [{ id: "item-old", versionId: "version-0" }],
        "sub-mine": [{ id: "item-mine", versionId: "version-1" }],
      },
    },
    async (calls) => {
      // 목록 첫 건(COMPLETING)이 아니라 이 버전이 들어 있는 제출을 취소해야 한다.
      const result = await cancelAppStoreReviewSubmission(opts);
      assert.equal(result.reviewSubmissionId, "sub-mine");
      assert.ok(calls.some((c) => c.method === "PATCH" && c.path === "/v1/reviewSubmissions/sub-mine"));
    },
  );
});
