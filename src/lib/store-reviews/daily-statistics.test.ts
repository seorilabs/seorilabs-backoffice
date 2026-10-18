import test from "node:test";
import assert from "node:assert/strict";
import { reviewStatistics, reviewStatisticsText, sendDailyReviewStatistics, type ReviewStatisticEvent, type ReviewStatisticsDependencies } from "./daily-statistics";

function event(id:string, reviewId:string, rating:number, change="new", store="GOOGLE_PLAY"): ReviewStatisticEvent {
  return {id, createdAt:new Date(`2026-10-18T0${id.slice(-1)}:00:00Z`),payload:{appId:"app_a",store,externalReviewId:reviewId,rating,change,review:{body:"통계에 실리지 않는 원문"}}};
}
test("같은 리뷰의 마지막 별점만 평균과 분포에 쓰고 마켓은 분리한다",()=>{
  const rows=reviewStatistics([event("e3","r1",5,"updated"),event("e1","r1",1),event("e2","r2",3,"updated"),event("e4","r1",2,"new","APP_STORE")]);
  const play=rows.find(r=>r.store==="GOOGLE_PLAY")!;
  assert.equal(play.count,2);assert.equal(play.newCount,1);assert.equal(play.updatedCount,1);
  assert.equal(play.average,4);assert.deepEqual(play.ratings,[0,0,1,0,1]);
  assert.equal(rows.find(r=>r.store==="APP_STORE")!.count,1);
  const text=reviewStatisticsText(play,"앱 A","2026-10-18");
  assert.match(text,/4\.00\/5/);assert.match(text,/5★ ▰+/);assert.doesNotMatch(text,/원문/);
});
test("잘못된 별점과 만료된 원문 대신 가짜 통계를 만들지 않는다",()=>{
  assert.deepEqual(reviewStatistics([event("e1","r",6),{id:"expired",createdAt:new Date(),payload:{reviewExpired:true}}]),[]);
});
test("11시 경계와 전날 KST 수집 범위, 빈 표본과 같은 발행 키를 유지한다",async()=>{
  const keys:string[]=[];const texts:string[]=[];const windows:Array<[Date,Date]>=[];
  let events=[event("e1","r1",5)];
  const deps: ReviewStatisticsDependencies={
    listApps:async()=>[{id:"app_a",slug:"app-a",displayName:"앱 A"}],
    listEvents:async(start,end)=>{windows.push([start,end]);return events;},
    enqueue:async input=>{keys.push(input.dedupeKey);texts.push(String(input.payload.text));return input.dedupeKey;},
  };
  assert.equal((await sendDailyReviewStatistics(new Date("2026-10-19T01:59:59Z"),undefined,deps)).status,"not-due");
  assert.equal(windows.length,0);
  await sendDailyReviewStatistics(new Date("2026-10-19T02:00:00Z"),undefined,deps);
  assert.equal(windows[0][0].toISOString(),"2026-10-17T15:00:00.000Z");
  assert.equal(windows[0][1].toISOString(),"2026-10-18T15:00:00.000Z");
  await sendDailyReviewStatistics(new Date("2026-10-19T02:01:00Z"),undefined,deps);
  assert.equal(keys[0],keys[1]);assert.equal(texts[0],texts[1]);
  events=[event("e1","r1",5),event("e2","r1",1,"updated")];
  await sendDailyReviewStatistics(new Date("2026-10-19T03:00:00Z"),undefined,deps);
  assert.equal(keys[2],keys[0]);assert.match(texts[2],/1\.00\/5/);
  events=[];assert.equal((await sendDailyReviewStatistics(new Date("2026-10-19T03:00:00Z"),undefined,deps)).reports,0);
  await assert.rejects(sendDailyReviewStatistics(new Date("2026-10-19T03:00:00Z"),{day:"2026-10-19",appSlug:"app-a"},deps),/INVALID/);
});
