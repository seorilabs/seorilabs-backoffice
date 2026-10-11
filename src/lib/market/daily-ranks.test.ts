import test from "node:test";
import assert from "node:assert/strict";
import { rankCsv, dailyRankPayload } from "./daily-ranks";
import type { KeywordRow } from "./keyword-monitoring";
const row: KeywordRow = { appId: "app", appName: "머지 함대", country: "kr", term: "해전", revision: 2, state: "수집됨", rank: 36, rankLabel: "36위", previousRank: 50, previousDay: "2026-10-10", change: "14계단 상승", observedAt: new Date("2026-10-11T03:20:00Z"), sourceUrl: "https://itunes.apple.com/search" };
test("전체 CSV에는 변화 없는 행·미수집도 포함하고 수식·따옴표·개행을 안전하게 기록한다", () => {
  const csv = rankCsv([row, { ...row, term: '=HYPERLINK("x")\n키워드', state: "미수집", rankLabel: "미수집", observedAt: null }], "2026-10-11");
  assert.ok(csv.startsWith("\ufeff"));
  assert.match(csv, /머지 함대/);
  assert.match(csv, /'\=HYPERLINK\(""x""\)/);
  assert.match(csv, /미수집/);
  assert.match(csv, /2026-10-10/);
});
test("111조합의 첨부를 자르지 않고 카드에는 앱별 현황·변화·전체표 링크를 넣는다", () => {
  const rows = Array.from({ length: 111 }, (_, i) => ({ ...row, appId: `app${i % 12}`, appName: `앱${i % 12}`, term: `키워드${i}` }));
  const payload = dailyRankPayload(rows, "2026-10-11", new Date("2026-10-11T03:40:00Z"), "https://backoffice.example");
  assert.match(payload.text, /12개 앱 · 111조합/);
  assert.match(payload.text, /#daily-search-ranks/);
  assert.ok(payload.text.length < 5000);
  assert.equal(Buffer.from(payload.attachment.base64, "base64").toString("utf8").split("\r\n").length, 113);
});
