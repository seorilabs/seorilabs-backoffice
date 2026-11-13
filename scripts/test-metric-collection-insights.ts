import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { beginCollection, completeCollection } from "@/lib/insights/collection";
import { metricCollectionSnapshot } from "@/lib/insights/metric-collection-facts";
import { reconcileMetricCollectionInsights, METRIC_COLLECTION_KIND } from "@/lib/insights/metric-collection";
import { publishSignal, processNextInsight, insightNotificationKey } from "@/lib/insights/service";
import { fallbackInsight } from "@/lib/insights/contract";
import { ingestAndVerifyConsolePush } from "@/lib/analytics/console-sync/push";
import { AIT_LISTINGS } from "@/lib/analytics/ait-apps";
import { drainNotifications } from "@/lib/notifications/outbox";

async function collectGa4Fixture(appId: string) {
  const directory = await mkdtemp(join(tmpdir(), "ga4-collection-qa-"));
  try {
    const file=join(directory,"ga4.cjs");
    await build({stdin:{contents:`import {collectMetrics} from "@/lib/core/analytics-collect"; import {prisma} from "@/lib/prisma";
      collectMetrics(new Date("2026-11-04T01:00:00Z"),{appId:process.env.QA_APP_ID,windowDays:2}).then(result=>{
        if(result.upserts!==2 || result.errors.length)throw Error("GA4_FIXTURE_FAILED");console.log(JSON.stringify({runId:result.runId}));
      }).catch(error=>{console.error(error.name);process.exitCode=1;}).finally(()=>prisma.$disconnect());`,resolveDir:process.cwd(),loader:"ts"},outfile:file,bundle:true,platform:"node",format:"cjs",external:["@prisma/client"],alias:{"@":resolve("src")},plugins:[{name:"provider-boundary",setup(builder){
      builder.onResolve({filter:/\/ga4\/bigquery$/},()=>({path:"bigquery-fixture",namespace:"qa"}));
      builder.onLoad({filter:/.*/,namespace:"qa"},()=>({contents:`export async function queryLandedEventTables(){return new Set(["20261102","20261103"]);}
        export async function queryDailyActivity(){return [];}export async function queryCohortRetention(){return [];}export async function queryDailyBreakdowns(){return [];}`,loader:"js"}));
    }}]});
    const child=spawn(process.execPath,[file],{env:{...process.env,NODE_PATH:resolve("node_modules"),QA_APP_ID:appId,FEATURE_GA4_ANALYTICS:"true",GA4_SA_KEY_JSON:"fixture-provider-boundary"},stdio:["ignore","pipe","pipe"]});
    let output="",errors="";child.stdout.on("data",data=>{output+=data;});child.stderr.on("data",data=>{errors+=data;});
    const exit=await new Promise<number|null>((done,reject)=>{child.once("close",done);child.once("error",reject);});
    assert.equal(exit,0,errors);return JSON.parse(output.trim()) as {runId:string};
  } finally {await rm(directory,{recursive:true,force:true});}
}

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname.endsWith("_contract_test"));
  process.env.SLACK_CHANNEL_APP_OPS_ID = "C000QA";
  const now = new Date("2026-11-04T01:00:00Z");
  const legacy = await publishSignal({dedupeKey:`qa-old-${Date.now()}`,kind:"metric-change",title:"이전 대기 신호",facts:[{id:"old",label:"격리",value:"1명",source:"QA"}],sourceRefs:[],observedAt:now});
  const ga4 = await beginCollection("ga4", "window:2026-11-02:2026-11-03");
  const snapshot = metricCollectionSnapshot("ga4", "2026-11-03", "partial", [
    {key:"ga4-a",label:"격리 앱",day:"2026-11-02",metrics:{dau:{label:"활성 사용자",value:10,unit:"명"}}},
    {key:"ga4-a",label:"격리 앱",day:"2026-11-03",metrics:{dau:{label:"활성 사용자",value:20,unit:"명"}}},
  ]);
  // 수집 종료 뒤 프로세스가 사라진 상태. 다음 worker가 원장만으로 분석 요청을 복구한다.
  await completeCollection(ga4.id,{status:"partial",coverage:{metricInsight:JSON.parse(JSON.stringify(snapshot))}});
  await Promise.all([reconcileMetricCollectionInsights(),reconcileMetricCollectionInsights()]);
  const signal = await prisma.operationalSignal.findUniqueOrThrow({where:{dedupeKey:`metric-collection:${ga4.id}`},include:{insights:true}});
  assert.equal(signal.insights.length,1);
  assert.deepEqual(signal.facts,snapshot.facts);
  assert.equal(await prisma.agentRun.count({where:{workKey:`insight:${signal.insights[0].id}`}}),1);
  assert.equal(await reconcileMetricCollectionInsights(),0);

  assert.equal(await processNextInsight("insights:qa-filter",async facts=>({content:fallbackInsight(facts),fallback:true,errorCode:"ANALYSIS_PROVIDER_FAILED"}),METRIC_COLLECTION_KIND),true);
  assert.equal((await prisma.insightDocument.findUniqueOrThrow({where:{id:legacy.id}})).status,"PENDING");
  const event = await prisma.notificationEvent.findUniqueOrThrow({where:{dedupeKey:insightNotificationKey(METRIC_COLLECTION_KIND,snapshot.facts,signal.insights[0].notificationKey)},include:{deliveries:true}});
  assert.match((event.payload as {text:string}).text,/AI 분석 실패/);
  assert.equal(event.deliveries[0].destinationKey,"metric-insights");
  let posts=0;
  await drainNotifications(100,async delivery=>{if(delivery.deliveryId===event.deliveries[0].id)posts++;return {ok:true,messageId:"qa-receipt"};});
  await drainNotifications(100,async ()=>{posts++;return {ok:true,messageId:"qa-duplicate"};});
  assert.equal(posts,1);
  assert.equal(await processNextInsight("insights:qa-filter",undefined,METRIC_COLLECTION_KIND),false);

  const listing=AIT_LISTINGS[0];
  const app=await prisma.app.upsert({where:{slug:listing.appSlug},create:{slug:listing.appSlug,displayName:"콘솔 격리 앱",repoFullName:`qa/${listing.appSlug}`,type:"APP",engine:"RN",marketTargets:["ait"],aitMiniAppId:listing.miniAppId,aitWorkspaceId:38345},update:{}});
  const pushed=await ingestAndVerifyConsolePush({apps:[{slug:listing.appSlug,miniAppId:listing.miniAppId,days:[{date:"2026-11-03",dau:0,newUsers:0,avgSessionSec:0,iaaImpressions:0,iaaEarningKrw:0,iapTrxAmountKrw:0,payingUsers:0}]}]},now);
  assert.equal(pushed.verification.verified,1);
  assert.equal((await prisma.appConsoleMetricDaily.findUniqueOrThrow({where:{appId_miniAppId_date:{appId:app.id,miniAppId:listing.miniAppId,date:new Date("2026-11-03")}}})).dau,0);
  assert.equal(await reconcileMetricCollectionInsights(),1);
  assert.equal(await processNextInsight("insights:qa-manual",async facts=>({content:fallbackInsight(facts),fallback:false,errorCode:null}),METRIC_COLLECTION_KIND),true);
  const ga4App=await prisma.app.create({data:{slug:`ga4-source-${Date.now()}`,displayName:"GA4 실제 저장 검수",repoFullName:`qa/ga4-${Date.now()}`,type:"APP",engine:"RN",marketTargets:["web"],firebaseProject:"qa-fixture",ga4Dataset:"analytics_123456"}});
  const collected=await collectGa4Fixture(ga4App.id);
  const collectedRun=await prisma.sourceCollectionRun.findUniqueOrThrow({where:{id:collected.runId}});
  assert.equal(collectedRun.status,"observed");
  assert.match(JSON.stringify(collectedRun.coverage),/0명/);
  assert.equal(await reconcileMetricCollectionInsights(),1);
  assert.equal(await processNextInsight("insights:qa-ga4",async facts=>({content:fallbackInsight(facts),fallback:false,errorCode:null}),METRIC_COLLECTION_KIND),true);
  console.log(JSON.stringify({status:"passed",checks:["durable-completion","concurrent-reconcile","frozen-facts","old-queue-filter","provider-fallback","delivery-receipt","manual-push","observed-zero","ga4-provider-to-storage-to-insight"]}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>prisma.$disconnect());
