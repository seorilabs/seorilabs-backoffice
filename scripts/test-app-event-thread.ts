// 빈 작업 전용 MySQL에 migration을 적용한 뒤 실행한다. 기존 데이터를 지우지 않는다.
//
// 앱 이벤트가 날짜·앱 단위 쓰레드로 모이는지 실제 DB와 합성 Slack API로 확인한다.
// 실제 Slack 채널에는 아무것도 보내지 않는다.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { drainAllNotifications } from "@/lib/notifications/deploy";

const database = new URL(process.env.DATABASE_URL ?? "http://invalid");
assert.ok(
  ["127.0.0.1", "localhost"].includes(database.hostname) &&
    [
      "/backoffice_app_event_thread_test",
      "/backoffice_app_event_thread_contract_test",
    ].includes(database.pathname),
  "빈 로컬 backoffice_app_event_thread_test 또는 backoffice_app_event_thread_contract_test DB만 허용한다",
);

type ApiCall = { method: string; body: Record<string, unknown>; ts?: string };
const calls: ApiCall[] = [];
const messages = new Map<string, Record<string, unknown>>();
let sequence = 0;
const timestamp = () => `2300000000.${String(++sequence).padStart(6, "0")}`;
const channels = {
  "action-events": "C000EVENT",
  "ad-rewards": "C000REWARD",
  iap: "C000IAP",
  "ops-alerts": "C000OPS",
};
const secret = "isolated-app-event-thread-secret";

async function syntheticSlack(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(String(input));
  assert.ok(init);
  assert.equal(init.method, "POST", "검수 중 허용하지 않은 요청");
  assert.equal(url.origin, "https://slack.com", "실제 공급자 통신을 허용하지 않는다");
  const method = url.pathname.replace(/^\/api\//, "");
  const body: Record<string, unknown> = JSON.parse(String(init.body));
  if (method === "chat.postMessage") {
    assert.ok(Object.values(channels).includes(String(body.channel)));
    const ts = timestamp();
    messages.set(`${body.channel}:${ts}`, body);
    calls.push({ method, body, ts });
    return Response.json({ ok: true, channel: body.channel, ts });
  }
  if (method === "chat.update") {
    if (!messages.has(`${body.channel}:${body.ts}`))
      return Response.json({ ok: false, error: "message_not_found" });
    messages.set(`${body.channel}:${body.ts}`, body);
    calls.push({ method, body, ts: String(body.ts) });
    return Response.json({ ok: true, channel: body.channel, ts: body.ts });
  }
  calls.push({ method, body });
  assert.fail(`합성 경계에 없는 Slack 메서드: ${method}`);
}

const event = (
  overrides: Partial<{
    eventId: string;
    type: string;
    appId: string;
    occurredAt: string;
    attributes: Record<string, string | number | boolean | null>;
  }> = {},
) => ({
  version: 1,
  eventId: overrides.eventId ?? "identity_delivery_00001",
  occurredAt: overrides.occurredAt ?? "2026-11-21T02:10:00.000Z",
  type: overrides.type ?? "identity.created",
  appId: overrides.appId ?? "bloomhand",
  outcome: "created",
  attributes: overrides.attributes ?? {
    authType: "firebase",
    appVersion: "1.0.3",
    runtime: "ios",
  },
});

async function post(input: ReturnType<typeof event>) {
  const body = JSON.stringify(input);
  const timestampHeader = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${timestampHeader}.${body}`)
    .digest("hex");
  const route = await import(
    "@/app/api/internal/platform/operational-events/route"
  );
  const request = new NextRequest(
    "https://backoffice.test/api/internal/platform/operational-events",
    {
      method: "POST",
      body,
      headers: {
        "x-seori-timestamp": timestampHeader,
        "x-seori-signature": signature,
      },
    },
  );
  const response = await route.POST(request);
  assert.ok(
    response.status === 202 || response.status === 200,
    `이벤트 접수 실패: ${input.eventId} (${response.status})`,
  );
  return response.status;
}

async function drainAll() {
  for (let attempt = 0; attempt < 4; attempt++) {
    await prisma.notificationDelivery.updateMany({
      where: { provider: "SLACK", status: "PENDING" },
      data: { nextAttemptAt: new Date() },
    });
    await drainAllNotifications(100);
  }
}

function posts(method: string) {
  return calls.filter((call) => call.method === method);
}

function rootPosts(channel: string) {
  return posts("chat.postMessage").filter(
    (call) => call.body.channel === channel && !call.body.thread_ts,
  );
}

/** 루트 메시지의 ts. 게시 요청에는 없고 응답에만 있으므로 기록해 둔다. */
function rootTs(call: ApiCall | undefined): string | undefined {
  return call?.ts;
}

function threadPosts(channel: string) {
  return posts("chat.postMessage").filter(
    (call) => call.body.channel === channel && !!call.body.thread_ts,
  );
}

async function main() {
  const counts = await Promise.all([
    prisma.notificationEvent.count(),
    prisma.notificationDelivery.count(),
    prisma.operationalEvent.count(),
  ]);
  assert.deepEqual(counts, [0, 0, 0], "기존 검수 자료를 보존한다. 이 스크립트는 빈 전용 DB에서만 실행한다");
  Object.assign(process.env, {
    SLACK_ENABLED: "true",
    SLACK_BOT_TOKEN: "isolated-app-event-thread-token",
    SLACK_WORKSPACE_ID: "T000THREAD",
    SLACK_APP_ID: "A000THREAD",
    PLATFORM_EVENT_SHARED_SECRET: secret,
    NOTIFICATION_REPORTS_PAUSED: "false",
  });
  for (const [key, value] of Object.entries(channels))
    process.env[`SLACK_CHANNEL_${key.toUpperCase().replaceAll("-", "_")}_ID`] =
      value;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = syntheticSlack;
  try {
    // AC-1: 첫 이벤트는 루트 메시지 하나와 쓰레드 첫 댓글 하나를 만든다.
    await post(event({ eventId: "identity_delivery_00001" }));
    await drainAll();
    const firstRoots = rootPosts(channels["action-events"]);
    assert.equal(firstRoots.length, 1, "첫 이벤트에 루트 메시지 하나");
    const bloomhandRoot = firstRoots[0];
    const bloomhandTs = rootTs(bloomhandRoot);
    assert.ok(bloomhandTs, "루트 메시지 ts");
    assert.match(String(bloomhandRoot.body.text), /2026-11-21/);
    assert.match(String(bloomhandRoot.body.text), /1건/);
    assert.match(String(bloomhandRoot.body.text), /마지막 업데이트/);
    assert.equal(
      String(bloomhandRoot.body.text).includes("신규계정"),
      false,
      "본메시지에는 이벤트 본문이 없다",
    );
    const firstThread = threadPosts(channels["action-events"]);
    assert.equal(firstThread.length, 1, "첫 이벤트 본문은 쓰레드 첫 댓글로 나간다");
    assert.equal(firstThread[0].body.thread_ts, bloomhandTs);
    assert.match(String(firstThread[0].body.text), /신규계정/);

    // AC-2 · AC-3: 같은 날 같은 앱의 두 번째 이벤트는 같은 루트의 댓글이 되고
    // 본메시지를 편집해 건수를 갱신한다.
    await post(
      event({
        eventId: "identity_delivery_00002",
        occurredAt: "2026-11-21T03:20:00.000Z",
        attributes: { authType: "firebase", appVersion: "1.0.4", runtime: "ios" },
      }),
    );
    await drainAll();
    assert.equal(
      rootPosts(channels["action-events"]).length,
      1,
      "갱신할 때 루트 메시지를 새로 만들지 않는다",
    );
    const eventThreads = threadPosts(channels["action-events"]);
    assert.equal(eventThreads.length, 2, "같은 앱의 두 이벤트가 같은 쓰레드에 붙는다");
    assert.ok(
      eventThreads.every((call) => call.body.thread_ts === bloomhandTs),
      "두 댓글이 같은 루트에 붙는다",
    );
    const rootUpdates = posts("chat.update").filter(
      (call) => call.body.ts === bloomhandTs,
    );
    assert.equal(rootUpdates.length, 1, "두 번째 이벤트가 본메시지를 한 번 편집한다");
    // 갱신 요청은 블록 본문만 보낸다(Slack이 text를 대신 만든다).
    assert.match(JSON.stringify(rootUpdates[0].body), /2건/);
    assert.match(JSON.stringify(rootUpdates[0].body), /마지막 업데이트/);

    // AC-2: 다른 앱은 루트를 따로 만든다.
    await post(
      event({
        eventId: "identity_delivery_00003",
        appId: "happy-farm",
        attributes: { authType: "firebase", appVersion: "2.0.0", runtime: "android" },
      }),
    );
    await drainAll();
    const eventRoots = rootPosts(channels["action-events"]);
    assert.equal(eventRoots.length, 2, "같은 앱·같은 날은 루트 하나, 다른 앱은 루트 하나");
    const farmRoot = eventRoots.find((call) =>
      String(call.body.text).includes("happy-farm"),
    );
    assert.ok(farmRoot, "해피팜 루트");
    const farmThread = threadPosts(channels["action-events"]).filter(
      (call) => call.body.thread_ts === rootTs(farmRoot),
    );
    assert.equal(farmThread.length, 1);

    // AC-4: 광고 보상도 같은 규칙, 결제는 건별 메시지.
    await post(
      event({
        eventId: "ad_reward_delivery_00001",
        type: "ad.reward.delivered",
        attributes: { provider: "admob", placementId: "daily", rewardKey: "crystal", rewardAmount: 10 },
      }),
    );
    await post(
      event({
        eventId: "iap_failure_delivery_00001",
        type: "iap.completion_failed",
        attributes: { platform: "appstore", isTestPurchase: true },
      }),
    );
    await drainAll();
    const rewardRoots = rootPosts(channels["ad-rewards"]);
    assert.equal(rewardRoots.length, 1);
    assert.match(String(rewardRoots[0].body.text), /광고보상 1건/);
    assert.equal(threadPosts(channels["ad-rewards"]).length, 1);
    assert.equal(rootPosts(channels.iap).length, 1);
    assert.equal(threadPosts(channels.iap).length, 0, "결제는 건별 메시지를 유지한다");

    // AC-5: 같은 이벤트를 다시 보내도 새 루트와 새 댓글이 생기지 않는다.
    const before = posts("chat.postMessage").length;
    const repeated = await post(event({ eventId: "identity_delivery_00001" }));
    assert.equal(repeated, 200, "같은 이벤트는 중복으로 수렴한다");
    await drainAll();
    assert.equal(posts("chat.postMessage").length, before, "재전송은 새 메시지를 만들지 않는다");

    // AC-6: 부모가 없으면 댓글은 발송 대기 중으로 남고, 부모가 나간 뒤 붙는다.
    const orphan = await prisma.notificationEvent.create({
      data: {
        dedupeKey: "qa-app-event-thread:orphan",
        kind: "OPERATIONAL_EVENT",
        payload: {
          text: "**[고아]** orphan reply",
          plain: true,
          report: { category: "change", reason: "ISOLATED_FIXTURE" },
          appEventThread: {
            parentDedupeKey: "operational-thread:action-events:2026-11-21:ghost",
            destinationKey: "action-events",
            day: "2026-11-21",
            appId: "ghost",
          },
        },
        deliveries: {
          create: {
            provider: "SLACK",
            destinationKey: "action-events",
            status: "PENDING",
          },
        },
      },
      include: { deliveries: true },
    });
    await drainAll();
    const waiting = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id: orphan.deliveries[0].id },
    });
    assert.equal(waiting.status, "PENDING", "부모가 없으면 댓글은 대기한다");
    assert.equal(waiting.lastError, "부모 앱이벤트 알림 발송 대기 중");
    assert.equal(
      posts("chat.postMessage").filter((call) =>
        String(call.body.text).includes("orphan reply"),
      ).length,
      0,
    );
    const ghostParent = await prisma.notificationEvent.create({
      data: {
        dedupeKey: "operational-thread:action-events:2026-11-21:ghost",
        kind: "OPERATIONAL_EVENT",
        payload: {
          text: "**[ghost]** 2026-11-21 앱이벤트 1건 · 마지막 업데이트 11:00",
          plain: true,
          editable: true,
          report: { category: "change", reason: "DAILY_APP_EVENT_THREAD" },
          appEventThread: {
            destinationKey: "action-events",
            day: "2026-11-21",
            appId: "ghost",
            count: 1,
          },
        },
        deliveries: {
          create: {
            provider: "SLACK",
            destinationKey: "action-events",
            status: "PENDING",
          },
        },
      },
      include: { deliveries: true },
    });
    await drainAll();
    const attached = posts("chat.postMessage").find((call) =>
      String(call.body.text).includes("orphan reply"),
    );
    assert.ok(attached, "부모가 게시되면 고아 댓글이 붙는다");
    assert.equal(
      attached.body.thread_ts,
      (await prisma.notificationDelivery.findUniqueOrThrow({
        where: { id: ghostParent.deliveries[0].id },
      })).providerMessageId,
    );
    const attachedDelivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { id: orphan.deliveries[0].id },
    });
    assert.equal(attachedDelivery.status, "SENT");
    console.log(
      JSON.stringify({
        scope: "App event daily thread isolated fixture",
        verified: [
          "first event root and first reply",
          "same app and day reuse one root",
          "root edit on new reply",
          "ad rewards thread",
          "iap stays per item",
          "retransmission idempotence",
          "orphan reply waits for parent",
        ],
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
