import { createFixtureOAuth } from "./console-metrics/oauth-fixture";
import assert from "node:assert/strict";
import { PrismaClient, type App } from "@prisma/client";
import { AIT_LISTINGS } from "../src/lib/analytics/ait-apps";
import { prisma } from "../src/lib/prisma";
import { createConsoleReader } from "../src/lib/analytics/console-sync/client";

import { collectConsoleMetrics, withConsoleCollectionLock } from "../src/lib/analytics/console-sync/collect";
import { McpConsoleMetricsSource } from "../src/lib/analytics/console-sync/source";
import { startConsoleFixture } from "./console-metrics/fixture-server";
import { ingestConsoleMetrics, getConsoleSyncStatus } from "../src/lib/core/console-metrics-collect";
const url = new URL(process.env.DATABASE_URL ?? "");
if (url.hostname !== "127.0.0.1" || url.port !== "33319" || url.pathname !== "/backoffice_console_qa") throw new Error("ISOLATED_DATABASE_REQUIRED");
async function main() {
  const apps: App[] = [];
  for (const listing of AIT_LISTINGS) {
    if (apps.some((app) => app.slug === listing.appSlug)) continue;
    apps.push(await prisma.app.create({ data: { slug: listing.appSlug, displayName: "격리 지표 QA", repoFullName: `qa/${listing.appSlug}`, type: "GAME", engine: "GODOT", marketTargets: ["ait"], aitWorkspaceId: 38345, aitMiniAppId: listing.miniAppId } }));
  }
  const app = apps.find((app) => app.slug === "lizard-tycoon")!;
  const launches = Object.fromEntries(AIT_LISTINGS.map((listing) => [`${listing.appSlug}#${listing.miniAppId}`, "2026-10-10"]));
  const fixture = await startConsoleFixture(); const now = new Date("2026-10-12T01:00:00Z");
  const credential = { credentialId: "shared/apps-in-toss/console-oauth" as const, clientId: "mcp-gateway" as const, refreshToken: "fixture-refresh" };
  const other = new PrismaClient();
  let reader: Awaited<ReturnType<typeof createConsoleReader>> | undefined;
  try {
    const result = await withConsoleCollectionLock(async () => {
      // 다른 DB 연결의 동일 잠금은 OAuth 호출 전에 실패해야 한다.
      const rows = await other.$queryRaw<Array<{ acquired: number | bigint }>>`SELECT GET_LOCK('backoffice:ait-console-collect', 0) AS acquired`;
      assert.equal(Number(rows[0].acquired), 0);
      reader = await createConsoleReader(await createFixtureOAuth(credential, fixture.fetcher));
      const source = new McpConsoleMetricsSource(reader); await source.verifyWorkspace(); fixture.state.rateLimits = 1;
      const blocked = await collectConsoleMetrics(source, now);
      assert.equal(blocked.state, "partial"); assert.equal(blocked.results.length, 0); assert.equal(blocked.blocked.length, AIT_LISTINGS.length);
      return collectConsoleMetrics(source, now, launches);
    });
    assert.ok("results" in result); assert.equal(result.results.find((r) => r.window.slug === app.slug)?.upserts, 2);
    assert.equal(result.readback.apps.find((a) => a.slug === app.slug)?.lastDate, "2026-10-11");
    assert.equal(result.state, "complete"); assert.equal(result.blocked.length, 0);
    assert.equal(result.readback.apps.length, AIT_LISTINGS.length); assert.ok(result.readback.apps.every((a) => a.lastDate === "2026-10-11"));
    assert.equal(new Set(result.results.map((r) => `${r.window.slug}#${r.window.miniAppId}`)).size, AIT_LISTINGS.length);
    const before = await prisma.appConsoleMetricDaily.findMany({ where: { appId: app.id }, orderBy: { date: "asc" } });
    assert.equal(before.length, 2); assert.equal(before[0].dau, null); assert.equal(Number(before[0].iaaEarningKrw), 34);
    fixture.state.failIos = true;
    const failed = await withConsoleCollectionLock(async () => collectConsoleMetrics(new McpConsoleMetricsSource(reader!), now));
    assert.ok("results" in failed); assert.ok(failed.results.some((r) => r.missing.some((m) => m.metrics.includes("iaa.IOS"))));
    const after = await prisma.appConsoleMetricDaily.findMany({ where: { appId: app.id }, orderBy: { date: "asc" } });
    const numeric = (row: typeof before[number]) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "raw"));
    const existingAfter = after.filter((row) => row.date >= before[0].date);
    assert.deepEqual(existingAfter.map(numeric), before.map(numeric));
    assert.deepEqual((existingAfter[0].raw as Record<string, unknown>).iaaByOs, (before[0].raw as Record<string, unknown>).iaaByOs);
    const ledger = await prisma.metricCollectionLedger.findMany({ where: { appId: app.id, day: { gte: new Date("2026-10-10") } } });
    assert.equal(ledger.length, 2); assert.ok(ledger.every((cell) => cell.state === "observed"));
    // 새 날짜의 일부 지표만 있어도 저장하며, 빈 지표는 실제 NULL이다.
    const nextNow = new Date("2026-10-13T01:00:00Z");
    fixture.state.failIap = true;
    const partial = await withConsoleCollectionLock(async () => collectConsoleMetrics(new McpConsoleMetricsSource(reader!), nextNow));
    assert.equal(partial.state, "partial");
    const where = { appId_miniAppId_date: { appId: app.id, miniAppId: 61736, date: new Date("2026-10-12") } };
    const partialRow = await prisma.appConsoleMetricDaily.findUniqueOrThrow({ where });
    assert.equal(partialRow.avgSessionSec, 30); assert.equal(partialRow.iaaEarningKrw, null); assert.equal(partialRow.iapTrxAmountKrw, null);
    assert.ok((partialRow.raw as Record<string, unknown>).iaaByOs);
    const partialLedger = await prisma.metricCollectionLedger.findFirstOrThrow({ where: { source: "ait_console", appId: app.id, listingId: 61736, day: new Date("2026-10-12") } });
    assert.equal(partialLedger.state, "failed"); assert.equal(partialLedger.sealed, false);
    const partialStatus = (await getConsoleSyncStatus()).apps.find((row) => row.slug === app.slug)!;
    assert.ok(partialStatus.firstIncompleteDate && partialStatus.firstIncompleteDate <= "2026-10-12");
    // 나중에 확인된 OS를 더해 광고를 복원하고 결제 미확인은 계속 NULL로 둔다.
    fixture.state.failIos = false;
    await withConsoleCollectionLock(async () => collectConsoleMetrics(new McpConsoleMetricsSource(reader!), nextNow));
    const adRow = await prisma.appConsoleMetricDaily.findUniqueOrThrow({ where });
    assert.equal(adRow.iaaEarningKrw, 34); assert.equal(adRow.iapTrxAmountKrw, null);
    fixture.state.failIap = false;
    const complete = await withConsoleCollectionLock(async () => collectConsoleMetrics(new McpConsoleMetricsSource(reader!), nextNow));
    assert.equal(complete.state, "complete");
    const fullRow = await prisma.appConsoleMetricDaily.findUniqueOrThrow({ where });
    assert.equal(fullRow.iapTrxAmountKrw, 0); assert.equal(fullRow.iaaEarningKrw, 34);
    assert.deepEqual((fullRow.raw as Record<string, unknown>).missingMetrics, []);
    assert.equal((await getConsoleSyncStatus()).apps.find((row) => row.slug === app.slug)?.firstIncompleteDate, null);
    // 직접 push도 내부 결측 목록을 몰라도 명시한 완전 지표로 복구할 수 있다.
    await prisma.appConsoleMetricDaily.update({ where, data: { raw: { missingMetrics: ["iap"] } } });
    await ingestConsoleMetrics({ apps: [{ slug: app.slug, miniAppId: 61736, workspaceId: 38345, days: [{ date: "2026-10-12", iaaImpressions: 6, iaaEarningKrw: 34, iapTrxAmountKrw: 0, iapSettlementKrw: 0, payingUsers: 0 }] }] }, nextNow);
    const pushed = await prisma.appConsoleMetricDaily.findUniqueOrThrow({ where });
    assert.deepEqual((pushed.raw as Record<string, unknown>).missingMetrics, []);
    // 신규 unique 키를 동시에 만드는 서로 다른 OS 패치도 모두 보존한다.
    for (let i = 0; i < 4; i++) {
      const day = `2026-10-${13 + i}`;
      const patch = (os: string, impression: number, estimatedEarning: number) => ({ apps: [{ slug: app.slug, miniAppId: 61736, workspaceId: 38345,
        days: [{ date: day, raw: { iaaByOs: { [os]: { date: day, impression, estimatedEarning } } } }] }] });
      const results = await Promise.all([ingestConsoleMetrics(patch("ANDROID", 6, 34), nextNow), ingestConsoleMetrics(patch("IOS", 2, 12), nextNow)]);
      assert.ok(results.every((result) => result.upserts === 1 && result.errors.length === 0));
      const merged = await prisma.appConsoleMetricDaily.findUniqueOrThrow({ where: { appId_miniAppId_date: { appId: app.id, miniAppId: 61736, date: new Date(day) } } });
      assert.equal(merged.iaaImpressions, 8); assert.equal(merged.iaaEarningKrw, 46);
      assert.deepEqual(Object.keys((merged.raw as { iaaByOs: object }).iaaByOs).sort(), ["ANDROID", "IOS"]);
    }
    // 실행 종료 뒤 잠금이 풀리고 새 프로세스에 해당하는 OAuth 인스턴스로 조회된다.
    await reader!.close(); reader = await createConsoleReader(await createFixtureOAuth(credential, fixture.fetcher));
    await new McpConsoleMetricsSource(reader).verifyWorkspace(); assert.equal(fixture.state.refreshes, 2);
    fixture.state.failIos = false; fixture.state.rateLimits = 10; fixture.state.retryAfter = "60";
    const limited = await withConsoleCollectionLock(async () => collectConsoleMetrics(new McpConsoleMetricsSource(reader!), nextNow));
    assert.equal(limited.state, "partial"); assert.ok("blocked" in limited && limited.blocked.some((b) => b.reason.includes("공급자 요청 제한")));
    assert.ok(fixture.state.rateLimits >= 8); // 진행 중인 최대 두 요청 외의 새 조회는 보내지 않는다.
    fixture.state.revoked = true;
    await assert.rejects((await createFixtureOAuth(credential, fixture.fetcher)).refresh(), /REAUTHENTICATION_REQUIRED/);
    assert.ok(!JSON.stringify({ result, failed, after }).includes("fixture-access"));
    await assert.rejects(withConsoleCollectionLock(async () => { throw new Error("fixture-failure"); }), /fixture-failure/);
    const unlocked = await other.$queryRaw<Array<{ acquired: number | bigint }>>`SELECT GET_LOCK('backoffice:ait-console-collect', 0) AS acquired`;
    assert.equal(Number(unlocked[0].acquired), 1); await other.$queryRaw`SELECT RELEASE_LOCK('backoffice:ait-console-collect')`;
    process.stdout.write(`HTTP MCP → 저장 서비스 → 격리 MySQL → 전체 ${AIT_LISTINGS.length}개 리스팅 readback 통과; 결측 보존·동시 잠금·재시작·재인증 차단·실패 후 잠금 해제 통과\n`);
  } finally {
    await reader?.close(); await fixture.close(); await other.$disconnect();
    const appId = { in: apps.map((app) => app.id) };
    await prisma.appConsoleMetricDaily.deleteMany({ where: { appId } });
    await prisma.metricCollectionLedger.deleteMany({ where: { appId } }); await prisma.app.deleteMany({ where: { id: appId } });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
