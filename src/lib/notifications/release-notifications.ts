import { createHash } from "node:crypto";
import { z, ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { verifyStaticToken } from "@/lib/security";
import { retryPrismaConflict } from "@/lib/prisma-conflict";
import { enqueueNotification } from "./outbox";
import { notificationDestinations } from "./destinations";
import { canonicalJson, type JsonValue } from "@/lib/control-plane/json";

const text = z.string().trim().min(1).max(300).refine(s=>!/[\r\n@<>]/.test(s));
export const releaseNotificationSchema = z.object({
 id:z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/), app:text, tag:z.string().regex(/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
 sourceSha:z.string().regex(/^[a-f0-9]{40}$/).optional(), status:text,
 links:z.array(z.object({label:text,url:z.string().url().max(2000).refine(s=>s.startsWith("https://"))}).strict()).max(8).default([]),
 fields:z.array(z.object({label:text,value:text}).strict()).max(12).default([]), note:text.optional(), test:z.boolean().default(false),
}).strict();
export type ReleaseNotification = z.infer<typeof releaseNotificationSchema>;
export function releaseNotificationPayload(input: ReleaseNotification) {
 const title=`${input.test ? "[테스트] " : ""}${input.app} ${input.tag} 테스트 배포 안내`;
 const lines=[title,`배포 상태: ${input.status}`,...input.fields.map(f=>`${f.label}: ${f.value}`),...input.links.map(f=>`[${f.label}](${f.url})`),...(input.note?[`확인 요청: ${input.note}`]:[]),...(input.sourceSha?[`소스: ${input.sourceSha}`]:[])];
 return {text:lines.join("\n"),report:{category:"response",reason:"RELEASE_TEST_DISTRIBUTION"},releaseNotificationHash:createHash("sha256").update(canonicalJson(input as unknown as JsonValue)).digest("hex")};
}
export async function acceptReleaseNotification(raw: unknown) {
 const input=releaseNotificationSchema.parse(raw), payload=releaseNotificationPayload(input), dedupeKey=`release-notification:${input.id}`;
 return retryPrismaConflict(()=>prisma.$transaction(async tx=>{
  const prior=await tx.notificationEvent.findUnique({where:{dedupeKey}});
  if(prior && (prior.payload as Prisma.JsonObject).releaseNotificationHash!==payload.releaseNotificationHash) throw Error("RELEASE_NOTIFICATION_CONFLICT");
  const eventId=prior?.id ?? await enqueueNotification({dedupeKey,kind:"OPERATIONAL_EVENT",payload,destinations:notificationDestinations(["release-ops"])},tx);
  const deliveries=await tx.notificationDelivery.findMany({where:{eventId},select:{status:true,providerMessageId:true,lastError:true}});
  return {accepted:true,eventId,duplicate:Boolean(prior),delivered:deliveries.length>0 && deliveries.every(d=>d.status==="SENT"),deliveries};
 },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable}));
}
export async function releaseNotificationStatus(id:string) {
 if(!/^[A-Za-z0-9._:-]{1,120}$/.test(id))return null;
 const event=await prisma.notificationEvent.findUnique({where:{dedupeKey:`release-notification:${id}`},select:{id:true,deliveries:{select:{status:true,providerMessageId:true,lastError:true}}}});
 return event ? {accepted:true,eventId:event.id,delivered:event.deliveries.length>0 && event.deliveries.every(d=>d.status==="SENT"),deliveries:event.deliveries}:null;
}
export async function handleReleaseNotification(header:string|null,token:string|undefined,read:()=>Promise<string>,save=acceptReleaseNotification) {
 if(!verifyStaticToken(header,token))return {status:401,body:{error:"unauthorized"}};
 try {
  const raw=await read();if(Buffer.byteLength(raw)>32_000)return {status:413,body:{error:"payload too large"}};
  const result=await save(releaseNotificationSchema.parse(JSON.parse(raw)));
  return {status:result.duplicate ? 200 : 202,body:result};
 } catch(error) {
  const conflict=error instanceof Error && error.message==="RELEASE_NOTIFICATION_CONFLICT";
  const invalid=error instanceof ZodError || error instanceof SyntaxError;
  return {status:conflict?409:invalid?400:500,body:{error:conflict?"notification id conflict":invalid?"invalid release notification":"notification storage failed"}};
 }
}
