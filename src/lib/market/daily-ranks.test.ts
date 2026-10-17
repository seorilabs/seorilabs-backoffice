import test from "node:test";
import assert from "node:assert/strict";
import { rankCsv, dailyRankPayload } from "./daily-ranks";
import type { KeywordRow } from "./keyword-monitoring";
const row: KeywordRow = {
  appId: "app",
  appName: "머지 함대",
  country: "kr",
  term: "해전",
  revision: 2,
  state: "수집됨",
  rank: 36,
  rankLabel: "36위",
  previousRank: 50,
  previousDay: "2026-10-10",
  change: "14계단 상승",
  observedAt: new Date("2026-10-11T03:20:00Z"),
  sourceUrl: "https://itunes.apple.com/search",
};
test("전체 CSV에는 변화 없는 행·미수집도 포함하고 수식·따옴표·개행을 안전하게 기록한다", () => {
  const csv = rankCsv(
    [
      row,
      {
        ...row,
        term: '=HYPERLINK("x")\n키워드',
        state: "미수집",
        rankLabel: "미수집",
        observedAt: null,
      },
    ],
    "2026-10-11",
  );
  assert.ok(csv.startsWith("\ufeff"));
  assert.match(csv, /머지 함대/);
  assert.match(csv, /'\=HYPERLINK\(""x""\)/);
  assert.match(csv, /미수집/);
  assert.match(csv, /2026-10-10/);
});
test("중요한 비교 최대 3개와 이미지 생성용 고정 자료·전체 보고서 버튼을 보낸다", () => {
  const rows = Array.from({ length: 111 }, (_, i) => ({
    ...row,
    rank: 18,
    previousRank: 50,
    appId: `app${i}`,
    appName: `앱${i}`,
    term: `키워드${i}`,
  }));
  const payload = dailyRankPayload(
    rows,
    "2026-10-11",
    new Date("2026-10-11T12:40:00Z"),
    "https://backoffice.example",
  );
  assert.doesNotMatch(payload.text, /111조합|수집 [0-9]/);
  assert.match(payload.text, /50위.*18위/);
  assert.equal(payload.rankReport.rows.length, 111);
  assert.equal(payload.components[0].components[0].style, 5);
  assert.match(payload.components[0].components[0].url, /rank-reports/);
});

test("명시적 발행 기준일은 유효한 과거·당일만 허용한다", async () => {
  const { sendDailyKeywordRanks } = await import("./daily-ranks");
  const now = new Date("2026-10-18T01:00:00Z");
  for (const day of ["2026-02-30", "2026-10-19", "not-a-date"])
    await assert.rejects(
      () => sendDailyKeywordRanks(now, day),
      /INVALID_REPORT_DAY/,
    );
});
