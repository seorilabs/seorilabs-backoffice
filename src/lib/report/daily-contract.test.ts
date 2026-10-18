import test from "node:test";
import assert from "node:assert/strict";
import { dailyReportSchedule, publicationState, coverageSummary, type SourceCoverage } from "./daily-contract";

test("컷오프와 발행은 한국 달력의 10:45·11:00이며 UTC 날짜와 섞이지 않는다", () => {
  const schedule = dailyReportSchedule(new Date("2026-10-17T15:01:00Z"));
  assert.equal(schedule.refDate, "2026-10-17");
  assert.equal(schedule.cutoffAt.toISOString(), "2026-10-18T01:45:00.000Z");
  assert.equal(schedule.dueAt.toISOString(), "2026-10-18T02:00:00.000Z");
});

test("발행·정정·지연은 수집 완결 상태와 독립이다", () => {
  const due = "2026-10-18T02:00:00Z";
  assert.equal(publicationState(due, undefined), "발행 대기");
  assert.equal(publicationState(due, due), "정시 발행");
  assert.equal(publicationState(due, "2026-10-18T02:01:00Z"), "발행 지연");
  assert.equal(publicationState(due, due, 1), "정정");
});

test("빈 응답·권한 필요·일부 수집은 확인된 0과 다르다", () => {
  const sources = ["observed", "empty", "not_landed", "partial", "needs_input", "not_applicable"]
    .map((state) => ({ state }) as SourceCoverage);
  assert.deepEqual(coverageSummary(sources), { expected: 5, observed: 2 });
});
