import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prisma } from "@/lib/prisma";
import { sendCycleKeywordRanks } from "@/lib/market/cycle-report";

async function execute(at: string, interrupt: boolean) {
  const directory=await mkdtemp(join(tmpdir(),"keyword-scale-"));
  try {
    const file=join(directory,"collector.cjs");
    await build({stdin:{resolveDir:process.cwd(),loader:"ts",contents:`
      import {prisma} from "@/lib/prisma";import {collectKeywordRanks} from "@/lib/market/keyword-collector";
      const RealDate=Date;const time=new RealDate(process.env.QA_AT).getTime();
      globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}};
      const transaction=prisma.$transaction.bind(prisma);let count=0;
      prisma.$transaction=(...args)=>{if(process.env.QA_INTERRUPT==="true" && ++count===400)process.exit(77);return transaction(...args);};
      collectKeywordRanks(new Date()).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.name);process.exitCode=1;}).finally(()=>prisma.$disconnect());
    `},outfile:file,bundle:true,platform:"node",format:"cjs",external:["@prisma/client"],alias:{"@":resolve("src")},plugins:[{name:"provider-fixture",setup(builder){
      builder.onResolve({filter:/market\/public-sources|\.\/public-sources/},()=>({path:"apple",namespace:"qa"}));
      builder.onResolve({filter:/\.\/play-search/},()=>({path:"play",namespace:"qa"}));
      builder.onLoad({filter:/.*/,namespace:"qa"},args=>({loader:"js",contents:args.path==="apple" ? `export function createApplePublicClient(){return {lookup:async ({bundleId})=>[{bundleId,trackId:Number(bundleId.split('.').at(-1)),trackName:'QA'}],search:async()=>Array.from({length:15},(_,i)=>({trackId:i+1}))};}` :
        `export function playSearchUrl(){return 'https://play.google.com/store/search';}export function createPlaySearchClient(){return {publicListing:async()=> 'QA',search:async()=>Array.from({length:15},(_,i)=>'com.scale.'+(i+1))};}` }));
    }}]});
    const child=spawn(process.execPath,[file],{env:{...process.env,NODE_PATH:resolve("node_modules"),BACKOFFICE_SOURCE_SHA:"a".repeat(40),KEYWORD_PLAY_ENABLED:"true",QA_AT:at,QA_INTERRUPT:String(interrupt)},stdio:["ignore","pipe","pipe"]});
    let out="",err="";child.stdout.on("data",data=>{out+=data;});child.stderr.on("data",data=>{err+=data;});
    const exit=await new Promise<number|null>((done,reject)=>{child.once("close",done);child.once("error",reject);});
    assert.equal(exit,interrupt?77:0,err+out);
  } finally {await rm(directory,{recursive:true,force:true});}
}
async function main() {
  const url=new URL(process.env.DATABASE_URL??"");
  assert.ok(url.hostname==="127.0.0.1" && url.pathname.endsWith("_keyword_contract_test"));
  assert.equal(await prisma.app.count(),0,"새 격리 DB를 사용합니다.");
  for(let i=1;i<=15;i++){
    const app=await prisma.app.create({data:{slug:`scale-${i}`,repoFullName:`qa/scale-${i}`,displayName:`격리 앱 ${i}`,type:"APP",engine:"RN",marketTargets:[],iosBundle:`com.scale.${i}`,playPackage:`com.scale.${i}`}});
    await prisma.configRevision.create({data:{appId:app.id,revision:1,status:"ACTIVE",activeSlot:app.id,payloadHash:"a".repeat(64),createdBy:"isolated-fixture",idempotencyKey:`scale-config-${i}`,payload:{schemaVersion:1,markets:[],monitoring:{enabled:true,keywords:Array.from({length:i===15?5:29},(_,k)=>`term-${k}`),countries:["kr"],competitorAppIds:[],officialFeeds:[],checkSupportLinks:false}}}});
  }
  const first="2026-11-05-0720";
  await execute("2026-11-04T22:25:00Z",false);
  assert.equal(await prisma.keywordObservation.count({where:{batchId:first}}),822);
  await execute("2026-11-04T22:30:00Z",false);
  assert.equal(await prisma.keywordObservation.count({where:{batchId:first}}),822);
  const complete=await prisma.keywordCollectionBatch.findUniqueOrThrow({where:{id:first}});assert.ok(complete.completedAt);
  const second="2026-11-05-1320";
  await execute("2026-11-05T04:25:00Z",true);
  const before=await prisma.keywordObservation.findMany({where:{batchId:second},select:{id:true,observedAt:true,rank:true}});
  assert.equal(before.length,399);
  assert.equal((await prisma.keywordCollectionBatch.findUniqueOrThrow({where:{id:second}})).completedAt,null);
  assert.equal((await sendCycleKeywordRanks(new Date("2026-11-05T04:30:00Z"))).status,"collection_incomplete");
  const partial=await sendCycleKeywordRanks(new Date("2026-11-05T05:40:00Z"));assert.ok(partial.eventId);
  const event=await prisma.notificationEvent.findUniqueOrThrow({where:{id:partial.eventId}});
  assert.doesNotMatch(String((event.payload as {text:string}).text),/399\/822/);
  const report=(event.payload as {rankReport:{rows:{state:string;attemptedAt?:string|null}[]}}).rankReport;
  assert.equal(report.rows.length,822);
  assert.equal(report.rows.filter(row=>row.attemptedAt===null).length,423);
  await execute("2026-11-05T05:45:00Z",false);
  assert.equal(await prisma.keywordObservation.count({where:{batchId:second}}),822);
  assert.equal(await prisma.keywordObservation.count({where:{batchId:second,status:"not_collected"}}),423);
  const saved=await prisma.keywordObservation.findMany({where:{id:{in:before.map(row=>row.id)}},select:{id:true,observedAt:true,rank:true}});
  assert.deepEqual(saved.sort((a,b)=>a.id.localeCompare(b.id)),before.sort((a,b)=>a.id.localeCompare(b.id)));
  const retried=await sendCycleKeywordRanks(new Date("2026-11-05T05:46:00Z"));assert.equal(retried.eventId,partial.eventId);
  assert.equal(await prisma.notificationDelivery.count({where:{eventId:partial.eventId}}),1);
  console.log(JSON.stringify({status:"passed",targets:822,interruptedAfter:399,uncollected:423,checks:["both-markets","completed-retry","process-exit","partial-report","missing-not-observed","budget-resume","immutable-observations","one-delivery"]}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>prisma.$disconnect());
