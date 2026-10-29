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

test("감시 공백과 첫 도입 전 구간을 표시하고 날짜별 요약은 재전송하지 않는다", async () => {
  const m = memory();
  const cron = { namespace: "platform", name: "example", uid: "cron-uid", schedule: "* * * * *", timeZone: "Asia/Seoul", suspended: false, lastScheduleAt: null };
  const observe = (date: Date) => ingestBatchResults({ kind: "kubernetes", observedAt: date.toISOString(), cronJobs: [cron], runs: [] }, date, m.db);
  await observe(now);
  await observe(new Date(now.getTime() + 60_000));
  let summaries = m.events.filter((row) => row.kind === "OPERATIONAL_EVENT");
  assert.equal(summaries.length, 1);
  assert.match(String((summaries[0].payload as Row).text), /관측 공백 있음/);
  await observe(new Date("2026-10-25T00:00:00Z"));
  summaries = m.events.filter((row) => row.kind === "OPERATIONAL_EVENT");
  assert.equal(summaries.length, 2);
  assert.match(String((summaries[1].payload as Row).text), /감시 중단 1구간/);
  assert.ok(!JSON.stringify(m.events).includes("private-feed"));
});


test("KDP는 성공 실행마다 전용 채널에 한 번 보고한다", async () => {
  const m = memory();
  await ingestBatchResults(local(first, "succeeded"), now, m.db);
  await ingestBatchResults(local(first, "succeeded"), now, m.db);
  const events = m.events.filter((row) => row.dedupeKey === `batch-result:batch:local:${first}`);
  assert.equal(events.length, 1);
  assert.match(String((events[0].payload as Row).text), /대조 3개월/);
  assert.deepEqual((events[0].deliveries as Row).create, [{ provider: "SLACK", destinationKey: "batch-monitoring" }]);
});

const reportingStart = new Date("2026-10-24T05:00:00Z");
const cronFor = (name: string, schedule = "0 * * * *") => ({ namespace: "platform", name, uid: `cron-${name}`, schedule, timeZone: "Asia/Seoul", suspended: false, lastScheduleAt: null });
const k8sRun = (name: string, id: string, status: string, at = "2026-10-24T05:02:00Z") => ({ id, namespace: "platform", name, cronUid: `cron-${name}`, startedAt: at, scheduledAt: at, completedAt: status === "running" ? null : new Date(new Date(at).getTime() + 30000).toISOString(), status });
const observeRuns = (m: ReturnType<typeof memory>, crons: ReturnType<typeof cronFor>[], runs: ReturnType<typeof k8sRun>[], now: Date) => ingestBatchResults({ kind: "kubernetes", observedAt: now.toISOString(), cronJobs: crons, runs }, now, m.db);

test("일반 예약 작업의 종료를 한 번 보고하고 기존 이력은 재발송하지 않는다", async () => {
  const m = memory(); const cron = cronFor("backoffice-db-backup");
  await observeRuns(m, [cron], [], reportingStart);
  const run = k8sRun(cron.name, "new-job", "succeeded");
  await observeRuns(m, [cron], [run, k8sRun(cron.name, "old-job", "failed", "2026-10-24T04:00:00Z")], nowFor("05:03"));
  await observeRuns(m, [cron], [run], nowFor("05:04"));
  const events = m.events.filter((row) => String(row.dedupeKey).startsWith("batch-result:"));
  assert.equal(events.length, 1);
  assert.match(String(((events[0].payload as Row).embed as Row).title), /운영 DB 백업 성공/);
});
const nowFor = (time: string) => new Date(`2026-10-24T${time}:00Z`);

test("앱인토스 상세 카드와 Job 관측을 중복 발송하지 않고 종료 실패는 같은 카드를 정정한다", async () => {
  const m = memory(); const cron = cronFor("backoffice-ait-console-metrics");
  await observeRuns(m, [cron], [], reportingStart);
  m.events.push({ id: "detail", dedupeKey: "ait-console-collection:ait-job", payload: { executionStatus: "succeeded", text: "저장 84건", embed: { title: "성공" } } });
  await observeRuns(m, [cron], [k8sRun(cron.name, "ait-job", "failed")], nowFor("05:03"));
  const events = m.events.filter((row) => row.dedupeKey === "ait-console-collection:ait-job");
  assert.equal(events.length, 1);
  assert.equal((events[0].payload as Row).executionStatus, "failed");
  assert.match(String((events[0].payload as Row).text), /저장 84건.*\n종료 확인:/);
  assert.ok(m.requeues() > 0);
  assert.equal(m.incidents.length, 1);
});

test("수집 결과 전에 프로세스가 종료되면 Job 최종 실패를 전용 채널에도 보고한다", async () => {
  const m = memory(); const cron = cronFor("backoffice-ait-console-metrics");
  await observeRuns(m, [cron], [], reportingStart);
  await observeRuns(m, [cron], [k8sRun(cron.name, "crashed-job", "failed")], nowFor("05:03"));
  const event = m.events.find((row) => row.dedupeKey === "ait-console-collection:crashed-job")!;
  assert.equal((event.payload as Row).executionStatus, "failed");
  assert.match(String(((event.payload as Row).embed as Row).title), /앱인토스 지표 수집 실패/);
});

test("매분 성공은 시간별로 묶고 늦게 도착한 관측은 같은 요약을 정정한다", async () => {
  const m = memory(); const cron = cronFor("backoffice-automation-scheduler", "* * * * *");
  await observeRuns(m, [cron], [], reportingStart);
  await observeRuns(m, [cron], [k8sRun(cron.name, "minute-1", "succeeded")], nowFor("05:03"));
  assert.equal(m.events.filter((row) => String(row.dedupeKey).startsWith("batch-result:")).length, 0);
  await observeRuns(m, [cron], [], nowFor("06:00"));
  await observeRuns(m, [cron], [k8sRun(cron.name, "minute-2", "succeeded", "2026-10-24T05:59:00Z")], nowFor("06:01"));
  await observeRuns(m, [cron], [], nowFor("06:02"));
  const events = m.events.filter((row) => String(row.dedupeKey).startsWith("operations-batch-hourly:"));
  assert.equal(events.length, 1);
  assert.match(String((events[0].payload as Row).text), /성공 2회/);
  assert.match(String((events[0].payload as Row).text), /정정/);
  assert.ok(m.requeues() > 0);
});

test("KDP 저장 대조가 맞지 않으면 성공으로 접수하지 않는다", async () => {
  const m = memory(); const input = local(first, "succeeded"); input.run.verified = 2;
  await assert.rejects(ingestBatchResults(input, now, m.db), /BATCH_INVALID_VALIDATION/);
  assert.equal(m.events.length, 0);
});


test("수집을 시작하지 않은 보류 실행이 기존 실패를 복구하지 않는다", async () => {
  const m = memory(); const cron = cronFor("backoffice-ait-console-metrics");
  await observeRuns(m, [cron], [], reportingStart);
  await observeRuns(m, [cron], [k8sRun(cron.name, "first-failure", "failed")], nowFor("05:03"));
  m.events.push({ id: "skipped", dedupeKey: "ait-console-collection:skipped-job", payload: { executionStatus: "skipped" } });
  await observeRuns(m, [cron], [k8sRun(cron.name, "skipped-job", "succeeded", "2026-10-24T05:04:00Z")], nowFor("05:05"));
  assert.equal(m.incidents[0].status, "OPEN");
});
