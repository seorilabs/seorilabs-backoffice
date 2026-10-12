import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { createConsoleReader } from "../src/lib/analytics/console-sync/client";
import { ConsoleOAuth } from "../src/lib/analytics/console-sync/oauth";
import { collectConsoleMetrics, withConsoleCollectionLock } from "../src/lib/analytics/console-sync/collect";
import { McpConsoleMetricsSource } from "../src/lib/analytics/console-sync/source";
import { startConsoleFixture } from "./console-metrics/fixture-server";
const url = new URL(process.env.DATABASE_URL ?? "");
if (url.hostname !== "127.0.0.1" || url.port !== "33319" || url.pathname !== "/backoffice_console_qa") throw new Error("ISOLATED_DATABASE_REQUIRED");
async function main() {
  const app = await prisma.app.create({ data: { slug: "lizard-tycoon", displayName: "격리 지표 QA", repoFullName: "qa/lizard-tycoon", type: "GAME", engine: "GODOT", marketTargets: ["ait"], aitWorkspaceId: 38345, aitMiniAppId: 61736 } });
  const fixture = await startConsoleFixture(); const now = new Date("2026-10-12T01:00:00Z");
  const credential = { credentialId: "shared/apps-in-toss/console-oauth", clientId: "mcp-gateway" as const, refreshToken: "fixture-refresh" };
  const other = new PrismaClient();
  let reader: Awaited<ReturnType<typeof createConsoleReader>> | undefined;
  try {
    const result = await withConsoleCollectionLock(async () => {
      // 다른 DB 연결의 동일 잠금은 OAuth 호출 전에 실패해야 한다.
      const rows = await other.$queryRaw<Array<{ acquired: number | bigint }>>`SELECT GET_LOCK('backoffice:ait-console-collect', 0) AS acquired`;
      assert.equal(Number(rows[0].acquired), 0);
      reader = await createConsoleReader(new ConsoleOAuth(credential, fixture.fetcher));
      const source = new McpConsoleMetricsSource(reader); await source.verifyWorkspace(); fixture.state.rateLimits = 1;
      return collectConsoleMetrics(source, now, { "lizard-tycoon#61736": "2026-10-10" });
    });
    assert.ok("results" in result); assert.equal(result.results.find((r) => r.window.slug === app.slug)?.upserts, 2);
    assert.equal(result.readback.apps.find((a) => a.slug === app.slug)?.lastDate, "2026-10-11");
    // 미등록 앱들은 추측 백필하지 않으므로 전체는 부분 완료다.
    assert.equal(result.state, "partial"); assert.ok(result.blocked.length > 0);
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
    await reader!.close(); reader = await createConsoleReader(new ConsoleOAuth(credential, fixture.fetcher));
    await new McpConsoleMetricsSource(reader).verifyWorkspace(); assert.equal(fixture.state.refreshes, 2);
    fixture.state.revoked = true;
    await assert.rejects(new ConsoleOAuth(credential, fixture.fetcher).refresh(), /REAUTHENTICATION_REQUIRED/);
    assert.ok(!JSON.stringify({ result, failed, after }).includes("fixture-access"));
    process.stdout.write("HTTP MCP → 저장 서비스 → 격리 MySQL → readback 통과; 결측 보존·동시 잠금·재시작·재인증 차단 통과\n");
  } finally {
    await reader?.close(); await fixture.close(); await other.$disconnect();
    await prisma.appConsoleMetricDaily.deleteMany({ where: { appId: app.id } });
    await prisma.metricCollectionLedger.deleteMany({ where: { appId: app.id } }); await prisma.app.delete({ where: { id: app.id } });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
