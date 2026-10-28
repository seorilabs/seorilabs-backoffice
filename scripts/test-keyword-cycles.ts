import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { metricDayOf } from "@/lib/analytics/metric-day";
import { keywordCycle } from "@/lib/market/keyword-cycle";
import { keywordObservationId, saveKeywordObservation, type KeywordTask } from "@/lib/market/keyword-collector";
import { sendCycleKeywordRanks } from "@/lib/market/cycle-report";
import { keywordHistoryQuery } from "@/lib/market/keyword-history-query";
const database = new URL(process.env.DATABASE_URL ?? "");
if (!['127.0.0.1','localhost'].includes(database.hostname) || !(database.pathname === '/keyword_qa' || database.pathname.endsWith('_contract_test'))) throw Error('ISOLATED_KEYWORD_DATABASE_REQUIRED');
process.env.DISCORD_CHANNEL_METRICS_DAILY_ID = '1002';
async function main() {
  const suffix = Date.now();
  const app = await prisma.app.create({data:{slug:`qa-keyword-${suffix}`,repoFullName:`isolated/keyword-${suffix}`,displayName:'검색 검수 앱',type:'APP',engine:'GODOT',status:'ACTIVE',marketTargets:[],iosBundle:`com.qa.${suffix}`,playPackage:`com.qa.${suffix}`}});
  const task:KeywordTask={appId:app.id,market:'app-store',country:'kr',language:'en_us',term:'search term',revision:1,identity:app.iosBundle!};
  await prisma.configRevision.create({data:{appId:app.id,revision:1,status:'ACTIVE',activeSlot:app.id,payloadHash:'a'.repeat(64),createdBy:'isolated-fixture',idempotencyKey:`qa-config-${suffix}`,payload:{schemaVersion:1,markets:[],monitoring:{enabled:true,keywords:['search term','second term','third term'],countries:['kr'],competitorAppIds:[],officialFeeds:[],checkSupportLinks:false}}}});
  const times=['2026-10-27T22:25:00Z','2026-10-28T04:25:00Z','2026-10-28T11:25:00Z'];
  // 보고 키가 날짜별로 고정되므로 전용 DB의 새 날짜를 매 실행 선택한다.
  const offset=await prisma.keywordCollectionBatch.count();
  const shift=(date:string)=>new Date(new Date(date).getTime()+offset*86400000);
  const day=metricDayOf(shift(times[0]));
  let lastId='';
  for (const [index,time] of times.entries()) {
    const at=shift(time),cycle=keywordCycle(at);
    await prisma.keywordCollectionBatch.create({data:{id:cycle.id,sourceSha:'a'.repeat(40),startedAt:cycle.start,completedAt:at,plan:[task] as never}});
    for (const [term,rank] of [['search term',20-index*5],['second term',40],['third term',60]] as const) {
      const current={...task,term},id=keywordObservationId(cycle.id,current);lastId=id;
      const input={id,batchId:cycle.id,appId:app.id,market:task.market,source:'apple-search-api',country:'kr',language:'en_us',term,revision:1,sourceSha:'a'.repeat(40),observedAt:at,status:'observed',rank,resultCount:200,sourceUrl:'https://itunes.apple.com/search'};
      await saveKeywordObservation(input);
      const retry=await saveKeywordObservation({...input,rank:99,observedAt:new Date(at.getTime()+1000)});
      assert.equal(retry.rank,rank);assert.equal(retry.observedAt.getTime(),at.getTime());
    }
    const result=await sendCycleKeywordRanks(new Date(at.getTime()+75*60000));
    if(index===0)assert.ok(result.eventId);
    const again=await sendCycleKeywordRanks(new Date(at.getTime()+76*60000));
    assert.equal(again.eventId,result.eventId);
  }
  assert.equal(await prisma.keywordObservation.count({where:{appId:app.id,market:'app-store'}}),9);
  const latest=await prisma.keywordObservation.findUniqueOrThrow({where:{id:lastId}});
  await saveKeywordObservation({...latest,id:'f'.repeat(48)+String(suffix).padStart(16,'0'),term:'search term',status:'failed',rank:null,resultCount:null,observedAt:new Date(latest.observedAt.getTime()+1000)});
  const daily=await prisma.marketObservation.findFirstOrThrow({where:{appId:app.id,target:'search term'},orderBy:{observedAt:'desc'}});
  assert.equal((daily.value as {rank:number}).rank,10);
  await saveKeywordObservation({...latest,id:'e'.repeat(48)+String(suffix).padStart(16,'0'),market:'google-play',source:'google-play-web',language:'en',term:'search term',rank:7,resultCount:30,sourceUrl:'https://play.google.com/store/search?q=search&c=apps&hl=en&gl=KR'});
  const apple=await keywordHistoryQuery({app:app.id,date:day},shift('2026-10-28T13:00:00Z'));
  const play=await keywordHistoryQuery({app:app.id,date:day,market:'google-play'},shift('2026-10-28T13:00:00Z'));
  assert.equal(apple.history?.rows[0].rank,10);assert.equal(play.history?.rows[0].rank,7);assert.equal(play.history?.rows[0].resultCount,30);
  const events=await prisma.notificationEvent.findMany({where:{dedupeKey:{startsWith:'keyword-report-cycle:'}},include:{deliveries:true}});
  assert.ok(events.every(event=>event.deliveries.length===1));
  console.log(JSON.stringify({status:'passed',checks:['three-cycles','retry-immutable','last-success','market-separation','report-dedupe','daily-query'],appId:app.id}));
}
main().finally(()=>prisma.$disconnect()).catch(error=>{console.error(error);process.exitCode=1});
