import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retryPrismaConflict } from "@/lib/prisma-conflict";
import { recordIncident, recoverIncident } from "@/lib/notifications/incidents";
import { isCollectionBatch, recordCollectionIssue } from "@/lib/notifications/collection-issues";
import { batchName } from "./notification";
import { BATCH_SOURCE, OBSERVER_SOURCE, batchInputSchema, expectedSchedules, incidentAction,
  type BatchInput, type CronObservation } from "./contract";

const REPORTING_ID = "operations-batch-reporting:vzyx-cluster";
const OBSERVER_ID = "operations-batch-observer:vzyx-cluster";
type ObserverCoverage = { cronJobs: CronObservation[]; gaps: { start: string; end: string }[] };
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;

async function saveRuns(tx: Prisma.TransactionClient, input: BatchInput, now: Date, activatedAt: Date) {
  const entries = input.kind === "kubernetes" ? input.runs.map((run) => ({ ...run,
    id: `batch:k8s:${run.id}`, target: `k8s:${run.namespace}:${run.name}`, expected: null, verified: null }))
    : [{ ...input.run, id: `batch:local:${input.run.id}`, target: `local:${input.run.name}`, scheduledAt: input.run.startedAt }];
  const seen = new Map((await tx.sourceCollectionRun.findMany({ where: { id: { in: entries.map((r) => r.id) } } })).map((row) => [row.id, row]));
  const finished: Date[] = [];
  for (const run of entries.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))) {
    const prior = seen.get(run.id);
    // 종료된 Job에 늦게 도착한 진행 관측과 재전송은 상태를 되돌리지 않는다.
    if (prior && prior.target !== run.target) throw Error("BATCH_RUN_CONFLICT");
    if (prior && prior.status !== "running") continue;
    if (run.status === "succeeded" && run.expected != null && run.expected !== run.verified) throw Error("BATCH_INVALID_VALIDATION");
    const startedAt = new Date(run.startedAt);
    const completedAt = run.completedAt ? new Date(run.completedAt) : null;
    if (startedAt > new Date(now.getTime() + 60_000) || completedAt && (completedAt < startedAt || completedAt > new Date(now.getTime() + 60_000))
      || (run.status === "running") !== (completedAt === null)) throw Error("BATCH_INVALID_TIME");
    const latest = await tx.sourceCollectionRun.findFirst({ where: { source: BATCH_SOURCE, target: run.target,
      status: { in: ["succeeded", "failed"] } }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
    const data = { source: BATCH_SOURCE, target: run.target, status: run.status, startedAt, completedAt, coverage: json({ ...run, lastObservedAt: now.toISOString() }) };
    await tx.sourceCollectionRun.upsert({ where: { id: run.id }, create: { id: run.id, ...data }, update: data });
    // 도입 시 남아 있는 이력은 집계에 쓰며 과거 장애의 신규 알림은 보내지 않는다.
    if (!completedAt || input.kind === "kubernetes" && completedAt < activatedAt) continue;
    finished.push(completedAt);
    if (isCollectionBatch(run.name)) {
      if (latest?.startedAt && startedAt < latest.startedAt) continue;
      await recordCollectionIssue({job:run.name,runId:run.id,at:completedAt,failed:run.status === "failed",target:batchName(run.name),items:["예약 수집 실행"],period:run.scheduledAt ?? run.startedAt,cause:("errorCode" in run ? run.errorCode : undefined) ?? "프로세스 실패. 실행 로그에서 세부 원인 확인 필요",action:"실행 로그와 등록된 운영 연결을 확인하세요."},tx);
      continue;
    }
    const action = incidentAction(run.status, startedAt, latest?.startedAt ?? null);
    if (action === "fail") await recordIncident({ source: BATCH_SOURCE, kind: run.target, severity: "warning",
      summary: `${batchName(run.name)} 실패`, signalId: run.id, detectedAt: completedAt,
      evidence: { impact: "이 실행의 작업 결과가 완료되지 않았습니다.", action: "배치 실행 상태와 수집 결과를 확인하세요.",
        runId: run.id, startedAt: run.startedAt, completedAt: completedAt.toISOString() } }, tx);
    if (action === "recover") await recoverIncident({ source: BATCH_SOURCE, kind: run.target, signalId: run.id, recoveredAt: completedAt }, tx);
  }
  return { accepted: entries.length, finished };
}

export async function ingestBatchResults(raw: unknown, now = new Date(), db: Pick<PrismaClient, "$transaction"> = prisma) {
  const input = batchInputSchema.parse(raw);
  return retryPrismaConflict(() => db.$transaction(async (tx) => {
    const reporting = await tx.sourceCollectionRun.upsert({ where: { id: REPORTING_ID }, update: {},
      create: { id: REPORTING_ID, source: OBSERVER_SOURCE, target: "vzyx-cluster:reporting", status: "observed", startedAt: now, completedAt: now } });
    let observer = await tx.sourceCollectionRun.findUnique({ where: { id: OBSERVER_ID } });
    if (input.kind === "kubernetes") {
      const observedAt = new Date(input.observedAt);
      if (Math.abs(observedAt.getTime() - now.getTime()) > 120_000) throw Error("BATCH_INVALID_TIME");
      if (observer?.completedAt && observedAt <= observer.completedAt) return { accepted: 0 };
      const prior = observer?.coverage as unknown as ObserverCoverage | undefined;
      const gaps = (prior?.gaps ?? []).filter((gap) => new Date(gap.end).getTime() > now.getTime() - 31 * 86400_000);
      if (observer?.completedAt && observedAt.getTime() - observer.completedAt.getTime() > 150_000)
        gaps.push({ start: observer.completedAt.toISOString(), end: observedAt.toISOString() });
      const data = { completedAt: observedAt, coverage: json({ cronJobs: input.cronJobs, gaps }), status: "observed" };
      observer = await tx.sourceCollectionRun.upsert({ where: { id: OBSERVER_ID },
        create: { id: OBSERVER_ID, source: OBSERVER_SOURCE, target: "vzyx-cluster", startedAt: now, ...data }, update: data });
    }
    const { accepted } = await saveRuns(tx, input, now, reporting.startedAt);
    if(input.kind === "kubernetes")await reportCollectionGaps(tx,input.cronJobs,now,reporting.startedAt);
    return { accepted };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 55_000 }));
}

/** 정상 건수 요약 대신, 보존된 실행 이력으로 확인할 수 없는 예정 수집만 보고한다. */
async function reportCollectionGaps(tx:Prisma.TransactionClient,crons:CronObservation[],now:Date,activatedAt:Date){
 const end=new Date(now.getTime()-15*60_000),start=new Date(Math.max(activatedAt.getTime(),end.getTime()-86400_000));
 if(end<=start)return;
 for(const cron of crons.filter(c=>isCollectionBatch(c.name) && !c.suspended)){
  const expected=expectedSchedules(cron,start,end);if(expected===null || expected===0)continue;
  const runs=await tx.sourceCollectionRun.findMany({where:{source:BATCH_SOURCE,target:`k8s:${cron.namespace}:${cron.name}`,startedAt:{gte:start,lt:now}},select:{coverage:true}});
  const observed=new Set(runs.map(r=>(r.coverage as {scheduledAt?:string})?.scheduledAt).filter((s):s is string=>!!s && new Date(s)>=start && new Date(s)<end));
  await recordCollectionIssue({job:`missing:${cron.name}`,runId:`${cron.uid}:${end.toISOString()}`,at:now,failed:observed.size<expected,target:batchName(cron.name),items:["예정 수집의 실행 관측 누락"],period:`${start.toISOString()} ~ ${end.toISOString()}`,cause:"예정 시각 뒤 15분이 지났으나 실행 이력을 확인하지 못했습니다. 성공·실패 여부 미확인",action:"CronJob 정지·스케줄·Job 생성과 감시 연결을 확인하세요."},tx);
 }
}
