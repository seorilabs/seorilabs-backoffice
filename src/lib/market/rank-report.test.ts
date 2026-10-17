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

test("압축 그래프는 인접한 목록 밖·미수집을 단일 기호와 범례로 구분한다", async () => {
  const { rankDiscordSvg } = await import("./rank-report");
  const report = makeRankReport([row], [], "2026-10-17", new Date());
  report.items[0].points.at(-1)!.state = "outside";
  const svg = rankDiscordSvg(report);
  assert.match(svg, /○ 결과 목록 밖 · × 미수집 · ! 자료 오류/);
  assert.match(svg, />○<\/text>/);
  assert.match(svg, />×<\/text>/);
  assert.doesNotMatch(svg, />목록 밖<\/text>/);
});

test("지난 추세가 남아 있어도 오늘 순위가 그대로면 지속 변화로 재발송하지 않는다", () => {
  const ranks = [99, 95, 90, 85, 83, 80, 80];
  const history = ranks.map((rank, i) => ({
    appId: "a",
    country: "kr",
    target: row.term,
    day: new Date(`2026-10-${11 + i}`),
    value: { rank },
  }));
  assert.equal(
    makeRankReport(
      [{ ...row, rank: 80, previousRank: 80 }],
      history,
      "2026-10-17",
      new Date(),
    ).items.length,
    0,
  );
});
test("불변 보고서 주소는 전체 snapshot을 구분하고 발행시각만의 차이는 제외한다", async () => {
  const { rankReportKey } = await import("./rank-report");
  const report = makeRankReport([row], [], "2026-10-17", new Date());
  assert.equal(
    rankReportKey(report),
    rankReportKey({ ...report, capturedAt: "other" }),
  );
  assert.notEqual(
    rankReportKey(report),
    rankReportKey({
      ...report,
      rows: [{ ...report.rows[0], state: "미수집" }],
    }),
  );
});
