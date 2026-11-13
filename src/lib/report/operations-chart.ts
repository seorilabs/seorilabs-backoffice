import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { orgTrendSeries } from "@/lib/core/org-report";
import { dbDay,shiftMetricDay,toDbDay } from "@/lib/analytics/metric-day";
import { reportChartSvg } from "./discord-chart";
import type { MessageAttachment } from "@/lib/notifications/channel";
export async function operationsChart(end:string,weekly=false):Promise<MessageAttachment>{
 const points=await orgTrendSeries(end,7),days=points.map(p=>p.date);
 const cohorts=await prisma.appMetricDaily.findMany({where:{date:{gte:toDbDay(shiftMetricDay(end,-6)),lte:toDbDay(end)},cohortUsers:{not:null},d1Users:{not:null},app:{status:"ACTIVE"}},select:{date:true,cohortUsers:true,d1Users:true}});
 const charts:Array<Parameters<typeof reportChartSvg>[0]>=[
 {title:"활성·신규 사용자"+" · "+end,days,unit:"명",source:"GA4 · 앱 간 중복 포함 · 미수집 제외",series:[{label:"활성 합계",color:"#2563eb",values:points.map(p=>p.ga4Dau)},{label:"신규 합계",color:"#059669",values:points.map(p=>p.ga4NewUsers)}]},
 {title:"보상형 광고 완료",days,unit:"회",source:"GA4 · 실제 관측값 · 미수집 제외",series:[{label:"광고 완료",color:"#7c3aed",values:points.map(p=>p.adCompletions)}]},
 {title:"D1 잔존율 · 신규 사용자 코호트 기준",days,unit:"%",source:"GA4 · 코호트 분모 20명 이상 · 최초 유입일 기준",series:[{label:"다음 날 복귀율",color:"#d97706",values:days.map(day=>{const rows=cohorts.filter(r=>dbDay(r.date)===day),n=rows.reduce((a,r)=>a+r.cohortUsers!,0);return n>=20 ? rows.reduce((a,r)=>a+r.d1Users!,0)/n*100:null;})}]},
 ];
 const buffers=await Promise.all(charts.map(chart=>sharp(Buffer.from(reportChartSvg(chart))).png().toBuffer()));
 let top=0;const panels=[];for(const input of buffers){panels.push({input,left:0,top});top+=(await sharp(input).metadata()).height!;}
 const bytes=await sharp({create:{width:960,height:top,channels:4,background:"#ffffff"}}).composite(panels).png().toBuffer();
 return {filename:weekly?"weekly-metrics.png":"daily-metrics.png",contentType:"image/png",base64:bytes.toString("base64")};
}
