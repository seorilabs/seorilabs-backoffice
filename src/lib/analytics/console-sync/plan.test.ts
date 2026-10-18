import assert from "node:assert/strict";
import test from "node:test";
import type { ConsoleSyncStatus } from "@/lib/core/console-metrics-collect";
import { consoleCollectionPlan } from "./plan";
const status = (apps: ConsoleSyncStatus["apps"]): ConsoleSyncStatus => ({ apps, minLastDate: null, maxLastDate: null, appsWithNoData: [] });
const app = (miniAppId: number, lastDate: string | null, rows = 1) => ({ slug: "crossword-puzzle", miniAppId, lastDate, rows, lastCollectedAt: null });
test("KST 어제와 두 리스팅의 overlap을 독립 계산한다", () => {
  const plan = consoleCollectionPlan(status([app(36555, "2026-10-10"), app(56407, "2026-10-11")]), new Date("2026-10-11T15:01:00Z"));
  assert.equal(plan.end, "2026-10-11"); assert.equal(plan.windows.length, 2); assert.equal(plan.windows[0].start, "2026-10-08"); assert.notEqual(plan.windows[0].miniAppId, plan.windows[1].miniAppId);
});
test("출시일부터 120일씩 나누고 미확인 출시·리스팅·미래 날짜는 차단한다", () => {
  const now = new Date("2026-10-12T01:00:00Z"); const noData = app(36555, null, 0);
  assert.equal(consoleCollectionPlan(status([noData]), now).blocked.length, 1);
  const plan = consoleCollectionPlan(status([noData]), now, { "crossword-puzzle#36555": "2026-01-01" });
  assert.equal(plan.windows[0].end, "2026-04-30"); assert.equal(plan.windows[1].start, "2026-05-01"); assert.equal(plan.windows.at(-1)?.end, "2026-10-11");
  assert.equal(consoleCollectionPlan(status([app(999, null, 0), app(56407, "2026-10-13")]), now).blocked.length, 2);
});

test("최신 부분 행이 전진해도 오래된 미확인 날짜를 다시 조회한다", () => {
  const one = { ...app(56407, "2026-10-19"), firstIncompleteDate: "2026-10-06" };
  const plan = consoleCollectionPlan(status([one]), new Date("2026-10-20T01:00:00Z"));
  assert.equal(plan.windows[0].start, "2026-10-06"); assert.equal(plan.windows[0].end, "2026-10-19");
});

test("기존 리스팅의 자동 재조회는 누락이나 수집 지연이 오래돼도 최근 14일로 제한한다", () => {
  const now = new Date("2026-10-20T01:00:00Z");
  for (const lastDate of ["2026-10-19", "2026-01-01"]) {
    const one = { ...app(56407, lastDate), firstIncompleteDate: "2026-01-01" };
    const plan = consoleCollectionPlan(status([one]), now);
    assert.equal(plan.windows.length, 1);
    assert.equal(plan.windows[0].start, "2026-10-06");
    assert.equal(plan.windows[0].end, "2026-10-19");
  }
});
