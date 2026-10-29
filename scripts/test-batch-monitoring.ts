// 전용 DB를 prisma db push --force-reset으로 준비한 뒤 한 번 실행한다.
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { ingestBatchResults } from "@/lib/operations-batches/service";
import { AIT_LISTINGS } from "@/lib/analytics/ait-apps";
import { collectConsoleMetrics } from "@/lib/analytics/console-sync/collect";
import { consoleExecutionFailed, consoleExecutionSkipped } from "@/lib/analytics/console-sync/execution";
import type { McpConsoleMetricsSource } from "@/lib/analytics/console-sync/source";
import { ingestAndVerifyConsolePush } from "@/lib/analytics/console-sync/push";
import { drainAllNotifications } from "@/lib/notifications/deploy";

const url = new URL(process.env.DATABASE_URL ?? "");
if (url.hostname !== "127.0.0.1" || url.pathname !== "/backoffice_batch_monitoring_test") throw Error("ISOLATED_BATCH_DATABASE_REQUIRED");
const date = "2201-01-01";
const at = (minutes: number) => new Date(`${date}T00:00:00Z`).getTime() + minutes * 60000;
const captured: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;

async function main() {
  process.env.SLACK_ENABLED = "true";
  process.env.SLACK_WORKSPACE_ID = "T000BATCH";
  process.env.SLACK_APP_ID = "A000BATCH";
  process.env.SLACK_BOT_TOKEN = "isolated-fixture";
  process.env.SLACK_CHANNEL_BATCH_MONITORING_ID = "C000BATCH";
  process.env.SLACK_CHANNEL_OPS_ALERTS_ID = "C000OPS";
  const messages = new Map<string, Record<string, unknown>>();
  globalThis.fetch = async (input, options) => {
    const address = new URL(String(input));
    assert.equal(address.origin, "https://slack.com", "검수 중 실제 외부 요청 금지");
    assert.ok(["/api/chat.postMessage", "/api/chat.update"].includes(address.pathname), "예상하지 않은 Slack API 요청");
    assert.equal(options?.method, "POST");
    const body = JSON.parse(String(options?.body ?? "{}"));
    assert.match(String(body.channel), /^C[A-Z0-9]+$/);
    captured.push({ url: address.href, method: options?.method ?? "", body });
    const ts = address.pathname === "/api/chat.update" ? String(body.ts) : `2200000000.${String(captured.length).padStart(6, "0")}`;
    assert.match(ts, /^\d+\.\d+$/);
    const key = `${body.channel}:${ts}`;
    if (address.pathname === "/api/chat.update" && !messages.has(key)) return Response.json({ ok: false, error: "message_not_found" });
    messages.set(key, body);
    return Response.json({ ok: true, channel: body.channel, ts, message: { text: body.text, blocks: body.blocks } });
  };
  const local = async (id: string, status: string, minute: number) => ingestBatchResults({ kind: "local", run: {
    id, name: "book-sales-kdp", status, startedAt: new Date(at(minute)).toISOString(), completedAt: new Date(at(minute) + 30000).toISOString(),
    expected: 3, verified: status === "succeeded" ? 3 : 0, ...(status === "failed" ? { errorCode: "KDP_ARCHIVE_FAILED" } : {}),
  } }, new Date(at(minute + 1)));
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  await local(first, "failed", 1);
  await local(first, "failed", 1);
  await drainAllNotifications(100);
  assert.equal(captured.filter((request) => request.url.endsWith("/chat.postMessage") && request.body.channel === "C000BATCH").length, 1);
  assert.equal(captured.filter((request) => request.url.endsWith("/chat.postMessage") && request.body.channel === "C000OPS").length, 1);
  await local(second, "succeeded", 2);
  await drainAllNotifications(100);
  assert.ok(captured.some((request) => request.url.endsWith("/chat.update") && request.body.channel === "C000OPS"));
  assert.equal(await prisma.notificationEvent.count({ where: { dedupeKey: `batch-result:batch:local:${first}` } }), 1);

  await prisma.app.create({ data: { slug: "lucid-chess", displayName: "격리 체스", repoFullName: "isolated/lucid-chess",
    type: "GAME", engine: "GODOT", status: "ACTIVE", marketTargets: [] } });
  const row = { date, dau: 3, newUsers: 0, avgSessionSec: 170, iaaImpressions: 2, iaaEarningKrw: 10,
    iapTrxAmountKrw: 0, iapSettlementKrw: 0, payingUsers: 0,
    raw: { missingMetrics: ["iaa.IOS"], iaaTotal: { date, impression: 2, estimatedEarning: 10 },
      iaaByOs: { ANDROID: { date, impression: 2, estimatedEarning: 10 } } } };
  const payload = { apps: [{ slug: "lucid-chess", miniAppId: 34107, workspaceId: 38345, days: [row] }] };
  const result = await ingestAndVerifyConsolePush(payload, new Date(at(3)), () => new Date(at(3) + 1000));
  assert.equal(result.verification.verified, 1);
  const event = await prisma.notificationEvent.findFirstOrThrow({ where: { dedupeKey: { startsWith: "ait-console-push:" } }, orderBy: { occurredAt: "desc" } });
  const body = event.payload as { executionStatus: string; state: string; embed: { title: string } };
  assert.equal(body.executionStatus, "succeeded");
  assert.equal(body.state, "partial");
  assert.match(body.embed.title, /성공/);
  const stored = await prisma.appConsoleMetricDaily.findFirstOrThrow();
  assert.equal(stored.iaaEarningKrw, 10);
  assert.equal(stored.iapTrxAmountKrw, 0);
  assert.ok(!JSON.stringify(stored.raw).includes('"IOS":0'));
  await drainAllNotifications(100);
  const sent = await prisma.notificationDelivery.findFirstOrThrow({ where: { eventId: event.id } });
  assert.equal(sent.status, "SENT");
  assert.equal(sent.provider, "SLACK");
  assert.equal(sent.destinationKey, "batch-monitoring");
  assert.ok(sent.providerMessageId);
  assert.match(sent.providerMessageId, /^\d+\.\d+$/);

  const invalid = { apps: [{ ...payload.apps[0], days: [{ ...row, date: "invalid" }] }] };
  await ingestAndVerifyConsolePush(invalid, new Date(at(4)), () => new Date(at(4) + 1000));
  await drainAllNotifications(100);
  const incident = await prisma.operationalIncident.findFirstOrThrow({ where: { source: "ait-console-manual" } });
  assert.equal(incident.status, "OPEN");
  await ingestAndVerifyConsolePush(payload, new Date(at(5)), () => new Date(at(5) + 1000));
  await drainAllNotifications(100);
  assert.equal((await prisma.operationalIncident.findUniqueOrThrow({ where: { id: incident.id } })).status, "RECOVERED");

  await prisma.app.update({ where: { slug: "lucid-chess" }, data: { status: "PAUSED" } });
  const priorIncidents = await prisma.operationalIncident.count();
  const excluded = await ingestAndVerifyConsolePush(payload, new Date(at(6)), () => new Date(at(6) + 1000));
  assert.equal(excluded.verification.expected, 0);
  const excludedEvent = await prisma.notificationEvent.findFirstOrThrow({ where: { dedupeKey: { startsWith: "ait-console-push:" } }, orderBy: { occurredAt: "desc" } });
  assert.equal((excludedEvent.payload as { executionStatus: string }).executionStatus, "skipped");
  assert.equal(await prisma.operationalIncident.count(), priorIncidents);
  await drainAllNotifications(100);
  for (const slug of new Set(AIT_LISTINGS.map((listing) => listing.appSlug))) {
    await prisma.app.upsert({ where: { slug }, update: { status: "PAUSED" },
      create: { slug, displayName: "격리 앱", repoFullName: `isolated/${slug}`, type: "GAME", engine: "GODOT", status: "PAUSED", marketTargets: [] } });
  }
  const noActive = await collectConsoleMetrics({ async queryListing() { assert.fail("운영 중지 앱의 지표 조회"); } } as unknown as McpConsoleMetricsSource, new Date(at(7)));
  assert.equal(consoleExecutionSkipped(noActive), true);
  assert.equal(consoleExecutionFailed(noActive), false);
  process.env.SLACK_CHANNEL_BATCH_MONITORING_ID = "";
  const third = "33333333-3333-4333-8333-333333333333";
  await local(third, "succeeded", 6);
  const before = captured.length;
  await drainAllNotifications(100);
  const missingChannel = await prisma.notificationDelivery.findFirstOrThrow({ where: { event: { dedupeKey: `batch-result:batch:local:${third}` } } });
  assert.notEqual(missingChannel.status, "SENT");
  assert.equal(captured.length, before);
  assert.ok(captured.every((request) => !JSON.stringify(request.body).includes("isolated-fixture")));
  console.log(JSON.stringify({ passed: true, verified: ["KDP per-run dedupe", "incident recovery", "partial data execution success",
    "confirmed zero preserved", "manual input rejection", "missing channel not sent", "Slack HTTP delivery readback"],
    messages: captured.filter((request) => request.body.channel === "C000BATCH").map((request) => request.body) }));
}
main().finally(async () => { globalThis.fetch = originalFetch; await prisma.$disconnect(); });
