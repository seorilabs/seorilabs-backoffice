import assert from "node:assert/strict";
import test, { before } from "node:test";
import type { PrismaClient } from "@prisma/client";
const db = {
  app: { findMany: async () => [{ id: "app1", slug: "lizard-tycoon", status: "ACTIVE", aitMiniAppId: 61736, aitWorkspaceId: 38345 }] },
  appConsoleMetricDaily: { upsert: async (input: unknown) => { void input; return {}; } },
  metricCollectionLedger: { findMany: async () => [], upsert: async (input: unknown) => { void input; return {}; } },
};
(globalThis as typeof globalThis & { prisma: PrismaClient }).prisma = db as unknown as PrismaClient;
let ingest: typeof import("./console-metrics-collect").ingestConsoleMetrics;
before(async () => { ({ ingestConsoleMetrics: ingest } = await import("./console-metrics-collect")); });
const day = { date: "2026-10-11", dau: null, newUsers: null, avgSessionSec: 30, iaaImpressions: 0, iaaEarningKrw: 0, iapTrxAmountKrw: 0, iapSettlementKrw: 0, payingUsers: 0 };
const push = (value: unknown, miniAppId = 61736) => ({ apps: [{ slug: "lizard-tycoon", miniAppId, workspaceId: 38345, days: [value] }] });
test("불완전한 행은 신규 생성과 기존 행 덮어쓰기를 모두 보류한다", async (t) => {
  const spy = t.mock.method(db.appConsoleMetricDaily, "upsert");
  for (const change of [{ iapTrxAmountKrw: undefined }, { iaaEarningKrw: NaN }, { iaaImpressions: -1 }, { payingUsers: 0.5 }, { dau: "3" }, { date: "2026-02-30" }, { raw: { access_token: "fixture-only" } }]) {
    const result = await ingest(push({ ...day, ...change }), new Date());
    assert.equal(result.upserts, 0); assert.ok(result.skipped.length + result.errors.length > 0);
  }
  assert.equal(spy.mock.callCount(), 0);
});
test("명시적인 0은 저장하고 DAU null은 보존한다", async (t) => {
  const spy = t.mock.method(db.appConsoleMetricDaily, "upsert");
  const result = await ingest(push(day), new Date()); assert.equal(result.upserts, 1);
  const data = (spy.mock.calls[0].arguments[0] as { update: typeof day }).update;
  assert.equal(data.dau, null); assert.equal(data.iapTrxAmountKrw, 0);
});
test("slug와 다른 리스팅의 ID를 섞으면 저장하지 않는다", async (t) => {
  const spy = t.mock.method(db.appConsoleMetricDaily, "upsert");
  const result = await ingest(push(day, 31877), new Date()); assert.equal(result.upserts, 0); assert.equal(spy.mock.callCount(), 0);
});
test("일반 토큰·비밀 키의 중첩 원본도 저장하지 않는다", async (t) => {
  const spy = t.mock.method(db.appConsoleMetricDaily, "upsert");
  for (const key of ["token", "id_token", "bearer-token", "secret", "clientSecret", "Authorization"]) {
    const result = await ingest(push({ ...day, raw: { nested: [{ [key]: "synthetic-secret" }] } }), new Date());
    assert.equal(result.upserts, 0); assert.ok(result.skipped.length > 0);
  }
  assert.equal(spy.mock.callCount(), 0);
});
test("같은 날짜의 상충하는 행은 입력 순서와 무관하게 전체 제외한다", async (t) => {
  const spy = t.mock.method(db.appConsoleMetricDaily, "upsert");
  for (const days of [[day, { ...day, iaaEarningKrw: 123 }], [{ ...day, iaaEarningKrw: 123 }, day]]) {
    const payload = { apps: [{ slug: "lizard-tycoon", miniAppId: 61736, workspaceId: 38345, days }] };
    const result = await ingest(payload, new Date()); assert.equal(result.upserts, 0); assert.ok(result.skipped.length > 0);
  }
  assert.equal(spy.mock.callCount(), 0);
});
