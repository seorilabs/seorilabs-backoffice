import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { isDestinationKey } from "./destinations";

const CUTOVER_ID = "discord-to-slack-20261029";
const oldProvider = { OR: [{sourceProvider:"DISCORD" as const},{sourceProvider:null}] };

/** 전송 worker가 중지된 상태에서만 실행한다. 과거 발송 이력은 보존한다. */
export async function cutoverSlackNotifications(apply = false) {
  const pendingWhere: Prisma.NotificationDeliveryWhereInput = {provider:"DISCORD",status:{in:["PENDING","PROCESSING"]}};
  const readback = {
    pendingDeliveries:await prisma.notificationDelivery.count({where:pendingWhere}),
    runningCommands:await prisma.operatorCommandRun.count({where:{...oldProvider,status:{in:["PENDING","PROCESSING"]}}}),
    confirmationCommands:await prisma.operatorCommandRun.count({where:{...oldProvider,status:"AWAITING_CONFIRMATION"}}),
    activeIncidents:await prisma.operationalIncident.count({where:{status:{in:["OPEN","ACKNOWLEDGED"]}}}),
    waitingApprovals:await prisma.deploymentApproval.count({where:{providerState:"WAITING",actionState:"IDLE"}}),
  };
  if (!apply) return {applied:false,...readback};
  if (process.env.SLACK_CUTOVER_ACK !== "OLD_WORKERS_STOPPED" || !env.slackEnabled()) throw new Error("Slack 전환 실행 조건 미충족");
  if (readback.runningCommands) throw new Error("이전 서비스의 실행 중 명령이 남아 있습니다.");
  return prisma.$transaction(async tx => {
    const previous = await tx.auditLog.findFirst({where:{action:"notification.slack_cutover",entityId:CUTOVER_ID}});
    if (previous) return {applied:false,alreadyApplied:true,...readback};
    if (await tx.operatorCommandRun.count({where:{...oldProvider,status:{in:["PENDING","PROCESSING"]}}})) throw new Error("이전 서비스의 실행 중 명령이 남아 있습니다.");
    let copied = 0;
    const copiedKeys = new Set<string>();
    const ensureDelivery = async (eventId:string,destinationKey:string) => {
      if (!isDestinationKey(destinationKey) || !env.notificationChannelId(destinationKey)) throw new Error("Slack 전환 목적지 미설정");
      const key = `${eventId}:${destinationKey}`;
      if (copiedKeys.has(key)) return;
      copiedKeys.add(key);
      const result = await tx.notificationDelivery.createMany({data:[{eventId,provider:"SLACK",destinationKey}],skipDuplicates:true});
      copied += result.count;
      const event = await tx.notificationEvent.findUniqueOrThrow({where:{id:eventId},select:{payload:true}});
      const payload = event.payload as Prisma.JsonObject;
      const thread = payload?.thread as Prisma.JsonObject | undefined;
      if (typeof thread?.parentDedupeKey === "string") {
        const parent = await tx.notificationEvent.findUnique({where:{dedupeKey:thread.parentDedupeKey},select:{id:true}});
        if (!parent) throw new Error("이전할 쓰레드 원본 알림이 없습니다.");
        await ensureDelivery(parent.id,destinationKey);
      }
    };
    const pending = await tx.notificationDelivery.findMany({where:pendingWhere,select:{id:true,eventId:true,destinationKey:true}});
    for (const delivery of pending) await ensureDelivery(delivery.eventId,delivery.destinationKey);
    const incidents = await tx.operationalIncident.findMany({where:{status:{in:["OPEN","ACKNOWLEDGED"]}},select:{id:true,destinationKey:true}});
    for (const incident of incidents) {
      const event = await tx.notificationEvent.upsert({where:{dedupeKey:`slack-cutover:incident:${incident.id}`},create:{dedupeKey:`slack-cutover:incident:${incident.id}`,kind:"INCIDENT",payload:{incidentId:incident.id}},update:{},select:{id:true}});
      await ensureDelivery(event.id,incident.destinationKey);
    }
    const approvals = await tx.deploymentApproval.findMany({where:{providerState:"WAITING",actionState:"IDLE"},select:{id:true}});
    for (const approval of approvals) {
      const event = await tx.notificationEvent.upsert({where:{dedupeKey:`platform-approval:${approval.id}`},create:{dedupeKey:`platform-approval:${approval.id}`,kind:"OPS_ALERT",payload:{deploymentApprovalId:approval.id}},update:{payload:{deploymentApprovalId:approval.id}},select:{id:true}});
      await ensureDelivery(event.id,"release-ops");
    }
    const suppressed = pending.length ? await tx.notificationDelivery.updateMany({where:{...pendingWhere,id:{in:pending.map(row=>row.id)}},data:{status:"SUPPRESSED",suppressedAt:new Date(),suppressionReason:"PROVIDER_MIGRATED_SLACK",refreshRequested:false}}) : {count:0};
    const expired = await tx.operatorCommandRun.updateMany({where:{...oldProvider,status:"AWAITING_CONFIRMATION"},data:{status:"EXPIRED",completedAt:new Date(),summary:"Slack 전환으로 이전 서비스의 확인 요청 만료"}});
    const result = {applied:true,...readback,createdSlackDeliveries:copied,suppressedDiscordDeliveries:suppressed.count,expiredDiscordConfirmations:expired.count};
    await tx.auditLog.create({data:{action:"notification.slack_cutover",entityType:"notification_provider",entityId:CUTOVER_ID,payload:result}});
    return result;
  },{timeout:60000});
}
