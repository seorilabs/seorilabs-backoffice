import test from "node:test";
import assert from "node:assert/strict";
import { rankCsv } from "./daily-ranks";
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
        attemptState: "수집 실패",
        attemptedAt:"2026-10-11T04:00:00Z",
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
  assert.match(csv,/최근 시도 상태/);
  assert.match(csv,/수집 실패/);
  assert.match(csv, /2026-10-10/);
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
