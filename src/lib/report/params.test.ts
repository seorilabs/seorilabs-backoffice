import assert from "node:assert/strict";
import test from "node:test";
import { clampReportDate, parseReportDate, shiftDay } from "@/lib/report/params";

test("형식이 어긋나거나 실존하지 않는 날짜는 조용히 무시한다", () => {
  assert.equal(parseReportDate("2026-08-31"), "2026-08-31");
  for (const raw of [undefined, null, "", "2026-8-31", "20260831", "2026-02-30", "2026-13-01", "다음주"]) {
    assert.equal(parseReportDate(raw), null, String(raw));
  }
});

test("범위 밖 날짜는 redirect 대신 clamp 하고 조정 사실을 알린다", () => {
  const min = "2026-07-01";
  const max = "2026-08-31";
  assert.deepEqual(clampReportDate("2026-08-15", min, max), { date: "2026-08-15", clamped: false });
  assert.deepEqual(clampReportDate("2026-06-01", min, max), { date: min, clamped: true });
  assert.deepEqual(clampReportDate("2026-09-15", min, max), { date: max, clamped: true });
  assert.deepEqual(clampReportDate(min, min, max), { date: min, clamped: false });
  assert.deepEqual(clampReportDate(max, min, max), { date: max, clamped: false });
});

test("전일/익일 이동은 월·연 경계를 넘는다", () => {
  assert.equal(shiftDay("2026-08-31", 1), "2026-09-01");
  assert.equal(shiftDay("2026-09-01", -1), "2026-08-31");
  assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
});
