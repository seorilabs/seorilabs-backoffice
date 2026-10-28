import { keywordCycle } from "@/lib/market/keyword-cycle";
import { keywordObservationId, saveKeywordObservation } from "@/lib/market/keyword-collector";
import assert from "node:assert/strict";
import { shiftMetricDay, toDbDay } from "@/lib/analytics/metric-day";
import { prisma } from "@/lib/prisma";
import { discoverOperationalSignals } from "@/lib/insights/triggers";
import { sendDailyKeywordRanks } from "@/lib/market/daily-ranks";
import { sendOperationsSummary } from "@/lib/core/operations-report";
import { drainAllNotifications } from "@/lib/notifications/deploy";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { recordIncident } from "@/lib/notifications/incidents";
const url = new URL(process.env.DATABASE_URL ?? "");
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  url.pathname !== "/backoffice_cutover_contract_test"
)
  throw new Error("ISOLATED_POLICY_DATABASE_REQUIRED");
let policyDay = "2200-01-01";
const at = (minute: number) =>
  new Date(toDbDay(policyDay).getTime() + minute * 60000);
async function main() {
  // 이전 앱·설정·감사를 지우지 않고 실행마다 빈 기준일을 쓴다.
  policyDay = shiftMetricDay(
    policyDay,
    await prisma.notificationEvent.count({
      where: { dedupeKey: { startsWith: "keyword-report-cycle:" } },
    }),
  );
  const fixtureSuffix=Date.now();
  const app = await prisma.app.create({
    data: {
      slug: "qa-policy-" + Date.now(),
      repoFullName: "isolated/policy-" + Date.now(),
      displayName: "격리 정책 앱",
      type: "GAME",
      engine: "GODOT",
      status: "ACTIVE",
      marketTargets: [],
      iosBundle: `com.example.policy.p${fixtureSuffix}`,
      playPackage: `com.example.policy.p${fixtureSuffix}`,
    },
  });
  const run = (minute: number, status: string) =>
    prisma.sourceCollectionRun.create({
      data: {
        appId: app.id,
        source: "play-submissions",
        target: app.playPackage!,
        status,
        startedAt: at(minute),
        completedAt: status === "running" ? null : at(minute),
      },
    });
  await run(0, "observed");
  const first = await run(15, "needs_input");
  await run(30, "partial");
  await run(45, "running");
  await discoverOperationalSignals(at(74));
  await discoverOperationalSignals(at(75));
  await discoverOperationalSignals(at(90));
  await run(95, "empty");
  await discoverOperationalSignals(at(96));
  await run(120, "failed");
  await run(135, "partial");
  await run(145, "observed");
  await discoverOperationalSignals(at(146));
  assert.equal(
    await prisma.operationalSignal.count({
      where: {
        appId: app.id,
        kind: { in: ["source-stale", "source-recovery"] },
      },
    }),
    0,
    "수집 실패·회복은 사람 보고 신호가 아니다",
  );
  await sendOperationsSummary(at(150));
  assert.equal(
    await prisma.notificationEvent.count({
      where: { dedupeKey: `metrics:operations:${policyDay}` },
    }),
    0,
    "회복 횟수 요약을 발행하지 않는다",
  );

  process.env.DISCORD_BOT_TOKEN = "isolated-local-only";
  process.env.DISCORD_CHANNEL_OPS_ALERTS_ID = "1001";
  process.env.DISCORD_CHANNEL_METRICS_DAILY_ID = "1002";
  process.env.DISCORD_CHANNEL_APP_OPS_ID = "1003";
  process.env.DISCORD_ROLE_RELEASE_OPS_ID = "9999";
  const outgoing: Array<{
    method: string;
    body: {
      content?: string;
      allowed_mentions: { roles: string[] };
      attachments?: unknown[];
    };
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = String(input);
    assert.ok(
      target.startsWith("https://discord.com/api/v10/"),
      "unexpected external request",
    );
    const body =
      init?.body instanceof FormData
        ? JSON.parse(String(init.body.get("payload_json")))
        : JSON.parse(String(init?.body));
    outgoing.push({ method: init?.method ?? "GET", body });
    return new Response(
      JSON.stringify(
        target.endsWith("/40400")
          ? { code: 10008, message: "Unknown Message" }
          : { id: String(2000 + outgoing.length) },
      ),
      {
        status: target.endsWith("/40400") ? 404 : 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  try {
    await enqueueNotification({
      dedupeKey: "metrics:operations:qa-legacy-pending",
      kind: "OPS_ALERT",
      payload: { text: "이전 형식의 수집 회복", alertRoleId: "9999" },
      destinations: [{ provider: "DISCORD", key: "ops-alerts" }],
    });
    await drainAllNotifications(100);
    assert.equal(outgoing.length, 0, "구형 수집 회복 대기도 SUPPRESSED");
    assert.ok(
      outgoing.every(
        (request) => request.body.allowed_mentions.roles.length === 0,
      ),
    );
    outgoing.length = 0;
    const input = {
      source: "isolated",
      kind: "critical-policy",
      severity: "critical" as const,
      summary: "격리 중대 장애",
      appId: app.id,
      detectedAt: at(160),
    };
    const incident = await recordIncident({ ...input, signalId: "first" });
    await drainAllNotifications(100);
    assert.equal(
      outgoing.filter((request) =>
        request.body.allowed_mentions.roles.includes("9999"),
      ).length,
      1,
    );
    outgoing.length = 0;
    await recordIncident({ ...input, signalId: "repeat" });
    await drainAllNotifications(100);
    assert.ok(
      outgoing.every(
        (request) =>
          request.method === "PATCH" &&
          request.body.allowed_mentions.roles.length === 0,
      ),
    );
    await prisma.operationalIncident.update({
      where: { id: incident.id },
      data: { providerMessageId: "40400" },
    });
    outgoing.length = 0;
    await recordIncident({ ...input, signalId: "replacement" });
    await drainAllNotifications(100);
    assert.deepEqual(
      outgoing.map((request) => request.method),
      ["PATCH", "POST"],
    );
    assert.ok(
      outgoing.every(
        (request) => request.body.allowed_mentions.roles.length === 0,
      ),
    );
    outgoing.length = 0;
    await recordIncident({
      ...input,
      kind: "warning-policy",
      severity: "warning",
      signalId: "warning",
    });
    await drainAllNotifications(100);
    assert.ok(
      outgoing.every(
        (request) => request.body.allowed_mentions.roles.length === 0,
      ),
    );

    await prisma.configRevision.create({
      data: {
        appId: app.id,
        revision: 1,
        status: "ACTIVE",
        activeSlot: app.id,
        payloadHash: "a".repeat(64),
        createdBy: "isolated-fixture",
        idempotencyKey: "qa-policy-config-" + app.id,
        payload: {
          schemaVersion: 1,
          markets: [],
          monitoring: {
            enabled: true,
            keywords: ["해전", "brand", "신규"],
            countries: ["kr", "us"],
            competitorAppIds: [],
            officialFeeds: [],
            checkSupportLinks: false,
          },
        },
      },
    });
    await prisma.marketObservation.createMany({
      data: [shiftMetricDay(policyDay, -1), policyDay].map((date) => ({
        appId: app.id,
        kind: "keyword",
        target: "해전",
        country: "kr",
        day: toDbDay(date),
        observedAt: at(160),
        value: { rank: date === policyDay ? 36 : 51 },
        sourceUrl: "https://itunes.apple.com/search",
      })),
    });
    const cycle=keywordCycle(at(170));
    const task={appId:app.id,market:"app-store" as const,country:"kr",language:"en_us",term:"해전",revision:1,identity:app.iosBundle!};
    await prisma.keywordCollectionBatch.create({data:{id:cycle.id,sourceSha:"a".repeat(40),startedAt:cycle.start,completedAt:at(161),plan:[task]}});
    await saveKeywordObservation({id:keywordObservationId(cycle.id,task),batchId:cycle.id,appId:app.id,market:task.market,source:"apple-search-api",country:"kr",language:"en_us",term:task.term,revision:1,sourceSha:"a".repeat(40),observedAt:at(160),status:"observed",rank:36,resultCount:200,sourceUrl:"https://itunes.apple.com/search"});
    outgoing.length = 0;
    const daily = await sendDailyKeywordRanks(at(170));
    await drainAllNotifications(100);
    const delivered = await prisma.notificationDelivery.findFirstOrThrow({
      where: { eventId: daily.eventId },
    });
    assert.ok(delivered.providerMessageId);
    assert.equal(
      delivered.status,
      "SENT",
      "최초 발행이 불필요한 편집으로 다시 대기하면 안 된다",
    );
    const again = await sendDailyKeywordRanks(at(175));
    assert.equal(again.eventId, daily.eventId);
    await drainAllNotifications(100);
    assert.deepEqual(
      outgoing.map((request) => request.method),
      ["POST"],
    );
    assert.ok(
      outgoing.every(
        (request) =>
          request.body.allowed_mentions.roles.length === 0 &&
          request.body.attachments?.length === 1,
      ),
    );
    assert.equal(
      (
        await prisma.notificationDelivery.findUniqueOrThrow({
          where: { id: delivered.id },
        })
      ).status,
      "SENT",
    );
    const stored = await prisma.notificationEvent.findUniqueOrThrow({
      where: { id: daily.eventId },
    });
    const payload = stored.payload as {
      text: string;
      rankReport: { items: unknown[] };
    };
    assert.match(payload.text, /격리 정책 앱/);
    assert.match(payload.text, /상위 50/);
    assert.equal(payload.rankReport.items.length, 1);
    assert.doesNotMatch(payload.text, /CSV 파일 첨부|6조합/);
    assert.ok(
      outgoing.every((request) =>
        JSON.stringify(request.body).includes("attachment://"),
      ),
      "PNG는 본문 안에 표시한다",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log(
    "collection policy E2E: collection/recovery internal, pending suppression, critical first mention, 404 replacement silent, immutable rank report/inline PNG/no duplicate OK",
  );
}
main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
