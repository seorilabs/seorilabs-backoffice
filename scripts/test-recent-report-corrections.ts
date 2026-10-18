import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { correctRecentDailyReports, prepareDailyReport, publishDailyReport } from "@/lib/report/daily-publication";
import { getOrgReport } from "@/lib/core/org-report";
import { metricDayOf, metricDayWindow, shiftMetricDay, toDbDay } from "@/lib/analytics/metric-day";
import { dailyReportCsv } from "@/lib/report/daily-csv";

const now = new Date("2026-10-19T03:00:00Z");
const today = metricDayOf(now), day = (offset: number) => shiftMetricDay(today, -offset);
const appId = "qa-recent-report-corrections", trigger = "qa_recent_correction_failure";
const artifactDir = process.env.RECENT_REPORT_TEST_ARTIFACT_DIR;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), syntheticOnly: true, actualExternalCalls: 0 };
let triggerCreated = false;

// CREATE TRIGGER는 MySQL prepared protocol에서 지원되지 않아 로컬 client를 쓴다.
// 비밀번호는 명령 인자나 로그에 넣지 않고 자식 프로세스 환경으로만 전달한다.
function executeTestDdl(sql: string) {
  const database = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["127.0.0.1", "localhost"].includes(database.hostname) && /qa|test/i.test(database.pathname));
  execFileSync(process.env.MYSQL_TEST_CLIENT ?? "mysql", ["--protocol=TCP", `--host=${database.hostname}`, `--port=${database.port || "3306"}`, `--user=${decodeURIComponent(database.username)}`, decodeURIComponent(database.pathname.slice(1))], {
    input: `DELIMITER //\n${sql}//\n`, env: { ...process.env, MYSQL_PWD: decodeURIComponent(database.password) }, stdio: ["pipe", "pipe", "pipe"],
  });
}

async function save(name: string, value: unknown) {
  if (!artifactDir) return;
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, name + ".json"), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

async function report(date: string, version?: number) {
  const result = await getOrgReport(date, now, version);
  assert.ok(result, `발행본 ${date}가 있어야 합니다.`);
  return result;
}

async function state() {
  const reports = await prisma.orgReportDaily.findMany({ orderBy: { date: "asc" } });
  const revisions = await prisma.orgReportRevision.findMany({ orderBy: [{ date: "asc" }, { version: "asc" }] });
  const events = await prisma.notificationEvent.findMany({ orderBy: { id: "asc" } });
  const deliveries = await prisma.notificationDelivery.findMany({ orderBy: { id: "asc" } });
  return { reports, revisions, events, deliveries };
}

async function markSyntheticSent() {
  for (const delivery of await prisma.notificationDelivery.findMany()) {
    await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: {
      status: "SENT", providerMessageId: `qa-recent-message-${delivery.id}`, sentAt: now, refreshRequested: false,
    } });
  }
}

async function main() {
  const database = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["127.0.0.1", "localhost"].includes(database.hostname) && /qa|test/i.test(database.pathname), "localhost의 격리 QA DB가 필요합니다.");
  for (const key of ["FEATURE_CLAUDE_ENABLED", "FEATURE_GEMINI_ENABLED", "FEATURE_MINIMAX_ENABLED"]) process.env[key] = "false";
  for (const key of ["CLAUDE_API_KEY_IH", "GEMINI_API_KEY", "MINIMAX_API_KEY"]) process.env[key] = "";
  assert.equal(await prisma.app.count(), 0, "새 격리 DB를 사용하세요. 기존 자료를 지우지 않습니다.");
  assert.equal(await prisma.orgReportDaily.count(), 0, "발행본이 없는 새 격리 DB가 필요합니다.");
  evidence.database = database.pathname;
  await prisma.app.create({ data: { id: appId, slug: appId, displayName: "QA 지연 자료", repoFullName: `isolated/${appId}`, type: "APP", engine: "RN", marketTargets: ["web"], firebaseProject: appId, ga4Dataset: "analytics_990000901" } });
  for (const date of metricDayWindow(day(1), 20)) {
    await prisma.appMetricDaily.create({ data: { appId, date: toDbDay(date), dau: 10, dauWeb: 10, newUsers: 3 } });
    await prisma.metricCollectionLedger.create({ data: { source: "ga4", appId, day: toDbDay(date), state: "observed", sealed: true, observedAt: new Date(day(30) + "T01:00:00Z"), observations: 2 } });
  }
  const original = new Map<string, { hash: string; csv: string; weekly: number }>();
  for (const date of [day(9), day(6), day(2), day(1)]) {
    const next = shiftMetricDay(date, 1);
    await prepareDailyReport(new Date(next + "T01:45:00Z"), date);
    assert.equal((await publishDailyReport(new Date(next + "T02:00:00Z"), date)).version, 1);
    const doc = (await report(date, 1)).doc;
    original.set(date, { hash: digest(doc), csv: dailyReportCsv(doc, 1), weekly: doc.edition!.weekly.length });
  }
  const legacy = JSON.parse(JSON.stringify((await report(day(6), 1)).doc));
  legacy.refDate = day(3); delete legacy.edition;
  await prisma.orgReportDaily.create({ data: { date: toDbDay(day(3)), version: 1, schemaVersion: 1, report: legacy } });
  const unpublished = JSON.parse(JSON.stringify((await report(day(6), 1)).doc));
  unpublished.refDate = day(5); delete unpublished.published;
  await prisma.orgReportDaily.create({ data: { date: toDbDay(day(5)), version: 1, schemaVersion: 1, report: unpublished } });
  const ignoredBefore = await prisma.orgReportDaily.findMany({ where: { date: { in: [toDbDay(day(9)), toDbDay(day(5)), toDbDay(day(3))] } }, orderBy: { date: "asc" } });
  await markSyntheticSent();
  const originalEventIds = (await prisma.notificationEvent.findMany()).map((event) => event.id).sort();
  const sourceIds = (await prisma.appMetricDaily.findMany({ orderBy: { id: "asc" } })).map((row) => row.id);
  await prisma.appMetricDaily.update({ where: { appId_date: { appId, date: toDbDay(day(6)) } }, data: { dau: 20, dauWeb: 20 } });
  await prisma.appMetricDaily.update({ where: { appId_date: { appId, date: toDbDay(day(9)) } }, data: { dau: 30, dauWeb: 30 } });
  const first = await correctRecentDailyReports(now);
  assert.equal(first.from, day(8)); assert.equal(first.to, day(1));
  assert.deepEqual(first.results.map((result) => result.day), [day(1), day(2), day(6)]);
  assert.equal(first.processed, 3); assert.equal(first.corrected, 3);
  assert.ok(first.results.every((result) => result.action === "corrected" && result.version === 2 && result.requeued === 1));
  assert.equal((await report(day(6))).doc.summary.ga4.dau, 20);
  assert.equal((await report(day(9))).doc.summary.ga4.dau, 10);
  await save("first-correction", { first, state: await state() });
  evidence.originalWeekly = Object.fromEntries([...original].map(([date, expected]) => [date, expected.weekly]));
  const afterFirstWeekly = Object.fromEntries(await Promise.all([...original].map(async ([date]) => [date, (await report(date)).doc.edition!.weekly.length])));
  evidence.afterFirstWeekly = afterFirstWeekly;
  assert.equal(original.get(day(1))!.weekly, 2); assert.equal(original.get(day(6))!.weekly, 0);
  for (const [date, expected] of original) assert.equal(afterFirstWeekly[date], expected.weekly, `정정일의 요일로 ${date} 발행본의 주간 분석을 바꾸면 안 됩니다.`);
  await markSyntheticSent();
  const settled = await state();
  const repeated = await correctRecentDailyReports(new Date(now.getTime() + 60_000));
  assert.equal(repeated.corrected, 0);
  assert.ok(repeated.results.every((result) => result.action === "none" && result.version === 2 && result.requeued === 0));
  assert.deepEqual(await state(), settled, "같은 사실의 반복은 저장본과 알림을 변경하지 않습니다.");

  // 실제 중간 날짜의 저장 실패를 만든다. 먼저 완료한 날짜의 transaction은 보존한다.
  for (const offset of [1, 2, 6]) await prisma.appMetricDaily.update({ where: { appId_date: { appId, date: toDbDay(day(offset)) } }, data: { dau: 10 + offset, dauWeb: 10 + offset } });
  executeTestDdl(`CREATE TRIGGER ${trigger} BEFORE INSERT ON org_report_revision FOR EACH ROW BEGIN IF NEW.date = '${day(2)}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'QA_MID_CORRECTION_FAILURE'; END IF; END`);
  triggerCreated = true;
  let databaseFailure: unknown;
  const nextDay = now.getTime() + 86_400_000;
  try { await correctRecentDailyReports(new Date(nextDay + 120_000)); } catch (error) { databaseFailure = error; }
  assert.ok(databaseFailure, "중간 날짜의 실제 DB 실패를 호출자가 받아야 합니다.");
  assert.match(String(databaseFailure), /QA_MID_CORRECTION_FAILURE/);
  assert.equal((await report(day(1))).version, 3);
  assert.equal((await report(day(2))).version, 2);
  assert.equal((await report(day(6))).version, 2);
  const completedFirst = await prisma.orgReportDaily.findUniqueOrThrow({ where: { date: toDbDay(day(1)) } });
  const firstEvent = await prisma.notificationEvent.findUniqueOrThrow({ where: { dedupeKey: (await report(day(1))).doc.published!.dedupeKey } });
  const firstDeliveries = await prisma.notificationDelivery.findMany({ where: { eventId: firstEvent.id } });
  await save("partial-database-failure", { error: String(databaseFailure), state: await state() });
  executeTestDdl(`DROP TRIGGER ${trigger}`); triggerCreated = false;
  const retry = await correctRecentDailyReports(new Date(nextDay + 180_000));
  assert.deepEqual(retry.results.map((result) => [result.day, result.action, result.version, result.requeued]), [[day(1), "none", 3, 0], [day(2), "corrected", 3, 1], [day(6), "corrected", 3, 1]]);
  assert.deepEqual(await prisma.orgReportDaily.findUniqueOrThrow({ where: { date: toDbDay(day(1)) } }), completedFirst);
  assert.deepEqual(await prisma.notificationEvent.findUniqueOrThrow({ where: { id: firstEvent.id } }), firstEvent);
  assert.deepEqual(await prisma.notificationDelivery.findMany({ where: { eventId: firstEvent.id } }), firstDeliveries);
  assert.equal((await report(day(6))).doc.summary.ga4.dau, 16);
  await markSyntheticSent();
  const afterRetry = await state();
  const finalRepeat = await correctRecentDailyReports(new Date(nextDay + 240_000));
  assert.equal(finalRepeat.corrected, 0);
  assert.ok(finalRepeat.results.every((result) => result.action === "none" && result.version === 3 && result.requeued === 0));
  assert.deepEqual(await state(), afterRetry);
  for (const [date, expected] of original) {
    const v1 = (await report(date, 1)).doc;
    assert.equal(digest(v1), expected.hash); assert.equal(dailyReportCsv(v1, 1), expected.csv);
    assert.equal((await report(date)).doc.edition!.weekly.length, expected.weekly, "화요일 정정도 원래 발행일의 주간 분석을 보존합니다.");
  }
  assert.deepEqual(await prisma.orgReportDaily.findMany({ where: { date: { in: [toDbDay(day(9)), toDbDay(day(5)), toDbDay(day(3))] } }, orderBy: { date: "asc" } }), ignoredBefore);
  assert.equal(await prisma.orgReportDaily.count({ where: { date: toDbDay(day(4)) } }), 0);
  assert.deepEqual((await prisma.notificationEvent.findMany()).map((event) => event.id).sort(), originalEventIds);
  assert.deepEqual((await prisma.appMetricDaily.findMany({ orderBy: { id: "asc" } })).map((row) => row.id), sourceIds);
  assert.equal((await prisma.appMetricDaily.findUniqueOrThrow({ where: { appId_date: { appId, date: toDbDay(day(9)) } } })).dau, 30);
  assert.equal(await prisma.agentRun.count(), 0); assert.equal(await prisma.aiUsage.count(), 0);
  evidence.status = "passed"; evidence.first = first; evidence.repeat = repeated; evidence.partialFailure = "actual MySQL trigger, middle transaction rollback"; evidence.retry = retry; evidence.finalRepeat = finalRepeat;
  evidence.preserved = { originalV1: 4, legacy: true, unpublished: true, absent: true, outsideD9: true, sourceIds: true, eventIds: true, actualWorkerRuns: 0, aiUsage: 0 };
  await save("final-state", await state());
  console.log(JSON.stringify({ ok: true, recentEightDays: "passed", lateD6: "passed", outsideAndLegacy: "passed", immutableV1: "passed", repeatedNoop: "passed", actualDatabaseFailureAndRetry: "passed", noDuplicateVersionOrEvent: "passed" }));
}

main().catch((error) => { evidence.status = "failed"; evidence.error = String(error.stack ?? error); console.error(error); process.exitCode = 1; }).finally(async () => {
  if (triggerCreated) {
    try { executeTestDdl(`DROP TRIGGER ${trigger}`); } catch (error) { evidence.triggerCleanupError = String(error); process.exitCode = 1; }
  }
  evidence.completedAt = new Date().toISOString();
  await save("recent-corrections-proof", evidence);
  await prisma.$disconnect();
});
