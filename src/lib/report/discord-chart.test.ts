import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { reportChartSvg, reportChartPng } from "./discord-chart";
const input = {
  title: "운영 지표",
  days: ["2026-10-05", "2026-10-06", "2026-10-07"],
  series: [{ label: "활성 합계", color: "#2563eb", values: [4, null, 8] }],
  unit: "명",
  source: "GA4 fixture",
};
test("누락 구간을 선으로 잇지 않고 단위·기간·출처를 실제 PNG로 출력함", async () => {
  const svg = reportChartSvg(input);
  assert.doesNotMatch(svg, /<path/);
  assert.equal((svg.match(/<circle/g) ?? []).length, 3);
  assert.match(svg, /미수집/);
  const png = await reportChartPng(input);
  const metadata = await sharp(Buffer.from(png.base64, "base64")).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 960);
});
test("범위를 벗어난 입력·색상 주입·날짜 길이 불일치를 거부함", () => {
  assert.throws(() =>
    reportChartSvg({ ...input, series: [{ ...input.series[0], values: [NaN, 0, 1] }] }),
  );
  assert.throws(() => reportChartSvg({ ...input, days: ["x"] }));
});
