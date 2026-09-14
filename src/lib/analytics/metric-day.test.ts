import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  metricDayOf,
  lastElapsedMetricDay,
  metricDayStart,
  dbDay,
  toDbDay,
  parseMetricDay,
  shiftMetricDay,
  metricDayWindow,
  metricDaysBetween,
  toGa4TableSuffix,
} from "@/lib/analytics/metric-day";

test("metricDayOf 는 KST 자정에서 날이 넘어간다", () => {
  // 2026-09-13T15:00Z = 2026-09-14 00:00 KST
  assert.equal(metricDayOf(new Date("2026-09-13T14:59:59.999Z")), "2026-09-13");
  assert.equal(metricDayOf(new Date("2026-09-13T15:00:00.000Z")), "2026-09-14");
});

test("lastElapsedMetricDay 는 KST 하루 내내 같은 날을 가리킨다", () => {
  // 옛 latestClosedDay 는 UTC 기준이라 00:00~08:59 KST 구간에서 하루 밀렸다.
  // 그 구간이 바로 /report 와 수동 admin 실행이 기준일을 잃던 곳이다.
  const day = "2026-09-13";
  assert.equal(lastElapsedMetricDay(new Date("2026-09-13T15:00:00.000Z")), day); // 09-14 00:00 KST
  assert.equal(lastElapsedMetricDay(new Date("2026-09-13T23:59:00.000Z")), day); // 09-14 08:59 KST
  assert.equal(lastElapsedMetricDay(new Date("2026-09-14T01:00:00.000Z")), day); // 09-14 10:00 KST (수집 cron)
  assert.equal(lastElapsedMetricDay(new Date("2026-09-14T14:40:00.000Z")), day); // 09-14 23:40 KST (발행 cron)
  // 다음 KST 자정에 비로소 넘어간다.
  assert.equal(lastElapsedMetricDay(new Date("2026-09-14T15:00:00.000Z")), "2026-09-14");
});

test("metricDayStart 는 그 달력일 00:00 KST 의 UTC 시각", () => {
  assert.equal(metricDayStart("2026-09-14").toISOString(), "2026-09-13T15:00:00.000Z");
  // 시각 → 날 → 시각 왕복이 같은 날로 닫힌다.
  const instant = new Date("2026-09-14T07:23:00.000Z");
  assert.equal(metricDayOf(metricDayStart(metricDayOf(instant))), metricDayOf(instant));
});

test("dbDay/toDbDay 는 @db.Date 의 UTC 자정 규약을 왕복한다", () => {
  assert.equal(dbDay(toDbDay("2026-09-14")), "2026-09-14");
  assert.equal(toDbDay("2026-09-14").toISOString(), "2026-09-14T00:00:00.000Z");
});

test("parseMetricDay 는 형식과 실존 달력 날짜를 함께 본다", () => {
  assert.equal(parseMetricDay("2026-09-14"), "2026-09-14");
  assert.equal(parseMetricDay("2026-02-30"), null);
  assert.equal(parseMetricDay("2026-9-4"), null);
  assert.equal(parseMetricDay(""), null);
  assert.equal(parseMetricDay(null), null);
});

test("shiftMetricDay 는 월·연 경계를 넘는다", () => {
  assert.equal(shiftMetricDay("2026-09-01", -1), "2026-08-31");
  assert.equal(shiftMetricDay("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftMetricDay("2028-02-28", 1), "2028-02-29"); // 윤년
});

test("metricDayWindow 는 오래된→최신 순으로 days 개", () => {
  assert.deepEqual(metricDayWindow("2026-09-14", 3), ["2026-09-12", "2026-09-13", "2026-09-14"]);
});

test("metricDaysBetween 은 두 달력일의 일수 차", () => {
  assert.equal(metricDaysBetween("2026-09-14", "2026-09-11"), 3);
  assert.equal(metricDaysBetween("2026-09-14", "2026-09-14"), 0);
});

test("toGa4TableSuffix 는 events_YYYYMMDD 접미사", () => {
  assert.equal(toGa4TableSuffix("2026-09-14"), "20260914");
});

// 소스 계약: UTC 기준 "어제"를 내던 옛 함수가 되살아나면 00:00~08:59 KST 구간에서
// 기준일이 다시 하루 밀린다. 이름만 남아도 실패하게 고정한다.
test("소스 계약: latestClosedDay·kstDayStart 는 코드베이스에 남지 않는다", () => {
  const offenders = ["src/lib/ga4/datasets.ts", "src/lib/core/operations-report.ts"];
  for (const path of offenders) {
    const src = readFileSync(path, "utf8");
    assert.equal(/latestClosedDay|kstDayStart/.test(src), false, `${path} 에 옛 날짜 함수가 남아 있다`);
  }
});

// 시각을 UTC 달력일로 자르는 관용구가 지표 경로에 다시 들어오면 같은 결함이 재발한다.
test("소스 계약: metric-day 바깥에서 시각을 직접 날짜로 자르지 않는다", () => {
  const paths = [
    "src/lib/core/analytics-collect.ts",
    "src/lib/core/metric-highlights.ts",
    "src/lib/core/org-report.ts",
    "src/lib/core/analytics-report.ts",
    "src/lib/report/params.ts",
  ];
  for (const path of paths) {
    const src = readFileSync(path, "utf8");
    assert.equal(
      /toISOString\(\)\.slice\(0,\s*10\)/.test(src),
      false,
      `${path} 는 metricDayOf/dbDay 를 써야 한다`,
    );
  }
});
