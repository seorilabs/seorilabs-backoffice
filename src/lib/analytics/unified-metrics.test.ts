import { test } from "node:test";
import assert from "node:assert/strict";
import { unifiedMetricRowSchema, metricChange, sumMetricSlices, type MetricSlice } from "./unified-metrics";
import { parseReportFile, appleReportRows, playInstallRows } from "./report-files";

const row = (value: number, metric = "crashes") => unifiedMetricRowSchema.parse({ metric, value, currency: null, dimensions: {}, state: value ? "observed" : "empty", valueStatus: "analyzable" });
const slice = (day: string, value: number): MetricSlice => ({ source: "apple", account: "account", periodStart: day, periodEnd: day, grain: "daily", timeZone: "UTC", subjects: ["one"], row: row(value) });
test("음수·소수 오류 횟수와 null 관측은 거절한다", () => {
  assert.throws(() => row(-1)); assert.throws(() => row(1.5));
  assert.equal(unifiedMetricRowSchema.safeParse({ ...row(1), value: null }).success, false);
});
test("오류 증가는 로우라이트이고 오래된 기준선·중복 날짜를 사용하지 않는다", () => {
  const current = slice("2026-10-18", 20);
  assert.equal(metricChange(current, [11,12,13,14].map((day) => slice(`2026-10-${day}`, 10))), "lowlight");
  assert.equal(metricChange(current, [1,2,3,4].map((day) => slice(`2026-10-0${day}`, 10))), "insufficient");
  assert.equal(metricChange(current, Array(4).fill(slice("2026-10-17", 10))), "insufficient");
});
test("다른 통화·기간·대상은 합산하지 않고 비율은 분자로 계산한다", () => {
  assert.throws(() => sumMetricSlices([slice("2026-10-17", 1), slice("2026-10-18", 1)]));
  assert.throws(() => sumMetricSlices([slice("2026-10-17", 1), { ...slice("2026-10-17", 1), subjects: ["two"] }]));
  const rate = (numerator: number, denominator: number) => ({ ...slice("2026-10-17", 1), row: unifiedMetricRowSchema.parse({ ...row(1), metric: "opt_in", value: numerator / denominator * 100, numerator, denominator }) });
  assert.equal(sumMetricSlices([rate(1, 2), rate(9, 98)]), 10);
});
test("공식 파일에서 빈 값과 확인된 0·UTF16·따옴표를 보존한다", () => {
  const csv = 'Date,Package Name,Daily Device Installs,Daily Device Uninstalls\r\n2026-10-15,com.example.app,0,\r\n';
  const rows = playInstallRows(parseReportFile(Buffer.concat([Buffer.from([255,254]), Buffer.from(csv, "utf16le")]), ","), "com.example.app");
  assert.deepEqual(rows.map((cell) => [cell.row.state, cell.row.value]), [["empty",0],["not_landed",null]]);
  assert.equal(parseReportFile(Buffer.from('A,B\n"line\nline","a""b"\n'), ",")[0].B, 'a"b');
  assert.throws(() => parseReportFile(Buffer.from('A, A\nx,y\n'), ","));
});
test("Apple 대상·필수 열을 검증하고 설치와 다운로드를 분리한다", () => {
  const record = { Date: "2026-10-15", "App Apple Identifier": "123", Counts: "0" };
  assert.equal(appleReportRows("App Downloads Standard", [record], "123", "2026-10-18")[0].row.metric, "store_downloads");
  assert.throws(() => appleReportRows("App Downloads Standard", [record], "456", "2026-10-18"));
  assert.throws(() => appleReportRows("App Downloads Standard", [{ ...record, Counts: "NaN" }], "123", "2026-10-18"));
  const opt = appleReportRows("App Opt In", [{ ...record, "Users Opting-In": "0", "Downloading Users": "10" }], "123", "2026-10-15");
  assert.equal(opt[0].row.state, "empty"); assert.equal(opt[0].row.valueStatus, "provisional");
});
