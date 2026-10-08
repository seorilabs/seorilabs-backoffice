import test from "node:test";
import assert from "node:assert/strict";
import { vitalsWindow, vitalsDataThrough } from "./android-vitals";
test("Vitals는 provider의 exclusive end 날짜와 LA 시간대를 사용함", () => {
  assert.deepEqual(vitalsWindow({ year: 2026, month: 10, day: 1 }).startTime, {
    year: 2026,
    month: 9,
    day: 30,
    timeZone: { id: "America/Los_Angeles" },
  });
  assert.equal(vitalsWindow({ year: 2026, month: 10, day: 1 }).endTime.day, 1);
});

test("Vitals 데이터 끝은 수집 시각 대신 LA 공급자 날짜와 DST 자정으로 변환함",()=>{
 assert.equal(vitalsDataThrough({year:2026,month:10,day:8}).toISOString(),"2026-10-08T07:00:00.000Z");
 assert.equal(vitalsDataThrough({year:2026,month:3,day:8}).toISOString(),"2026-03-08T08:00:00.000Z");
 assert.equal(vitalsDataThrough({year:2026,month:11,day:1}).toISOString(),"2026-11-01T07:00:00.000Z");
});
