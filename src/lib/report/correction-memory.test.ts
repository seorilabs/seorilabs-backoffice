import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { transpileModule, ScriptTarget } from "typescript";

const source = readFileSync("src/lib/report/daily-publication.ts", "utf8");
function harness(changed: boolean) {
  const start = source.indexOf("export async function correctDailyReport(");
  const compiled = transpileModule(source.slice(start).replace("export async", "async"), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  const before = { published: { corrections: 0 }, edition: { frozenAt: "2026-10-21" }, value: 1 };
  let images = 0, transactions = 0;
  const db = { orgReportDaily: { findUnique: async () => ({ report: before, version: 3 }) }, $queryRaw: async () => [] };
  const ports = {
    prisma: { ...db, $transaction: async (fn: (value: typeof db) => unknown) => { transactions++; return fn(db); } },
    parseOrgReportDocument: (x: unknown) => x, toDbDay: (x: string) => x,
    freezeDailyReport: async () => ({ doc: { ...before, edition: { frozenAt: "2026-10-22" }, value: changed ? 2 : 1 } }),
    Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
    sameReportFacts: (a: { value: number }, b: { value: number }) => a.value === b.value,
    dailyReportImage: async () => { images++; return null; },
    reportCorrectionDiff: () => [], saveOrgReport: async () => ({ version: 4 }),
    orgReportUrl: () => null, enqueueNotification: async () => "event", requeueNotification: async () => 1,
    renderDailyEdition: () => "fixture report", discordDestinations: () => [], SEORI_SENDER: {},
  };
  const correct = new Function(...Object.keys(ports), `${compiled}; return correctDailyReport;`)(...Object.values(ports));
  return { correct, images: () => images, transactions: () => transactions };
}

test("사실이 같은 보고서는 PNG 생성과 쓰기 트랜잭션을 생략한다", async () => {
  const h = harness(false);
  assert.deepEqual(await h.correct(new Date(), "2026-10-21"), { day: "2026-10-21", action: "none", version: 3, requeued: 0 });
  assert.equal(h.images(), 0); assert.equal(h.transactions(), 1);
});

test("최근 정정은 본문 8개를 동시에 조회하지 않는다", () => {
  const section = source.slice(source.indexOf("export async function correctRecentDailyReports"), source.indexOf("export async function correctDailyReport"));
  assert.match(section, /select: \{ date: true \}/);
  assert.doesNotMatch(section, /report: true/);
});

test("달라진 사실만 이미지를 만들고 새 버전과 같은 메시지 정정을 기록한다", async () => {
  const h = harness(true);
  assert.deepEqual(await h.correct(new Date(), "2026-10-21"), { day: "2026-10-21", action: "corrected", version: 4, requeued: 1 });
  assert.equal(h.images(), 1); assert.equal(h.transactions(), 2);
});
