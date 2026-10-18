import assert from "node:assert/strict";
import test from "node:test";

test("기획 단계의 활성 앱도 리뷰 수집이 없으면 미착지로 표시한다", async () => {
  const app = { id: "planning", slug: "review-fixture", displayName: "테스트",
    status: "ACTIVE", currentStage: "PLANNING", marketTargets: ["PLAY", "APPSTORE"],
    playPackage: "test.package", iosBundle: "test.bundle", firebaseProject: null,
    ga4Dataset: null, aitWorkspaceId: null, aitMiniAppId: null, configRevisions: [],
  };
  const runtime = globalThis as unknown as { prisma: unknown };
  const previous = runtime.prisma;
  runtime.prisma = {
    app: { findMany: async () => [app, { ...app, id: "paused", status: "PAUSED" }] },
    sourceCollectionRun: { findMany: async () => [] },
    metricCollectionLedger: { findMany: async () => [] },
  };
  const { sourceHealth } = await import("./queries");
  let rows;
  try { rows = (await sourceHealth()).rows; } finally { runtime.prisma = previous; }
  const reviews = rows.filter((row) => row.source.startsWith("reviews:"));
  assert.equal(reviews.length, 4);
  assert.deepEqual(reviews.filter((row) => row.appId === "planning").map((row) => row.state), ["not_landed", "not_landed"]);
  assert.deepEqual(reviews.filter((row) => row.appId === "paused").map((row) => row.state), ["not_applicable", "not_applicable"]);
});
