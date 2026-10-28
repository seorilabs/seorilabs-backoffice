import assert from "node:assert/strict";
import { test } from "node:test";
import { selectCycleItems, rankRowIdentity, rankChangeBoundary } from "./cycle-report";
import type { RankReport, RankReportItem } from "./rank-report";
const item = (id: number, score = 0): RankReportItem => ({appId:"app"+id,appName:"앱"+id,term:"term"+id,country:"kr",market:"app-store",source:"apple-search-api",language:"en_us",revision:1,rank:20,rankLabel:"20위",state:"수집됨",previousRank:20,previousDay:"2026-10-27",change:"변화 없음",observedAt:"2026-10-28T04:30:00Z",sourceUrl:"https://itunes.apple.com/search",points:[],reason:"변화 없음",score});
const report = (items: RankReportItem[]): RankReport => ({version:1,day:"2026-10-28",capturedAt:"2026-10-28T00:00:00Z",items,rows:[]});
test("AC-3 큰 변화는 최대 둘, 세 앱과 브랜드 하나, 일주일 내 같은 결과 반복 억제", () => {
  const candidates = Array.from({length:12},(_,i)=>item(i,i<5 ? 100-i : 0));
  const brand = (row:RankReportItem) => ["app0","app1"].includes(row.appId);
  const first=selectCycleItems(candidates,[],brand);
  assert.equal(first.length,3); assert.equal(first.filter(brand).length,1);
  assert.equal(first.filter(row=>row.score>0).length,2);
  assert.equal(new Set(first.map(row=>row.appId)).size,3);
  const next=selectCycleItems(candidates,[report(first)],brand);
  assert.equal(next.length,3);assert.ok(next.every(row=>!first.includes(row)));
  assert.deepEqual(selectCycleItems(first,[report(first)],brand),[]);
});
test("AC-2 같은 검색어라도 마켓, 출처와 언어별 이력을 분리한다", () => {
  const apple=item(0), play={...apple,market:"google-play",source:"google-play-web",rank:7}, otherLocale={...apple,language:"ja"};
  assert.notEqual(rankRowIdentity(apple),rankRowIdentity(play));
  assert.notEqual(rankRowIdentity(apple),rankRowIdentity(otherLocale));
  assert.deepEqual(selectCycleItems([play],[report([apple])],()=>false),[play]);
});

test("반환 범위가 짧으면 목록 부재를 상위권 이탈로 만들지 않는다",()=>{
 assert.equal(rankChangeBoundary({rank:20,resultCount:200},{rank:null,resultCount:10}),undefined);
 assert.equal(rankChangeBoundary({rank:null,resultCount:10},{rank:20,resultCount:200}),undefined);
 assert.equal(rankChangeBoundary({rank:20,resultCount:200},{rank:null,resultCount:200}),20);
});
