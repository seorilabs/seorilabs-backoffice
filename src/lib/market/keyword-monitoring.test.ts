import test from "node:test";
import assert from "node:assert/strict";
import { buildKeywordRows } from "./keyword-monitoring";
const app = { id: "app", displayName: "앱", iosBundle: "com.example.app", status: "ACTIVE", revision: 3, countries: ["kr", "us"], keywords: ["키워드", "brand"] };
const observation = (day: string, rank: number | null) => ({ appId: "app", target: "키워드", country: "kr", day: new Date(day), observedAt: new Date(day + "T03:20:00Z"), value: { rank }, sourceUrl: "https://itunes.apple.com/search" });
test("모든 설정 조합을 만들고 이전 자료를 오늘 순위로 둔갑시키지 않는다", () => {
  const rows = buildKeywordRows([app], [observation("2026-10-10", 50)], [], "2026-10-11");
  assert.equal(rows.length, 4);
  assert.equal(rows[0].state, "미수집");
  assert.equal(rows[0].rank, null);
  assert.equal(rows[0].previousRank, 50);
  assert.equal(rows[0].previousDay, "2026-10-10");
});
test("검색 결과 없음은 조회 실패·국가 리스팅 없음과 다르다", () => {
  const attempt = (source: string, target: string, status: string) => ({ appId: "app", source, target, status, startedAt: new Date("2026-10-11T03:20:00Z"), completedAt: new Date("2026-10-11T03:21:00Z") });
  const rows = buildKeywordRows([app], [observation("2026-10-11", null)], [attempt("apple-keyword", "kr:키워드", "observed"), attempt("apple-public-lookup", "com.example.app:us", "empty")], "2026-10-11");
  assert.equal(rows[0].state, "수집됨");
  assert.equal(rows[0].rankLabel, "결과 목록에 없음");
  assert.equal(rows[2].state, "공개 리스팅 미확인");
  const failed = buildKeywordRows([app], [observation("2026-10-11", 36)], [attempt("apple-keyword", "kr:키워드", "failed")], "2026-10-11");
  assert.equal(failed[0].state, "수집 실패");
  assert.equal(failed[0].rankLabel, "수집 실패");
});
test("첫 관측과 순위 변화, 중단 앱을 구분한다", () => {
  const rows = buildKeywordRows([app], [observation("2026-10-11", 36), observation("2026-10-08", 50)], [], "2026-10-11");
  assert.equal(rows[0].change, "14계단 상승");
  assert.equal(rows[0].previousDay, "2026-10-08");
  assert.deepEqual(buildKeywordRows([{ ...app, status: "PAUSED" }], [], [], "2026-10-11"), []);
});
