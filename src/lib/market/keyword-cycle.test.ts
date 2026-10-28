import assert from "node:assert/strict";
import { test } from "node:test";
import { brandKeyword, keywordCycle, parsePlaySearch } from "./keyword-cycle";
const page = (body: string) => `<html><body><c-wiz data-cluster="search_results_cluster_apps_range_0_30"><section><header class="oVnAB K6hyTe"></header>${body}</section></c-wiz></body></html>`;
const card = (id: string, extra = "") => `<div role="listitem">${extra}<a href="/store/apps/details?id=${id}">앱</a></div>`;
test("AC-1/5 KST 수집 세 회차와 보고 시간대는 각각 고정한다", () => {
  const morning = keywordCycle(new Date("2026-10-27T22:20:00Z"));
  assert.equal(morning.id, "2026-10-28-0720");
  assert.equal(keywordCycle(new Date("2026-10-28T04:20:00Z")).id, "2026-10-28-1320");
  assert.equal(keywordCycle(new Date("2026-10-28T11:20:00Z")).id, "2026-10-28-2020");
  assert.equal(keywordCycle(new Date("2026-10-27T23:40:00Z")).reportSlot, "0840");
  assert.equal(keywordCycle(new Date("2026-10-28T05:40:00Z")).reportSlot, "1440");
  assert.equal(keywordCycle(new Date("2026-10-28T12:40:00Z")).reportSlot, "2140");
  assert.equal(keywordCycle(new Date("2026-10-28T00:00:00Z")).id, morning.id);
});
test("AC-4 Play 본문 순서만 사용하고 추천, 광고, 중복을 제외한다", () => {
  assert.deepEqual(parsePlaySearch(page(card("com.a")+card("com.ad",'<span>Sponsored</span>')+card("com.b")+card("com.a")).replace("</body>",`<section><header>Recommended</header>${card("com.rec")}</section></body>`)), ["com.a", "com.b"]);
  assert.deepEqual(parsePlaySearch('<html><body><section><p>No results for zzqq</p></section></body></html>'), []);
  for (const html of ["", '<html><body>captcha</body></html>', page(card("com.a")).slice(0,-20), '<html><body>'+card("com.a")+'</body></html>']) assert.throws(()=>parsePlaySearch(html));
});

test("브랜드는 공개 이름의 제목과 앱 이름으로 구분한다",()=>{
 assert.equal(brandKeyword("Hello Lizards",["Hello, Lizards: Pixel Pet Care"]),true);
 assert.equal(brandKeyword("BabyNest",["BabyNest: Shared Baby Care Log"]),true);
 assert.equal(brandKeyword("baby tracker",["BabyNest: Shared Baby Care Log"]),false);
});
test("일반 장르 검색어를 앱 이름의 일부라는 이유로 브랜드로 제한하지 않는다",()=>{
 assert.equal(brandKeyword("chess",["Lucid Chess"]),false);
 assert.equal(brandKeyword("farm tycoon",["Happy Farm Tycoon"]),false);
 assert.equal(brandKeyword("matgo",["Moonlight Matgo"]),false);
 assert.equal(brandKeyword("Moonlight Matgo",["Moonlight Matgo"]),true);
});
