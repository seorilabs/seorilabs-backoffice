import assert from "node:assert/strict";
import test from "node:test";
import { readQueryResult } from "./query-result";

test("실제 SDK의 세 번째 응답에서 작업·처리량·과금 0과 cache false를 보존한다", async () => {
  const result = await readQueryResult([[{ probe: 1 }], { job: {} }, {
    jobReference: { jobId: "job_probe", location: "asia-northeast3" },
    totalBytesProcessed: "0", totalBytesBilled: "0", cacheHit: false,
  }], async () => { throw new Error("unexpected metadata read"); });
  assert.deepEqual(result.rows, [{ probe: 1 }]);
  assert.deepEqual(result.usage, { jobId: "job_probe", bytesProcessed: "0", bytesBilled: "0", cacheHit: false });
  assert.equal(result.complete, true);
});

test("폴링 응답의 과금이 없으면 같은 작업의 공식 metadata를 읽는다", async () => {
  const calls: unknown[] = [];
  const result = await readQueryResult([[], { job: {} }, { jobReference: { jobId: "job_poll", location: "EU" }, totalBytesProcessed: "123" }], async (id, location) => {
    calls.push([id, location]);
    return { jobReference: { jobId: id }, statistics: { query: { totalBytesProcessed: "123", totalBytesBilled: "10485760", cacheHit: true } } };
  });
  assert.deepEqual(calls, [["job_poll", "EU"]]);
  assert.equal(result.usage.bytesBilled, "10485760");
  assert.equal(result.usage.cacheHit, true);
  assert.equal(result.complete, true);
});

test("비용 metadata 실패는 관측한 행을 잃지 않고 미확인을 0으로 만들지 않는다", async () => {
  const result = await readQueryResult([[{ value: 7 }], null, { jobReference: { jobId: "job_no_usage" }, totalBytesProcessed: "123" }], async () => { throw new Error("permission"); });
  assert.deepEqual(result.rows, [{ value: 7 }]);
  assert.equal(result.usage.bytesProcessed, "123");
  assert.equal(result.usage.bytesBilled, "unknown");
  assert.equal(result.complete, false);
});

test("다른 작업 metadata와 잘못된 과금 값은 채택하지 않는다", async () => {
  const result = await readQueryResult([[], null, { jobReference: { jobId: "job_expected" }, totalBytesProcessed: "-1", totalBytesBilled: "NaN" }], async () => ({ jobReference: { jobId: "job_other" }, statistics: { query: { totalBytesProcessed: "10", totalBytesBilled: "10" } } }));
  assert.equal(result.usage.bytesBilled, "unknown");
  assert.equal(result.complete, false);
  await assert.rejects(readQueryResult([null], async () => null), /BIGQUERY_RESULT_INVALID/);
});
