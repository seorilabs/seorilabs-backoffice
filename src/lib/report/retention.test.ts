import assert from "node:assert/strict";
import test from "node:test";
import { reportD1Retention } from "./retention";
test("전전일 성숙 코호트의 실제 분모·복귀 수로 D1을 합산하고 미수집 앱은 제외함", () => {
  const report = reportD1Retention(
    "2026-10-07",
    [
      {
        rowsDesc: [
          { date: new Date("2026-10-07"), cohortUsers: 90, d1Users: null },
          { date: new Date("2026-10-06"), cohortUsers: 10, d1Users: 3 },
        ],
      },
      { rowsDesc: [{ date: new Date("2026-10-06"), cohortUsers: null, d1Users: null }] },
    ],
    2,
  );
  assert.equal(report.cohortDate, "2026-10-06");
  assert.equal(report.users, 10);
  assert.equal(report.d1Pct, 30);
  assert.equal(report.observedApps, 1);
});
