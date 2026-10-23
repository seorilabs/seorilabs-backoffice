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
  const tx = { sourceCollectionRun: model(runs), notificationEvent: model(events), operationalIncident: model(incidents) };
  const db = { async $transaction(run: (tx: unknown) => Promise<unknown>) {
    const backup = structuredClone([runs, events, incidents]);
    try { return await run(tx); } catch (error) { [runs, events, incidents].forEach((rows, i) => rows.splice(0, rows.length, ...backup[i])); throw error; }
  } } as unknown as Pick<PrismaClient, "$transaction">;
  return { runs, events, incidents, db, reject: () => { rejectNotification = true; } };
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
  assert.equal(m.runs.length, 3);
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
