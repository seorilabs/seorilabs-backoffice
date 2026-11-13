import { enqueueNotification } from "@/lib/notifications/outbox";
import { notificationDestinations,type DestinationKey } from "@/lib/notifications/destinations";
import { operationalInterestCard,type OperationalEventInput } from "@/lib/platform/operational-events";
import { renderPayload } from "@/lib/notifications/format";
import { rankSlackSvg,type RankReport } from "@/lib/market/rank-report";
import { reportChartSvg } from "@/lib/report/discord-chart";
import { prisma } from "@/lib/prisma";
import sharp from "sharp";
import type { Prisma } from "@prisma/client";
const destinations:DestinationKey[]=["iap","ad-rewards","action-events","metrics-daily","batch-monitoring","app-ops","metric-insights"];
async function main(){
 const sha=process.env.VERIFICATION_SOURCE_SHA??"";if(!/^[a-f0-9]{40}$/.test(sha))throw Error("VERIFICATION_SOURCE_SHA required");
 const at=new Date().toISOString(),base:OperationalEventInput={version:1,eventId:"verification-event-0001",occurredAt:at,type:"iap.granted",appId:"verification",outcome:"granted",attributes:{platform:"google_play",entitlementId:"example_reward",platformUserId:"pu_01ARZ3NDEKTSV4RRFFQ69G5FAV",countryCode:"US",countrySource:"google_play.regionCode",isTestPurchase:true,grantKind:"purchase"}};
 const rank:RankReport={version:1,day:at.slice(0,10),capturedAt:at,rows:[],items:[]};
 const rankImage=await sharp(Buffer.from(rankSlackSvg(rank))).png().toBuffer();
 const metricImage=await sharp(Buffer.from(reportChartSvg({title:"[테스트] 합성 지표 추세",days:["11-07","11-08","11-09","11-10","11-11","11-12","11-13"],unit:"명",source:"수신 확인용 합성 자료 · 실제 사용자 지표가 아님",series:[{label:"예제 활성 사용자",color:"#2563eb",values:[10,12,null,15,20,22,25]}]}))).png().toBuffer();
 const ids=[];
 for(const destination of destinations){
  let payload:Prisma.InputJsonObject={text:`[테스트·수신 확인] ${destination}\n알림 목적지와 표시를 검증하는 합성 메시지입니다. 실제 결제·보상·수집 실패·매출을 나타내지 않습니다.`};
  if(destination==="iap" || destination==="ad-rewards"){
   const event=destination==="iap"?base:{...base,type:"ad.reward.delivered" as const,outcome:"delivered",attributes:{provider:"admob",clientPlatform:"android",rewardKey:"example_crystal",rewardAmount:2}};
   const card=operationalInterestCard(event,"[테스트] 알림 경로 확인용 예제 앱");payload={...renderPayload(card),text:`[테스트·수신 확인]\n${card.text}`};
  }
  if(destination==="metrics-daily" || destination==="metric-insights")payload={...payload,attachment:{filename:`${destination}-verification.png`,contentType:"image/png",base64:(destination==="metrics-daily"?rankImage:metricImage).toString("base64")}};
  payload={...payload,report:{category:"response",reason:"USER_AUTHORIZED_NOTIFICATION_VERIFICATION"},verification:true};
  if(!process.argv.includes("--post")){console.log(JSON.stringify({destination,text:payload.text}));continue;}
  const id=await enqueueNotification({dedupeKey:`notification-verification:${sha}:${destination}`,kind:"OPERATIONAL_EVENT",occurredAt:new Date(at),payload,destinations:notificationDestinations([destination])});ids.push({destination,eventId:id});
 }
 console.log(JSON.stringify({sourceSha:sha,queued:ids}));
}
main().catch(e=>{console.error(e instanceof Error?e.message:"verification failed");process.exitCode=1;}).finally(()=>prisma.$disconnect());
