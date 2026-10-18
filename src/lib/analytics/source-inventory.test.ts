import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { metricSourceInventory } from "./source-inventory";

const day = "2026-10-17";
const partialDetail = "확인된 지표만 부분 저장";
async function inventory(source: string, cells: Array<{ state: string; detail?: string }>) {
  const app = { id: "qa-partial", slug: "happy-farm", displayName: "검증 앱", firebaseProject: null, ga4Dataset: null,
    aitWorkspaceId: 38345, aitMiniAppId: 31877, playPackage: null, iosBundle: null, configRevisions: [] };
  const db = {
    app: { findMany: async () => [app] },
    metricCollectionLedger: { findMany: async () => cells.map((cell, index) => ({ ...cell, appId: app.id, source, listingId: 31877 + index, day: new Date(`${day}T00:00:00Z`) })) },
    sourceCollectionRun: { groupBy: async () => [] },
    metricReportBatch: { findMany: async () => [] },
    $queryRaw: async () => [],
  } as unknown as Prisma.TransactionClient;
  const result = (await metricSourceInventory(day, db)).find((row) => row.source === source);
  assert.ok(result);
  return result;
}

test("일부 지표 저장을 확인한 앱인토스 원장은 일부 수집과 기준일을 표시한다", async () => {
  const result = await inventory("ait_console", [{ state: "failed", detail: partialDetail }]);
  assert.equal(result.state, "partial");
  assert.equal(result.dataThrough, day);
  assert.match(result.reason, /일부 지표 확보 1\/1/);
  assert.match(result.reason, /완전 관측 0\/1/);
});
test("완전 관측과 부분 저장이 섞이면 각 확보 범위를 보존한다", async () => {
  const result = await inventory("ait_console", [{ state: "observed" }, { state: "failed", detail: partialDetail }]);
  assert.equal(result.state, "partial");
  assert.equal(result.dataThrough, day);
  assert.match(result.reason, /일부 지표 확보 1\/2/);
  assert.match(result.reason, /완전 관측 1\/2/);
});
test("실제 저장 실패는 일부 수집으로 바꾸지 않는다", async () => {
  const result = await inventory("ait_console", [{ state: "failed", detail: "CONSOLE_STORAGE_FAILED" }]);
  assert.equal(result.state, "failed");
  assert.equal(result.dataThrough, null);
});
test("저장 보류는 저장된 일부 지표로 추정하지 않는다", async () => {
  const result = await inventory("ait_console", [{ state: "failed", detail: "불완전한 지표로 저장 보류" }]);
  assert.equal(result.state, "failed");
  assert.equal(result.dataThrough, null);
});
test("앱인토스 부분 저장의 해석을 GA4 실패에 적용하지 않는다", async () => {
  assert.equal((await inventory("ga4", [{ state: "failed", detail: partialDetail }])).state, "failed");
});
test("미도착을 0이나 부분 저장으로 만들지 않는다", async () => {
  const result = await inventory("ait_console", [{ state: "not_landed" }]);
  assert.equal(result.state, "not_landed");
  assert.equal(result.dataThrough, null);
});
test("완전 관측의 상태와 기준일은 유지한다", async () => {
  const result = await inventory("ait_console", [{ state: "observed" }]);
  assert.equal(result.state, "observed");
  assert.equal(result.dataThrough, day);
});
test("확인된 GA4 0은 원래 empty 상태로 유지한다", async () => {
  const result = await inventory("ga4", [{ state: "empty" }]);
  assert.equal(result.state, "empty");
  assert.equal(result.dataThrough, day);
});
