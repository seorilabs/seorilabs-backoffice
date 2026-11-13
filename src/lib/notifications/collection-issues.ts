import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueueNotification } from "./outbox";
import { recordIncident, recoverIncident } from "./incidents";
export const COLLECTION_SOURCE = "collection";
export function isCollectionBatch(name:string){
 return /book-sales-kdp|(?:analytics|metric|console|keyword|market-feedback|store-review|store-submission|platform-metric).*(?:collect|recollect|metrics|feedback|reviews|submissions|daily|probe)$/.test(name) && !/report|highlights|reconcile/.test(name);
}
export const collectionRunId=(id:string)=>id.replace(/^batch:(?:k8s|local):/,"");
export async function recordCollectionIssue(input:{job:string;runId:string;at:Date;failed:boolean;skipped?:boolean;target:string;items:string[];period:string;cause:string;action:string;url?:string},tx?:Prisma.TransactionClient){
 const db=tx??prisma,runId=collectionRunId(input.runId);
 if(input.skipped){await enqueueNotification({dedupeKey:`collection-skipped:${input.job}:${runId}`,kind:"OPERATIONAL_EVENT",destinations:[],payload:{report:{category:"internal",reason:"COLLECTION_SKIPPED"}}},db);return;}
 const skipped=await db.notificationEvent.findUnique({where:{dedupeKey:`collection-skipped:${input.job}:${runId}`},select:{id:true}});
 if(skipped && !input.failed)return;
 const key={source:COLLECTION_SOURCE,kind:input.job,signalId:runId};
 if(!input.failed){
  // 감시자가 성공한 프로세스를 봐도 같은 실행의 부분 수집 실패는 해소하지 않는다.
  const failedRun=await db.notificationEvent.findUnique({where:{dedupeKey:`incident-observation:${COLLECTION_SOURCE}:${input.job}:global:${runId}`},select:{id:true}});
  if(failedRun)return;
  return recoverIncident({...key,recoveredAt:input.at},db);
 }
 const failureSignature=createHash("sha256").update(JSON.stringify([input.target,[...input.items].sort(),input.cause])).digest("hex");
 return recordIncident({...key,severity:"warning",detectedAt:input.at,summary:`${input.target} 수집 확인 필요`,evidence:{target:input.target,items:input.items.join(", "),period:input.period,cause:input.cause,action:input.action,url:input.url??"https://backoffice.vzyx.xyz/feedback/collections",failureSignature}},tx);
}
