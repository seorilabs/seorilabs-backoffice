import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { prepareDailyReport, publishDailyReport, correctDailyReport } from "@/lib/report/daily-publication";
import { getOrgReport } from "@/lib/core/org-report";
import { toDbDay, metricDayWindow } from "@/lib/analytics/metric-day";
import { dailyReportCsv } from "@/lib/report/daily-csv";
import { reportDecision } from "@/lib/notifications/report-policy";

// 실제 account·provider를 사용하지 않는다. 실행 경계가 만든 격리 DB에서만 수행한다.
async function main() {
  const database = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["127.0.0.1", "localhost"].includes(database.hostname) && /qa|test/.test(database.pathname), "격리 QA DB가 필요합니다.");
  const date = "2026-08-31", id = "qa-unified-daily-report";
  assert.equal(await prisma.orgReportPreparation.count({ where: { date: { in: [toDbDay(date), toDbDay("2026-09-01")] } } }), 0, "새 격리 DB를 사용하세요. 기존 자료를 지우지 않습니다.");
  const app = await prisma.app.create({ data: { id, slug: id, displayName: "=QA 고정 입력", repoFullName: `qa/${id}`, repoId: 990000123n, type: "APP", engine: "RN", marketTargets: ["web"], firebaseProject: id, ga4Dataset: "analytics_990000123" } });
  const days = metricDayWindow(date, 8);
  for (const [index, day] of days.entries()) {
    await prisma.appMetricDaily.create({ data: { appId: app.id, date: toDbDay(day), dau: 10 + index, newUsers: 3, dauWeb: 10 + index } });
    await prisma.metricCollectionLedger.create({ data: { source: "ga4", appId: app.id, day: toDbDay(day), state: "observed", sealed: true, observedAt: new Date("2026-09-01T01:40:00Z"), observations: 2 } });
  }
  await assert.rejects(prepareDailyReport(new Date("2026-09-01T01:44:59.999Z")), /REPORT_BEFORE_CUTOFF/);
  await assert.rejects(publishDailyReport(new Date("2026-09-01T01:59:59.999Z")), /REPORT_BEFORE_PUBLICATION/);
  const cost = (total: number) => ({ month: "2026-09", summaryLines: ["격리 비용 근거"], warnings: [], figures: { github: null, gcp: { total, currency: "USD" }, llm: null, stability: null } });
  await prisma.sourceCollectionRun.createMany({ data: [
    { source: "finance-costs", target: "2026-09", status: "partial", completedAt: new Date("2026-09-01T01:40:00Z"), coverage: cost(1) },
    { source: "finance-costs", target: "2026-09", status: "partial", completedAt: new Date("2026-09-01T01:46:00Z"), coverage: cost(999) },
  ] });
  const prepared = await prepareDailyReport(new Date("2026-09-01T01:45:00Z"));
  assert.equal(prepared.reused, false);
  await prisma.appMetricDaily.update({ where: { appId_date: { appId: app.id, date: toDbDay(date) } }, data: { dau: 999, dauWeb: 999 } });
  const duplicatePreparation = await prepareDailyReport(new Date("2026-09-01T01:50:00Z"));
  assert.equal(duplicatePreparation.reused, true);
  const published = await Promise.all([publishDailyReport(new Date("2026-09-01T02:00:00Z")), publishDailyReport(new Date("2026-09-01T02:00:00Z"))]);
  assert.deepEqual(published.map((result) => result.version), [1, 1]);
  const original = await getOrgReport(date, new Date(), 1);
  assert.equal(original?.doc.summary.ga4.dau, 17);
  assert.equal(original?.doc.costs?.figures.gcp?.total, 1, "컷오프 뒤의 비용은 발행본에 들어가지 않는다");
  assert.equal(original?.doc.edition?.trend.at(-1)?.ga4Dau, 17);
  assert.equal(original?.doc.edition?.frozenAt, "2026-09-01T01:45:00.000Z");
  const initialEvent = await prisma.notificationEvent.findUniqueOrThrow({ where: { dedupeKey: original!.doc.published!.dedupeKey } });
  const initialPayload = initialEvent.payload as { text: string; attachment?: { base64?: string } };
  assert.match(initialPayload.text, /v1/);
  assert.ok(reportDecision({ kind: initialEvent.kind, dedupeKey: initialEvent.dedupeKey, payload: initialPayload }).send);
  assert.ok(initialPayload.attachment?.base64, "준비 단계에서 만든 그림을 같은 버전과 발행해야 합니다.");
  await prisma.notificationDelivery.updateMany({ where: { eventId: initialEvent.id }, data: { status: "SENT", providerMessageId: "qa-provider-message", sentAt: new Date() } });
  const correction = await correctDailyReport(new Date("2026-09-01T02:15:00Z"), date);
  assert.equal(correction.version, 2);
  assert.equal((await getOrgReport(date, new Date(), 1))?.doc.summary.ga4.dau, 17);
  const corrected = await getOrgReport(date, new Date(), 2);
  assert.equal(corrected?.doc.summary.ga4.dau, 999);
  assert.equal(corrected?.doc.edition?.trend.at(-1)?.ga4Dau, 999);
  const delivery = await prisma.notificationDelivery.findFirstOrThrow({ where: { eventId: initialEvent.id } });
  assert.equal(delivery.status, "PENDING");
  assert.equal(delivery.providerMessageId, "qa-provider-message");
  assert.equal(await prisma.notificationEvent.count({ where: { dedupeKey: initialEvent.dedupeKey } }), 1);
  assert.equal((await correctDailyReport(new Date("2026-09-01T02:16:00Z"), date)).action, "none");
  const csv = dailyReportCsv(corrected!.doc, 2);
  assert.ok(csv.includes("999"));
  assert.ok(csv.includes("'=QA 고정 입력"), "CSV의 앱 이름을 수식으로 실행하면 안 됩니다.");
  await prisma.appMetricDaily.update({ where: { appId_date: { appId: app.id, date: toDbDay("2026-08-30") } }, data: { cohortUsers: 10, d1Users: 2, d1Pct: 20 } });
  const maturity = await correctDailyReport(new Date("2026-09-01T02:16:30Z"), date);
  assert.equal(maturity.action, "corrected", "성숙한 코호트의 새 관측도 새 버전에 보존합니다.");
  assert.ok((await getOrgReport(date))?.doc.edition?.changes.some((row) => row.label.includes("코호트")));
  await prisma.metricCollectionLedger.updateMany({ where: { appId: app.id, day: toDbDay(date), source: "ga4" }, data: { state: "not_landed", sealed: false } });
  await correctDailyReport(new Date("2026-09-01T02:17:00Z"), date);
  const missing = await getOrgReport(date);
  assert.equal(missing?.doc.summary.ga4.apps, 0);
  assert.equal(missing?.doc.edition?.trend.at(-1)?.ga4Dau, null);
  assert.equal(missing?.doc.apps.find((row) => row.slug === id)?.ga4, null);
  const fallback = await publishDailyReport(new Date("2026-09-02T02:00:00Z"));
  assert.equal(fallback.version, 1);
  const fallbackDoc = await getOrgReport("2026-09-01", new Date(), 1);
  assert.equal(fallbackDoc?.doc.summary.ga4.apps, 0);
  const legacyDate = "2026-08-29";
  const legacyDoc = { ...original!.doc, refDate: legacyDate };
  delete legacyDoc.edition;
  await prisma.orgReportDaily.create({ data: { date: toDbDay(legacyDate), version: 1, schemaVersion: 1, report: JSON.parse(JSON.stringify(legacyDoc)) } });
  await assert.rejects(publishDailyReport(new Date("2026-09-02T02:00:00Z"), legacyDate), /REPORT_ALREADY_PUBLISHED/);
  assert.equal((await correctDailyReport(new Date("2026-09-02T02:00:00Z"), legacyDate)).action, "none");
  console.log(JSON.stringify({ ok: true, preparationId: prepared.preparationId, cutoff: "passed", duplicate: "passed", lateInput: "passed", immutableVersion: "passed", correctionAndMessageReuse: "passed", missingIsNotZero: "passed", csv: "passed", preparationFallback: "passed" }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
