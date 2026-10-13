import { createFixtureOAuth } from "./console-metrics/oauth-fixture";
import assert from "node:assert/strict";
import { PrismaClient, type App } from "@prisma/client";
import { AIT_LISTINGS } from "../src/lib/analytics/ait-apps";
import { prisma } from "../src/lib/prisma";
import { createConsoleReader } from "../src/lib/analytics/console-sync/client";

import { collectConsoleMetrics, withConsoleCollectionLock } from "../src/lib/analytics/console-sync/collect";
import { McpConsoleMetricsSource } from "../src/lib/analytics/console-sync/source";
import { startConsoleFixture } from "./console-metrics/fixture-server";
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
    assert.deepEqual(after, before);
    const ledger = await prisma.metricCollectionLedger.findMany({ where: { appId: app.id, day: { gte: new Date("2026-10-10") } } });
    assert.equal(ledger.length, 2); assert.ok(ledger.every((cell) => cell.state === "observed"));
    // 실행 종료 뒤 잠금이 풀리고 새 프로세스에 해당하는 OAuth 인스턴스로 조회된다.
    await reader!.close(); reader = await createConsoleReader(await createFixtureOAuth(credential, fixture.fetcher));
    await new McpConsoleMetricsSource(reader).verifyWorkspace(); assert.equal(fixture.state.refreshes, 2);
    fixture.state.failIos = false; fixture.state.rateLimits = 10; fixture.state.retryAfter = "60";
    const limited = await withConsoleCollectionLock(async () => collectConsoleMetrics(new McpConsoleMetricsSource(reader!), now));
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
