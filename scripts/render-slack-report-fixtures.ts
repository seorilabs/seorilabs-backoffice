import { mkdir,writeFile } from "node:fs/promises";
import sharp from "sharp";
import { rankSlackSvg,rankReportText,type RankReport } from "@/lib/market/rank-report";
import { getOrgReport } from "@/lib/core/org-report";
import { dailyReportImage } from "@/lib/report/daily-publication";
import { renderDailyEdition,renderFinancialEdition } from "@/lib/report/daily-presentation";
import { prisma } from "@/lib/prisma";
import { operationalInterestCard,type OperationalEventInput } from "@/lib/platform/operational-events";
const directory=process.env.QA_IMAGE_DIR;if(!directory)throw Error("QA_IMAGE_DIR required");
async function main(){
 await mkdir(directory!,{recursive:true});
 const row={appId:"fixture",appName:"도마뱀 테라리움",country:"us",term:"terrarium game",market:"app-store",revision:1,state:"수집됨",rank:15,rankLabel:"15위",previousRank:40,previousDay:"2026-11-11",change:"25계단 상승",observedAt:"2026-11-12T12:00:00Z",sourceUrl:"https://itunes.apple.com/search"};
 const report:RankReport={version:1,day:"2026-11-12",capturedAt:row.observedAt,rows:[row,{...row,country:"kr",rank:null},{...row,country:"jp",state:"미수집",rank:null}],items:[{...row,score:100,reason:"상위권의 뚜렷한 순위 변화",points:Array.from({length:7},(_,i)=>({day:`2026-11-${String(6+i).padStart(2,"0")}`,rank:45-i*5,state:"ranked" as const}))}],categories:[{appName:row.appName,market:"app-store",country:"us",categoryName:"Simulation",rank:80,previousRank:92,change:"12계단 상승"}]};
 for(const [name,fixture] of [["rank-change",report],["rank-outside",{...report,items:[],rows:report.rows.map(r=>({...r,rank:null})),categories:report.categories!.map(c=>({...c,rank:null,previousRank:null,change:"순위권 밖 유지"}))}]] as Array<[string,RankReport]>){
  await sharp(Buffer.from(rankSlackSvg(fixture))).png().toFile(`${directory}/${name}.png`);await writeFile(`${directory}/${name}.txt`,rankReportText(fixture,"https://backoffice.vzyx.xyz/feedback/rank-reports/fixture"));
 }
 const stored=await getOrgReport("2026-08-31",new Date(),1);if(!stored)throw Error("daily fixture missing");
 const daily=await dailyReportImage(stored.doc);await writeFile(`${directory}/metric-daily.png`,Buffer.from(daily.base64,"base64"));
 await writeFile(`${directory}/metric-daily.txt`,renderDailyEdition(stored.doc,1,"https://example.com/report"));await writeFile(`${directory}/finance-daily.txt`,renderFinancialEdition(stored.doc,"https://example.com/report"));
 const event:OperationalEventInput={version:1,eventId:"fixture-iap-0001",occurredAt:"2026-11-13T01:00:00Z",type:"iap.granted",appId:"sample",outcome:"granted",attributes:{platform:"google_play",entitlementId:"sp_veiled_chameleon",platformUserId:"pu_01ARZ3NDEKTSV4RRFFQ69G5FAV",countryCode:"US",countrySource:"google_play.regionCode",isTestPurchase:false}};
 await writeFile(`${directory}/payment.json`,JSON.stringify(operationalInterestCard(event,"도마뱀 테라리움"),null,2));
 console.log(JSON.stringify({rendered:["rank-change.png","rank-outside.png","metric-daily.png"],source:"synthetic fixtures",externalCalls:0}));
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>prisma.$disconnect());
