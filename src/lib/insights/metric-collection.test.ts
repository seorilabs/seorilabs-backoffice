import assert from "node:assert/strict";
import test from "node:test";
import { metricCollectionSnapshot, type MetricCollectionPoint } from "./metric-collection-facts";
const point = (day: string, value: number | null, key = "listing-a"): MetricCollectionPoint => ({
  key, label: key, day, metrics: { dau: { label: "활성 사용자", value, unit: "명" } },
});
test("같은 출처·리스팅의 전일 값만 비교하고 미제공 값을 0으로 만들지 않는다", () => {
 const made = metricCollectionSnapshot("ait_console", "2026-11-03", "partial", [point("2026-11-02", 10), point("2026-11-03", 15), point("2026-11-03", null, "listing-b")]);
 assert.match(JSON.stringify(made.facts), /10.*15/);
 assert.doesNotMatch(JSON.stringify(made.facts), /listing-b.*0명/);
 assert.equal(made.queued, false);
});
test("전체 실패·기준일 미착지·관측된 0·변화 없음을 구분한다", () => {
 const make = (state: string, points: MetricCollectionPoint[]) => JSON.stringify(metricCollectionSnapshot("ga4", "2026-11-03", state, points).facts);
 assert.match(make("failed", []), /수집 실패/);
 assert.match(make("partial", [point("2026-11-02", 10)]), /판단할 자료 부족/);
 assert.match(make("observed", [point("2026-11-02", 0), point("2026-11-03", 0)]), /주요 변화 없음/);
 assert.match(make("observed", [point("2026-11-03", 0)]), /0명/);
 assert.doesNotMatch(make("observed", [point("2026-11-03", 0)]), /전일 0/);
});

test("비교 자료가 없는 지표가 섞여도 비교 가능한 값이 같으면 변화라고 하지 않는다", () => {
 const made=metricCollectionSnapshot("ga4","2026-11-03","partial",[
   point("2026-11-02",10),point("2026-11-03",10),point("2026-11-03",5,"new-listing"),
 ]);
 assert.match(made.facts.find(fact=>fact.id==="conclusion")!.value,/주요 변화 없음/);
});
