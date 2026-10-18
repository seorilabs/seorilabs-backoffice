import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { reportChartSvg, reportChartPng, ga4ChartContext } from "./discord-chart";
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

test("긴 의미 세그먼트는 PNG에 그려지는 범례에 전체를 보존하고 차트와 겹치지 않음", async () => {
  const label = "스토어 다운로드 · Download Type: First-time download · Country: United States";
  const svg = reportChartSvg({ ...input, series: [
    { ...input.series[0], label },
    { ...input.series[0], label: label.replace("First-time download", "Redownload") },
    { ...input.series[0], label }, { ...input.series[0], label },
  ] });
  const visible = svg.replace(/<title>.*?<\/title>/g, "");
  const text = visible.replace(/<[^>]*>/g, "");
  assert.match(text, /First-time download/);
  assert.match(text, /Redownload/);
  assert.match(text, /United States/);
  assert.match(visible, /<tspan/);
  const metadata = await sharp(Buffer.from(svg)).metadata();
  assert.ok(metadata.height! > 510);
});

test("부분 관측의 빈 전체 추이는 미관측과 구분하고 확보 범위·합계를 명시함", () => {
  const context = ga4ChartContext({ refDate: "2026-10-17", summary: { ga4: { apps: 2, dau: 208 } },
    apps: [{}, {}, {}], edition: { sources: [
      { source: "ga4", state: "observed", dataThrough: "2026-10-17" },
      { source: "ga4", state: "observed", dataThrough: "2026-10-17" },
      { source: "ga4", state: "not_landed", dataThrough: null },
    ] } });
  const svg = reportChartSvg({ ...input, ...context, series: [{ ...input.series[0], values: [null, null, null] }] });
  assert.match(svg, /전체 합계 미확정/);
  assert.match(svg, /2\/3개 앱/);
  assert.match(svg, /확보분 활성 208명/);
  assert.doesNotMatch(svg, /수집된 값 없음/);
  assert.doesNotMatch(svg, /<path/);
});
