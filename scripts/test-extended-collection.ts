import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { collectExtendedMetrics } from "@/lib/analytics/extended-collect";
import { unifiedMetricRowSchema } from "@/lib/analytics/unified-metrics";
import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname) && /qa|test/.test(url.pathname));
  const appId = "qa-instance-collection"; assert.equal(await prisma.app.count({ where: { id: appId } }), 0);
  const issuer = "11111111-1111-1111-1111-111111111111";
  process.env.APP_STORE_CONNECT_ISSUER_ID = issuer;
  await prisma.app.create({ data: { id: appId, slug: appId, displayName: "격리 인스턴스", repoFullName: `qa/${appId}`, type: "APP", engine: "RN", marketTargets: [], iosBundle: "com.example.cache" } });
  const connection = { id: "apple", source: "apple-analytics" as const, enabled: true, accountId: issuer, resourceId: "123456", timeZone: "UTC", credentialId: "shared/apple/app-store-connect-uploader" };
  const payload = configRevisionPayloadSchema.parse({ schemaVersion: 1, markets: [], analyticsSources: [connection] });
  const revision = await prisma.configRevision.create({ data: { appId, revision: 1, status: "ACTIVE", payload, payloadHash: "a".repeat(64), createdBy: "qa", idempotencyKey: appId } });
  let downloads = 0, identityReads = 0;
  const ports: NonNullable<Parameters<typeof collectExtendedMetrics>[2]> = {
    appleReportCatalog: async () => { identityReads++; return [{ id: "report", type: "analyticsReports", attributes: { name: "App Downloads Standard" }, requestId: "request" }]; },
    appleInstances: async () => [{ id: "complete", type: "analyticsReportInstances", attributes: { processingDate: "2026-10-12" } }, { id: "broken", type: "analyticsReportInstances", attributes: { processingDate: "2026-10-12" } }],
    applePages: async (path) => [{ id: path.includes("complete") ? "complete-segment" : "broken-segment", type: "analyticsReportSegments", attributes: { checksum: "checksum", sizeInBytes: 1, url: "https://example.invalid" } }],
    readAppleInstance: async (input) => { if (input.segments[0].id === "broken-segment") throw new Error("APPLE_SEGMENT_CHECKSUM_MISMATCH"); downloads++; return { rows: [{ day: "2026-10-10", row: unifiedMetricRowSchema.parse({ metric: "store_downloads", value: 5, dimensions: {}, currency: null, state: "observed", valueStatus: "analyzable" }) }], sourceHash: "b".repeat(64), bytes: 1 }; },
    verifyAppleAppIdentity: async () => { throw new Error("unused"); }, readPlayInstallReport: async () => { throw new Error("unused"); }, readAdmob: async () => { throw new Error("unused"); }, readVitals: async () => { throw new Error("unused"); },
  };
  assert.equal((await collectExtendedMetrics(new Date("2026-10-18T01:00:00Z"), appId, ports)).results[0].status, "partial");
  assert.equal(downloads, 1);
  await prisma.configRevision.update({ where: { id: revision.id }, data: { status: "SUPERSEDED" } });
  await prisma.configRevision.create({ data: { appId, revision: 2, status: "ACTIVE", payload: { ...payload, analyticsSources: [{ ...connection, id: "renamed" }] }, payloadHash: "c".repeat(64), createdBy: "qa", idempotencyKey: appId + ":2" } });
  const second = await collectExtendedMetrics(new Date("2026-10-19T01:00:00Z"), appId, ports);
  assert.equal(second.results[0].status, "partial"); assert.equal(second.results[0].batches, 0);
  assert.equal(downloads, 1, "다른 인스턴스 실패·revision 변경·연결 이름 변경 뒤에도 성공한 원본은 재다운로드하지 않는다");
  assert.equal(identityReads, 2, "재사용하더라도 현재 앱·계정 권한 검증은 생략하지 않는다");
  assert.equal(await prisma.metricReportBatch.count({ where: { appId } }), 1);
  console.log(JSON.stringify({ ok: true, downloads, identityReads, externalCalls: 0, revisionChangeCache: "passed", partialRunCache: "passed" }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
