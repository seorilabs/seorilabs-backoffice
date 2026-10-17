import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRankReport, rankReportSvg, rankReportText } from "./rank-report";
import type { KeywordRow } from "./keyword-monitoring";
const row: KeywordRow = {
  appId: "a",
  appName: "삼국지 풍운록",
  country: "kr",
  term: "three kingdoms",
  revision: 1,
  state: "수집됨",
  rank: 68,
  rankLabel: "68위",
  previousRank: 140,
  previousDay: "2026-10-16",
  change: "72계단 상승",
  observedAt: new Date("2026-10-17T12:20:00Z"),
  sourceUrl: "https://itunes.apple.com/search",
};
test("140→68 상위100 진입은 보고하되 하위권 이동·첫 관측·수집 실패는 제외", () => {
  const report = makeRankReport(
    [
      row,
      { ...row, rank: 130, previousRank: 199 },
      { ...row, previousDay: null },
      { ...row, state: "수집 실패" },
    ],
    [],
    "2026-10-17",
    new Date(),
  );
  assert.equal(report.items.length, 1);
  assert.match(report.items[0].reason, /100.*진입/);
  assert.match(rankReportText(report, "https://example.com"), /140위.*68위/);
});
test("없는 날과 결과 목록 밖을 201위로 그리지 않고 국가·검색어를 보존", () => {
  const report = makeRankReport(
    [row],
    [
      {
        appId: "a",
        country: "kr",
        target: row.term,
        day: new Date("2026-10-16"),
        value: { rank: null },
      },
    ],
    "2026-10-17",
    new Date(),
  );
  assert.equal(report.items[0].points.at(-2)?.state, "outside");
  assert.equal(report.items[0].points.at(-1)?.state, "missing");
  const svg = rankReportSvg(report);
  assert.match(svg, /목록 밖/);
  assert.match(svg, /미수집/);
  assert.doesNotMatch(svg, />201</);
  assert.match(svg, /KR · three kingdoms/);
});
