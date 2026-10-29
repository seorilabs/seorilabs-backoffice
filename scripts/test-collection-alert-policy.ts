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

  process.env.SLACK_ENABLED = "true";
  process.env.SLACK_WORKSPACE_ID = "T000POLICY";
  process.env.SLACK_APP_ID = "A000POLICY";
  process.env.SLACK_BOT_TOKEN = "isolated-local-only";
  process.env.SLACK_CHANNEL_OPS_ALERTS_ID = "C000OPS";
  process.env.SLACK_CHANNEL_METRICS_DAILY_ID = "C000METRICS";
  process.env.SLACK_CHANNEL_APP_OPS_ID = "C000APP";
  process.env.SLACK_ROLE_RELEASE_OPS_USERS = "U000RELEASE";
  const outgoing: Array<{
    api: string;
    method: string;
    body: Record<string, unknown>;
  }> = [];
  const messages = new Map<string, Record<string, unknown>>();
  const files = new Map<string, { filename: string; length: number; bytes?: Buffer; channel?: string; ts?: string }>();
  let sequence = 0;
  const nextTs = () => `2200000000.${String(++sequence).padStart(6, "0")}`;
  const mentioned = (request: typeof outgoing[number]) => JSON.stringify(request.body.blocks ?? []).includes("<@U000RELEASE>");
  const noBroadMention = (request: typeof outgoing[number]) => !/<!(channel|here|everyone)>/.test(JSON.stringify(request.body));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = new URL(String(input));
    assert.equal(init?.method, "POST");
    if (target.origin === "https://files.slack.com") {
      assert.match(target.pathname, /^\/upload\/v1\/F[A-Z0-9]+$/);
      const id = target.pathname.split("/").pop()!;
      const file = files.get(id);
      assert.ok(file, "발급하지 않은 업로드 URL");
      const bytes = init?.body;
      assert.ok(Buffer.isBuffer(bytes), "PNG 원문 바이트를 업로드한다");
      assert.equal(bytes.length, file.length);
      assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      file.bytes = Buffer.from(bytes);
      outgoing.push({ api: "upload", method: "POST", body: { file: id, bytes: bytes.length } });
      return new Response("OK", { status: 200 });
    }
    assert.equal(target.origin, "https://slack.com", "검수 중 실제 외부 요청 금지");
    const api = target.pathname.replace(/^\/api\//, "");
    assert.equal(target.pathname, `/api/${api}`);
    const contentType = new Headers(init?.headers).get("content-type") ?? "";
    const form = ["files.getUploadURLExternal", "files.info"].includes(api);
    assert.match(contentType, form ? /^application\/x-www-form-urlencoded/ : /^application\/json/);
    const body = (form
      ? Object.fromEntries(new URLSearchParams(String(init?.body)))
      : JSON.parse(String(init?.body ?? "{}"))) as Record<string, unknown>;
    outgoing.push({ api, method: "POST", body });
    if (api === "chat.postMessage" || api === "chat.update") {
      assert.match(String(body.channel), /^C[A-Z0-9]+$/);
      const ts = api === "chat.update" ? String(body.ts) : nextTs();
      assert.match(ts, /^\d+\.\d+$/);
      const key = `${body.channel}:${ts}`;
      if (api === "chat.update" && !messages.has(key)) return Response.json({ ok: false, error: "message_not_found" });
      messages.set(key, body);
      return Response.json({ ok: true, channel: body.channel, ts, message: { text: body.text, blocks: body.blocks } });
    }
    if (api === "files.getUploadURLExternal") {
      assert.match(String(body.filename), /\.png$/);
      assert.ok(Number(body.length) > 8);
      const id = `F${String(files.size + 1).padStart(10, "0")}`;
      files.set(id, { filename: String(body.filename), length: Number(body.length) });
      return Response.json({ ok: true, file_id: id, upload_url: `https://files.slack.com/upload/v1/${id}` });
    }
    if (api === "files.completeUploadExternal") {
      assert.ok(Array.isArray(body.files) && body.files.length === 1);
      const requested = body.files[0] as { id: string; title: string };
      const file = files.get(requested.id);
      assert.ok(file?.bytes, "업로드를 마친 파일만 공유한다");
      assert.equal(file.ts, undefined, "같은 파일을 다시 게시하지 않는다");
      assert.match(String(body.channel_id), /^C[A-Z0-9]+$/);
      file.channel = String(body.channel_id);
      file.ts = nextTs();
      messages.set(`${file.channel}:${file.ts}`, { text: body.initial_comment, file: requested.id });
      return Response.json({ ok: true, files: [{ id: requested.id, title: requested.title }] });
    }
    if (api === "files.info") {
      const file = files.get(String(body.file));
      assert.ok(file?.channel && file.ts);
      return Response.json({ ok: true, file: { id: body.file, shares: { public: { [file.channel]: [{ ts: file.ts }] }, private: {} } } });
    }
    assert.fail(`예상하지 않은 Slack API 요청: ${api}`);
  };
  try {
    await enqueueNotification({
      dedupeKey: "metrics:operations:qa-legacy-pending",
      kind: "OPS_ALERT",
      payload: { text: "이전 형식의 수집 회복", alertRoleId: "9999" },
      destinations: [{ provider: "SLACK", key: "ops-alerts" }],
    });
    await drainAllNotifications(100);
    assert.equal(outgoing.length, 0, "구형 수집 회복 대기도 SUPPRESSED");
    assert.ok(
      outgoing.every((request) => !mentioned(request) && noBroadMention(request)),
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
      outgoing.filter(mentioned).length,
      1,
    );
    outgoing.length = 0;
    await recordIncident({ ...input, signalId: "repeat" });
    await drainAllNotifications(100);
    assert.ok(outgoing.length > 0, "반복 관측은 기존 장애 카드를 갱신한다");
    assert.ok(
      outgoing.every(
        (request) =>
          request.api === "chat.update" && !mentioned(request) && noBroadMention(request),
      ),
    );
    const currentIncident = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: incident.id } });
    assert.ok(currentIncident.providerMessageId);
    assert.equal(messages.delete(`C000OPS:${currentIncident.providerMessageId}`), true, "사용자가 지운 메시지를 대체한다");
    outgoing.length = 0;
    await recordIncident({ ...input, signalId: "replacement" });
    await drainAllNotifications(100);
    assert.deepEqual(
      outgoing.map((request) => request.api),
      ["chat.update", "chat.postMessage"],
    );
    assert.ok(
      outgoing.every((request) => !mentioned(request) && noBroadMention(request)),
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
      outgoing.every((request) => !mentioned(request) && noBroadMention(request)),
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
        observedAt: new Date(toDbDay(date).getTime() + 160 * 60000),
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
    assert.equal(delivered.provider, "SLACK");
    const firstDeliveryRequests = outgoing.length;
    const again = await sendDailyKeywordRanks(at(175));
    assert.equal(again.eventId, daily.eventId);
    await drainAllNotifications(100);
    assert.deepEqual(
      outgoing.filter((request) => request.api === "files.completeUploadExternal").length,
      1,
    );
    assert.equal(outgoing.length, firstDeliveryRequests, "같은 발행의 재계산은 업로드나 메시지를 반복하지 않는다");
    assert.equal(outgoing.filter((request) => request.api === "upload").length, 1);
    assert.equal(outgoing.filter((request) => request.api === "chat.postMessage").length, 0, "파일 게시 메시지와 본문 메시지를 따로 만들지 않는다");
    assert.ok(
      outgoing.every((request) => !mentioned(request) && noBroadMention(request)),
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
      outgoing.some((request) => request.api === "chat.update" && Array.isArray(request.body.blocks) && request.body.blocks.some((block) => {
        const image = block as { type?: string; slack_file?: { id?: string } };
        return image.type === "image" && !!image.slack_file?.id && files.has(image.slack_file.id);
      })),
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
