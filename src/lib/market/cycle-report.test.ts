import assert from "node:assert/strict";
import { test } from "node:test";
import { selectCycleItems, rankRowIdentity, rankChangeBoundary, indexRankHistory } from "./cycle-report";
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
test("목록 부재의 반환 범위가 달라지면 같은 결과로 숨기지 않는다",()=>{
 const before={...item(0),rank:null,resultCount:30};
 const after={...before,resultCount:200};
 assert.equal(selectCycleItems([after],[report([before])],()=>false).length,1);
});

test("복구 AC-2 일별 이력은 KST 경계와 같은 시각의 기존 우선순위를 보존한다", () => {
  const current = { ...item(0), observedAt: new Date("2026-10-29T15:10:00Z") };
  const duplicate = { ...current, rank: 99 };
  const beforeMidnight = { ...current, rank: null, observedAt: new Date("2026-10-29T14:59:00Z") };
  const group = indexRankHistory([current, duplicate, beforeMidnight]).get(rankRowIdentity(current))!;
  assert.equal(group.latest, current);
  assert.equal(group.byDay.get("2026-10-30"), current);
  assert.equal(group.byDay.get("2026-10-29"), beforeMidnight);
  assert.equal(group.byDay.get("2026-10-28"), undefined);
});

test("복구 AC-2 조회표는 모든 행 식별자를 분리하고 이전 선형 검색과 같은 관측을 반환한다", () => {
  const base = { ...item(0), observedAt: new Date("2026-10-29T15:10:00Z") };
  const variants = [base, { ...base, appId: "other" }, { ...base, market: "google-play", source: "google-play-web" }, { ...base, source: "other-source" }, { ...base, country: "us" }, { ...base, language: "ja" }, { ...base, term: "other-term" }];
  const history = variants.flatMap((row, i) => [row, { ...row, rank: i + 1, observedAt: new Date("2026-10-28T15:10:00Z") }])
    .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const indexed = indexRankHistory(history);
  assert.equal(indexed.size, variants.length);
  for (const row of variants) {
    const identity = rankRowIdentity(row), group = indexed.get(identity)!;
    assert.equal(group.latest, history.find(before => rankRowIdentity(before) === identity));
    for (const day of ["2026-10-28", "2026-10-29", "2026-10-30"]) {
      const expected = history.find(before => rankRowIdentity(before) === identity && new Date(before.observedAt.getTime() + 9 * 3600000).toISOString().slice(0, 10) === day);
      assert.equal(group.byDay.get(day), expected);
    }
  }
});
