import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import type { PrismaClient } from "@prisma/client";
let stored: Record<string, unknown> = {};
const db = {
  $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  app: { findMany: async () => [{ id: "app1", slug: "lizard-tycoon", status: "ACTIVE", aitMiniAppId: 61736, aitWorkspaceId: 38345 }] },
  appConsoleMetricDaily: {
    upsert: async (input: unknown) => {
      const data = input as { create: Record<string, unknown>; update: Record<string, unknown> };
      stored = Object.keys(stored).length ? { ...stored, ...data.update } : { ...data.create };
      return stored;
    },
    update: async (input: unknown) => { stored = { ...stored, ...(input as { data: Record<string, unknown> }).data }; return stored; },
  },
  metricCollectionLedger: {
    findMany: async () => [],
    upsert: async (input: unknown) => { void input; return {}; },
    updateMany: async (input: unknown) => { void input; return { count: 0 }; },
    create: async (input: unknown) => { void input; return {}; },
  },
};
(globalThis as typeof globalThis & { prisma: PrismaClient }).prisma = db as unknown as PrismaClient;
let ingest: typeof import("./console-metrics-collect").ingestConsoleMetrics;
before(async () => { ({ ingestConsoleMetrics: ingest } = await import("./console-metrics-collect")); });
beforeEach(() => { stored = {}; });
const day = { date: "2026-10-11", dau: null, newUsers: null, avgSessionSec: 30, iaaImpressions: 0, iaaEarningKrw: 0, iapTrxAmountKrw: 0, iapSettlementKrw: 0, payingUsers: 0 };
const push = (value: unknown, miniAppId = 61736) => ({ apps: [{ slug: "lizard-tycoon", miniAppId, workspaceId: 38345, days: [value] }] });
test("비정상 값·날짜·비밀 원본이 있는 행은 저장하지 않는다", async (t) => {
  const spy = t.mock.method(db.appConsoleMetricDaily, "upsert");
  for (const change of [{ iaaEarningKrw: NaN }, { iaaImpressions: -1 }, { payingUsers: 0.5 }, { dau: "3" }, { date: "2026-02-30" }, { raw: { access_token: "fixture-only" } }]) {
    const result = await ingest(push({ ...day, ...change }), new Date());
    assert.equal(result.upserts, 0); assert.ok(result.skipped.length + result.errors.length > 0);
  }
  assert.equal(spy.mock.callCount(), 0);
});
test("명시적인 0은 저장하고 DAU null은 보존한다", async (t) => {
  const spy = t.mock.method(db.appConsoleMetricDaily, "upsert");
  const result = await ingest(push(day), new Date()); assert.equal(result.upserts, 1);
  const data = (spy.mock.calls[0].arguments[0] as { create: typeof day }).create;
  assert.equal(data.dau, null); assert.equal(data.iapTrxAmountKrw, 0);
});
test("slug와 다른 리스팅의 ID를 섞으면 저장하지 않는다", async (t) => {
  const spy = t.mock.method(db.appConsoleMetricDaily, "upsert");
  const result = await ingest(push(day, 31877), new Date()); assert.equal(result.upserts, 0); assert.equal(spy.mock.callCount(), 0);
});
test("일반 토큰·비밀 키의 중첩 원본도 저장하지 않는다", async (t) => {
  const spy = t.mock.method(db.appConsoleMetricDaily, "upsert");
  for (const key of ["token", "id_token", "bearer-token", "secret", "clientSecret", "Authorization", "auth_token", "session_token", "oauth_token", "x-api-key", "access_key_id"]) {
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

test("부분 행은 null로 생성하고 기존 값은 결측으로 덮어쓰지 않는다", async () => {
  const partial = { date: day.date, dau: 7, avgSessionSec: 8, iaaEarningKrw: 12 };
  const first = await ingest(push(partial), new Date());
  assert.equal(first.upserts, 1);
  assert.equal(stored.dau, 7); assert.equal(stored.iapTrxAmountKrw, null);
  await ingest(push({ date: day.date, dau: null, avgSessionSec: undefined, iapTrxAmountKrw: 25 }), new Date());
  assert.equal(stored.dau, 7); assert.equal(stored.avgSessionSec, 8); assert.equal(stored.iaaEarningKrw, 12); assert.equal(stored.iapTrxAmountKrw, 25);
  await ingest(push({ date: day.date, dau: 0, iaaEarningKrw: 0 }), new Date());
  assert.equal(stored.dau, 0); assert.equal(stored.iaaEarningKrw, 0);
});

test("부분 저장은 관측 완료로 기록하지 않으며 빈 날짜는 생성하지 않는다", async (t) => {
  const ledger = t.mock.method(db.metricCollectionLedger, "upsert");
  const created = t.mock.method(db.metricCollectionLedger, "create");
  await ingest(push({ date: day.date, dau: 5 }), new Date());
  assert.equal(created.mock.callCount(), 1);
  assert.equal((created.mock.calls[0].arguments[0] as { data: { state: string } }).data.state, "failed");
  assert.ok(ledger.mock.calls.every((call) => (call.arguments[0] as { create: { state: string } }).create.state !== "observed"));
  const result = await ingest(push({ date: day.date }), new Date());
  assert.equal(result.upserts, 0);
});

test("직접 push는 실제 채운 지표의 결측 표시만 해소한다", async () => {
  await ingest(push({ ...day, avgSessionSec: undefined, raw: { missingMetrics: ["session", "iap"] } }), new Date());
  const financial = { date: day.date, iaaImpressions: 0, iaaEarningKrw: 0, iapTrxAmountKrw: 0, iapSettlementKrw: 0, payingUsers: 0 };
  await ingest(push(financial), new Date());
  assert.deepEqual((stored.raw as { missingMetrics: string[] }).missingMetrics, ["session"]);
  await ingest(push({ date: day.date, avgSessionSec: 10 }), new Date());
  assert.deepEqual((stored.raw as { missingMetrics: string[] }).missingMetrics, []);
});
