import test from "node:test";
import assert from "node:assert/strict";
import { buildKeywordHistory, normalizeKeywordSelection, decodeRank, keywordHistoryUrl, rankY } from "./keyword-history";
import { splitSegmentsOnNull } from "@/lib/report/chart-geometry";

const app = { id: "app", displayName: "앱", iosBundle: "com.example.app", status: "ACTIVE", revision: 3, countries: ["kr", "us"], keywords: ["해전", "brand"] };
const now = new Date("2026-10-12T14:00:00Z");
const observation = (day: string, value: unknown, term = "해전") => ({ appId: "app", target: term, country: "kr", day: new Date(day), observedAt: new Date(day + "T12:20:00Z"), value, sourceUrl: "https://itunes.apple.com/search" });
const attempt = (status: string, at: string, target = "kr:해전", source = "apple-keyword") => ({ appId: "app", source, target, status, startedAt: new Date(at), completedAt: new Date(at) });
const selection = (params = {}) => normalizeKeywordSelection([app], params, now);
const history = (observations: ReturnType<typeof observation>[], attempts: ReturnType<typeof attempt>[] = [], params = {}) => buildKeywordHistory(app, selection(params), observations, attempts, now);

test("AC-2: 잘못된 입력·미래 날짜·숨겨진 앱을 안전한 현재 범위로 바꾼다", () => {
  const s = selection({ app: "hidden", country: "xx", date: "2026-02-30", days: "999", term: ["다른 검색어", "brand"] });
  assert.deepEqual([s.appId, s.country, s.day, s.days, s.terms, s.notice], ["app", "kr", "2026-10-12", 30, ["brand"], true]);
  assert.equal(selection({ date: "2026-10-13" }).day, "2026-10-12");
  assert.equal(selection({ term: "" }).terms.length, 0);
});
test("AC-3/4: 명시적 null·형식 오류·미수집을 구분한다", () => {
  const h = history([observation("2026-10-10", { rank: null }), observation("2026-10-11", { rank: 201 })], [], { days: "7", term: "해전" });
  assert.equal(h.dates.length, 7);
  assert.deepEqual(h.series[0].points.slice(-3).map(p => [p.rank, p.label]), [[null, "결과 목록에 없음"], [null, "관측 형식 확인 필요"], [null, "미수집"]]);
});
test("AC-5: 성공 관측 뒤 재시도 실패를 순위와 분리해 보존", () => {
  const h = history([observation("2026-10-12", { rank: 1 })], [attempt("failed", "2026-10-12T13:00:00Z")]);
  assert.equal(h.series[0].points.at(-1)?.rank, 1);
  assert.equal(h.series[0].points.at(-1)?.attemptState, "수집 실패");
});
test("AC-6: 전날 가정 없이 이전 성공 날짜 비교, KST 경계와 미래 시도 제외", () => {
  const h = history([observation("2026-09-01", { rank: 50 }), observation("2026-10-12", { rank: 36 })], [attempt("failed", "2026-10-12T15:00:00Z")]);
  assert.equal(h.rows[0].change, "14계단 상승");
  assert.equal(h.rows[0].previousDay, "2026-09-01");
  assert.equal(h.series[0].points.at(-1)?.attemptState, null);
  const missing = history([], [attempt("failed", "2026-10-11T15:10:00Z")]);
  assert.equal(missing.series[0].points.at(-1)?.label, "수집 실패");
});
test("AC-4: 국가 리스팅 없음과 조회 실패를 구분", () => {
  const h = history([], [attempt("empty", "2026-10-12T12:20:00Z", "com.example.app:kr", "apple-public-lookup")]);
  assert.equal(h.series[0].points.at(-1)?.label, "공개 리스팅 미확인");
});
test("AC-9/10: 앱·국가·기간 밖의 관측 무시, 선택 최대 네 개", () => {
  const h = history([{ ...observation("2026-10-12", { rank: 2 }), country: "us" }]);
  assert.equal(h.rows[0].rank, null);
  const many = { ...app, keywords: ["a", "b", "c", "d", "e"] };
  const s = normalizeKeywordSelection([many], { term: many.keywords }, now);
  assert.equal(s.terms.length, 4);
});

test("AC-3/7: 잘못된 값을 선으로 연결하지 않고 1위·200위 축과 선택 해제 URL을 보존", () => {
  for (const rank of ["1", 0, -1, 1.5, Infinity, true, undefined]) assert.equal(decodeRank({ rank }).state, "invalid");
  assert.equal(rankY(1, 24, 224), 24);
  assert.equal(rankY(200, 24, 224), 224);
  assert.equal(rankY(100, 24, 224) > rankY(50, 24, 224), true);
  assert.match(keywordHistoryUrl(selection({ term: "" })), /term=$/);
  const segments = splitSegmentsOnNull([1, null, 2, 3, null, 4], i => i, value => value);
  assert.deepEqual(segments.paths, ["M2,2 L3,3"]);
  assert.deepEqual(segments.lonePoints, [{ x: 0, y: 1 }, { x: 5, y: 4 }]);
});

test("AC-5/6: 형식 오류는 이전 성공 기준에서 제외하며 공식 출처 URL만 제공", () => {
  const h = history([observation("2026-09-01", { rank: 50 }), observation("2026-10-01", { rank: "broken" }), { ...observation("2026-10-12", { rank: null }), sourceUrl: "javascript:alert(1)" }]);
  assert.equal(h.rows[0].previousDay, "2026-09-01");
  assert.equal(h.rows[0].change, "결과 목록 이탈");
  assert.match(h.rows[0].sourceUrl, /^https:\/\/itunes.apple.com\/search\?/);
});

test("AC-10: 90일·30개 검색어를 읽어도 그래프는 네 개·360점 이내", () => {
  const large = { ...app, keywords: Array.from({ length: 30 }, (_, i) => "term" + i) };
  const s = normalizeKeywordSelection([large], { days: "90", term: large.keywords }, now);
  const h = buildKeywordHistory(large, s, [], [], now);
  assert.equal(h.rows.length, 30);
  assert.equal(h.series.flatMap(series => series.points).length, 360);
});
