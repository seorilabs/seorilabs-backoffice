// 운영 DB와 알림 연결 없이 현재 규모 이상의 자료 읽기와 이미지 생성을 8일 반복한다.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import { providerMetricSeries } from "../src/lib/analytics/report-query";
import { metricSourceInventory } from "../src/lib/analytics/source-inventory";
import { dailyReportImage } from "../src/lib/report/daily-publication";
import { shiftMetricDay, toDbDay } from "../src/lib/analytics/metric-day";
import type { OrgReportDocument } from "../src/lib/core/org-report-schema";

const accountId = "11111111-1111-1111-1111-111111111111";
const apps = Array.from({ length: 32 }, (_, i) => ({ id: `fixture-${i}`, slug: `fixture-${i}`, displayName: `검증 앱 ${i}`, iosBundle: `com.example.fixture${i}`, playPackage: null,
  firebaseProject: null, ga4Dataset: null, aitWorkspaceId: null, aitMiniAppId: null,
  configRevisions: [{ revision: 1, payload: { schemaVersion: 1, markets: [], analyticsSources: [{ id: "apple", source: "apple-analytics", enabled: true, accountId, resourceId: String(i + 1), timeZone: "UTC", credentialId: "shared/apple/app-store-connect-uploader" }] } }],
}));
let end = "2026-10-21", maxBatchRead = 0, totalJsonBytes = 0;
const db = {
  app: { findMany: async () => apps },
  $queryRaw: async () => Array.from({ length: 1280 }, (_, i) => ({ id: String(i) })),
  metricCollectionLedger: { findMany: async () => [] },
  sourceCollectionRun: { groupBy: async () => [] },
  metricReportBatch: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
    maxBatchRead = Math.max(maxBatchRead, where.id.in.length);
    assert.ok(where.id.in.length <= 32, "원본 묶음 상한");
    return where.id.in.map((id) => {
      const index = Number(id), app = index % 32, date = toDbDay(shiftMetricDay(end, -Math.floor(index / 320)));
      const rows = Array.from({ length: index === 0 ? 264 : 48 }, (_, n) => ({ metric: "store_downloads", value: n, numerator: null, denominator: null, dimensions: { Country: `country-${n}-${"x".repeat(192)}`, "Download Type": "First-time" }, currency: null, state: "observed", valueStatus: "analyzable" }));
      if (end === "2026-10-21") totalJsonBytes += Buffer.byteLength(JSON.stringify(rows));
      return { id, appId: `fixture-${app}`, source: "apple-analytics", accountId, resourceId: String(app + 1), reportType: `Report-${Math.floor(index / 32) % 10}`, periodStart: date, periodEnd: date, grain: "daily", timeZone: "UTC", processingDate: date,
        configRevisionId: "config", sourceHash: "a".repeat(64), sourceUri: `https://api.appstoreconnect.apple.com/v1/analyticsReportInstances/fixture-${id}`, runId: "fixture-run", rows };
    });
  } },
} as unknown as Prisma.TransactionClient;

async function main() {
  const started = Date.now();
  const samples = [];
  for (let day = 0; day < 8; day++) {
    end = shiftMetricDay("2026-10-21", -day);
    const sources = await metricSourceInventory(end, db);
    const providerMetrics = await providerMetricSeries(end, db);
    const trend = Array.from({ length: 28 }, (_, i) => ({ date: shiftMetricDay(end, i - 27), ga4Dau: i, ga4NewUsers: i, consoleIaaKrw: i, consoleIapTrxKrw: i }));
    const doc = { refDate: end, summary: { ga4: { apps: 32, dau: 100 } }, apps: [], edition: { sources, providerMetrics, trend } } as unknown as OrgReportDocument;
    const bytes = Buffer.byteLength(JSON.stringify(doc));
    assert.ok(bytes >= 2.5 * 1024 * 1024, "운영 보고서 크기 이상의 fixture");
    assert.ok(providerMetrics.length === 320 && providerMetrics.every((one) => one.points.length === 4));
    const image = await dailyReportImage(doc);
    assert.ok(image.base64.length > 1000);
    if (day === 7) writeFileSync("/tmp/report-memory-qa.png", Buffer.from(image.base64, "base64"));
    samples.push({ day: end, documentBytes: bytes, ...process.memoryUsage() });
    process.stderr.write(JSON.stringify({ day: end, documentBytes: bytes, rssMiB: process.memoryUsage().rss / 1024 / 1024 }) + "\n");
  }
  const peakMiB = process.resourceUsage().maxRSS / 1024;
  console.log(JSON.stringify({ days: 8, partitionsPerRead: 1280, maxRowsPerPartition: 264, typicalRowsPerPartition: 48, sourceJsonMiBPerPass: totalJsonBytes / 2 / 1024 / 1024,
    maxBatchRead, peakMiB, elapsedMs: Date.now() - started, samples }));
  assert.ok(peakMiB <= 600, `최고 RSS ${peakMiB}MiB`);
  assert.ok(Date.now() - started < 280_000, "정정 실행 예산");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
