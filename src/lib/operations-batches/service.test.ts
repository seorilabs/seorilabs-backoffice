import test from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { ingestBatchResults } from "./service";

type Row = Record<string, unknown>;
type Args = { where: Row; data: Row; create: Row; update: Row; orderBy?: Row[] | Row };
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Row[]).some((condition) => matches(row, condition));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const condition = value as { in?: unknown[]; gte?: Date; lt?: Date };
      const actual = row[key] as Date;
      return (!condition.in || condition.in.includes(row[key])) && (!condition.gte || actual >= condition.gte) && (!condition.lt || actual < condition.lt);
    }
    return row[key] === value || row[key] == null && value === null;
  });
}
function memory() {
  const runs: Row[] = []; const events: Row[] = []; const incidents: Row[] = [];
  let rejectNotification = false;
  let requeues = 0;
  const model = (rows: Row[]) => ({
    async findMany({ where }: Args) { return rows.filter((row) => matches(row, where)); },
    async findUnique({ where }: Args) { return rows.find((row) => matches(row, where)) ?? null; },
    async findUniqueOrThrow({ where }: Args) { const row = rows.find((row) => matches(row, where)); if (!row) throw Error("not found"); return row; },
    async findFirst({ where }: Args) { return rows.filter((row) => matches(row, where)).sort((a, b) => Number(b.startedAt ?? b.firstDetectedAt) - Number(a.startedAt ?? a.firstDetectedAt))[0] ?? null; },
    async upsert({ where, create, update }: Args) {
      if (rows === events && rejectNotification) throw Error("notification storage failed");
      const row = rows.find((row) => matches(row, where));
      if (row) { Object.assign(row, update); return row; }
      const next = { id: `id-${rows.length}`, ...create }; rows.push(next); return next;
    },
    async create({ data }: Args) { const row = { id: `id-${rows.length}`, status: "OPEN", ...data }; rows.push(row); return row; },
    async update({ where, data }: Args) { const row = rows.find((row) => matches(row, where))!; Object.assign(row, data); return row; },
    async updateMany({ where, data }: Args) { const found = rows.filter((row) => matches(row, where)); found.forEach((row) => Object.assign(row, data)); return { count: found.length }; },
  });
  const tx = { sourceCollectionRun: model(runs), notificationEvent: model(events), operationalIncident: model(incidents), notificationDelivery: { async updateMany() { requeues++; return { count: 1 }; } } };
  const db = { async $transaction(run: (tx: unknown) => Promise<unknown>) {
    const backup = structuredClone([runs, events, incidents]);
    try { return await run(tx); } catch (error) { [runs, events, incidents].forEach((rows, i) => rows.splice(0, rows.length, ...backup[i])); throw error; }
  } } as unknown as Pick<PrismaClient, "$transaction">;
  return { runs, events, incidents, db, requeues: () => requeues, reject: () => { rejectNotification = true; } };
}
const start = "2026-10-24T00:01:00Z";
const local = (id: string, status: string, startedAt = start) => ({ kind: "local", run: { id, name: "book-sales-kdp", startedAt,
  completedAt: status === "running" ? null : new Date(new Date(startedAt).getTime() + 30_000).toISOString(), status, expected: 3, verified: status === "succeeded" ? 3 : 0 } });
const first = "86c49447-08b4-4989-bd01-910a2bd7070d";
const second = "846aeab9-c873-4de5-ab97-3e5d2452abec";
const now = new Date("2026-10-24T00:03:00Z");

test("실행 재전송은 한 번 저장하고 후속 성공이 같은 장애를 복구한다", async () => {
  const m = memory();
  await ingestBatchResults(local(first, "running"), now, m.db);
  await ingestBatchResults(local(first, "failed"), now, m.db);
  await ingestBatchResults(local(first, "failed"), now, m.db);
  assert.equal(m.incidents.length, 1);
  assert.equal(m.events.filter((row) => row.kind === "INCIDENT").length, 1);
  await ingestBatchResults(local(second, "succeeded", "2026-10-24T00:02:00Z"), now, m.db);
  assert.equal(m.incidents[0].status, "RECOVERED");
  await ingestBatchResults(local("846aeab9-c873-4de5-ab97-3e5d2452abed", "failed", "2026-10-24T00:01:30Z"), now, m.db);
  assert.equal(m.incidents.length, 1);
  assert.equal(m.incidents[0].status, "RECOVERED");
  assert.equal(m.runs.filter((row) => row.source === "scheduled-batch").length, 3);
});

test("알림 대기열 쓰기가 실패하면 실행과 장애 기록도 함께 롤백한다", async () => {
  const m = memory(); m.reject();
  await assert.rejects(ingestBatchResults(local(first, "failed"), now, m.db));
  assert.equal(m.runs.length, 0); assert.equal(m.incidents.length, 0);
});

test("성공 실행·시간별·일일 건수 요약은 발송하지 않는다",async()=>{
 const m=memory();await ingestBatchResults(local(first,"succeeded"),now,m.db);await ingestBatchResults(local(first,"succeeded"),now,m.db);
 await ingestBatchResults({kind:"kubernetes",observedAt:now.toISOString(),cronJobs:[],runs:[]},now,m.db);
 assert.equal(m.events.length,0);assert.equal(m.incidents.length,0);
});
const reportingStart=new Date("2026-10-24T05:00:00Z");
const nowFor=(time:string)=>new Date(`2026-10-24T${time}:00Z`);
const cronFor=(name:string)=>({namespace:"platform",name,uid:`cron-${name}`,schedule:"0 * * * *",timeZone:"Asia/Seoul",suspended:false,lastScheduleAt:null});
const k8sRun=(name:string,id:string,status:string,at="2026-10-24T05:02:00Z")=>({id,namespace:"platform",name,cronUid:`cron-${name}`,startedAt:at,scheduledAt:at,completedAt:status === "running" ? null : new Date(Date.parse(at)+30000).toISOString(),status});
const observeRuns=(m:ReturnType<typeof memory>,crons:ReturnType<typeof cronFor>[],runs:ReturnType<typeof k8sRun>[],at:Date)=>ingestBatchResults({kind:"kubernetes",observedAt:at.toISOString(),cronJobs:crons,runs},at,m.db);
test("수집 프로세스 실패는 수집결과에만 한 번 보고한다",async()=>{
 const m=memory(),cron=cronFor("backoffice-ait-console-metrics");
 await observeRuns(m,[cron],[],reportingStart);const run=k8sRun(cron.name,"job-1","failed");
 await observeRuns(m,[cron],[run],nowFor("05:03"));await observeRuns(m,[cron],[run],nowFor("05:04"));
 assert.equal(m.incidents.length,1);assert.equal(m.incidents[0].destinationKey,"batch-monitoring");assert.equal(m.events.filter(e=>e.kind === "INCIDENT").length,1);
 assert.ok(!JSON.stringify(m.events).includes("ops-alerts"));
});
test("생산자가 같은 실행의 부분 실패를 기록하면 프로세스 성공으로 복구하지 않는다",async()=>{
 const m=memory(),cron=cronFor("backoffice-ait-console-metrics");await observeRuns(m,[cron],[],reportingStart);
 await observeRuns(m,[cron],[k8sRun(cron.name,"failure","failed")],nowFor("05:03"));
 m.events.push({id:"producer",dedupeKey:`incident-observation:collection:${cron.name}:global:partial`,payload:{incidentId:m.incidents[0].id}});
 await observeRuns(m,[cron],[k8sRun(cron.name,"partial","succeeded","2026-10-24T05:04:00Z")],nowFor("05:05"));assert.equal(m.incidents[0].status,"OPEN");
 m.events.push({id:"skip",dedupeKey:`collection-skipped:${cron.name}:skipped`,payload:{}});
 await observeRuns(m,[cron],[k8sRun(cron.name,"skipped","succeeded","2026-10-24T05:06:00Z")],nowFor("05:07"));assert.equal(m.incidents[0].status,"OPEN");
});
test("KDP 저장 대조 불일치는 성공으로 접수하지 않는다",async()=>{
 const m=memory(),input=local(first,"succeeded");input.run.verified=2;await assert.rejects(ingestBatchResults(input,now,m.db),/BATCH_INVALID_VALIDATION/);assert.equal(m.events.length,0);
});

test("예정 수집 관측 누락은 성공률 요약 없이 보고하고 다음 관측에서 복구한다",async()=>{
 const m=memory(),cron=cronFor("backoffice-analytics-collect");await observeRuns(m,[cron],[],reportingStart);
 await observeRuns(m,[cron],[],nowFor("06:16"));
 const missing=m.incidents.find(i=>i.kind===`missing:${cron.name}`);assert.ok(missing);assert.equal(missing.destinationKey,"batch-monitoring");
 assert.match(JSON.stringify(missing.evidence),/성공·실패 여부 미확인/);
 await observeRuns(m,[cron],[k8sRun(cron.name,"gap-1","succeeded","2026-10-24T05:00:00Z"),k8sRun(cron.name,"gap-2","succeeded","2026-10-24T06:00:00Z")],nowFor("06:17"));assert.equal(missing.status,"RECOVERED");
 assert.equal(m.events.filter(e=>String(e.dedupeKey).startsWith("operations-batch-daily")).length,0);
});
