import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { reportDecision } from "@/lib/notifications/report-policy";
import type { OperationalEventInput } from "./operational-events";

const sample: OperationalEventInput = {
  version: 1,
  eventId: "identity_delivery_12345",
  occurredAt: "2026-10-19T00:30:00Z",
  type: "identity.created",
  appId: "bloomhand",
  outcome: "created",
  attributes: { authType: "firebase", appVersion: "1.0.3", runtime: "ios" },
};
const secret = "isolated-operational-test";

// 라우트와 서비스는 그대로 실행하고, DB singleton만 파일별 격리 대역으로 연결한다.
const unexpected = async () => { throw new Error("unexpected database call"); };
const db = {
  operationalEvent: { create: unexpected, count: unexpected },
  app: { findFirst: unexpected },
  notificationEvent: { upsert: unexpected, findUnique: unexpected },
};
(globalThis as typeof globalThis & { prisma: unknown }).prisma = db;
async function POST(input: NextRequest) {
  const route = await import("@/app/api/internal/platform/operational-events/route");
  return route.POST(input);
}

function duplicate() {
  return new Prisma.PrismaClientKnownRequestError("duplicate", {
    code: "P2002", clientVersion: Prisma.prismaVersion.client,
  });
}

function request(event = sample, signature?: string) {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new NextRequest("https://backoffice.test/api/internal/platform/operational-events", {
    method: "POST", body,
    headers: {
      "x-seori-timestamp": timestamp,
      "x-seori-signature": signature ?? createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"),
    },
  });
}

function isolated(t: TestContext, options: { registered?: boolean; failEnqueue?: boolean } = {}) {
  const stored = new Set<string>();
  const notifications = new Map<string, Prisma.NotificationEventCreateInput>();
  let failEnqueue = options.failEnqueue;
  t.mock.method(env, "platformEventSharedSecret", () => secret);
  t.mock.method(db.operationalEvent, "create", async ({ data }: Prisma.OperationalEventCreateArgs) => {
    if (stored.has(data.eventId)) throw duplicate();
    stored.add(data.eventId);
    return data;
  });
  t.mock.method(db.app, "findFirst", async () => options.registered === false ? null : ({
    id: "app_bloomhand", slug: "bloomhand", platformAppId: null,
    displayName: "블룸핸드", platformUserBaseline: 0,
  }));
  t.mock.method(db.operationalEvent, "count", async () => 1);
  t.mock.method(db.notificationEvent, "findUnique", async ({ where }: Prisma.NotificationEventFindUniqueArgs) => notifications.get(where.dedupeKey ?? "") ?? null);
  t.mock.method(env, "notificationChannelId", () => "1234567890");
  t.mock.method(db.notificationEvent, "upsert", async ({ create }: Prisma.NotificationEventUpsertArgs) => {
    if (failEnqueue) { failEnqueue = false; throw new Error("outbox temporarily unavailable"); }
    if (!notifications.has(create.dedupeKey)) notifications.set(create.dedupeKey, create);
    return { id: create.dedupeKey };
  });
  return { stored, notifications };
}

test("신규 계정과 새 버전 첫 유입은 실제 라우트에서 한 줄 알림을 대기시킨다", async (t) => {
  const { notifications } = isolated(t);
  for (const event of [sample, {
    ...sample, eventId: "app_version_delivery_12345", type: "app.version.first_seen" as const,
    attributes: { appVersion: "1.0.3", runtime: "ios", sdk: "firebase" },
  }]) {
    assert.equal((await POST(request(event))).status, 202);
    const notification = notifications.get(`operational:${event.eventId}`);
    assert.ok(notification, event.type);
    assert.deepEqual(notification.deliveries, { create: [{ provider: "SLACK", destinationKey: "action-events" }] });
    const payload = notification.payload as Prisma.InputJsonObject;
    assert.match(String(payload.text), /블룸핸드.*1\.0\.3.*ios/);
    assert.equal(String(payload.text).includes("\n"), false);
    assert.equal(reportDecision({ kind: notification.kind, payload }).send, true);
    assert.equal(reportDecision({ kind: notification.kind, payload }, true).send, false);
  }
  assert.equal(notifications.size, 2);
});

test("미등록 앱도 원본 appId로 건별 알림을 보낸다", async (t) => {
  const { notifications } = isolated(t, { registered: false });
  assert.equal((await POST(request(sample))).status, 202);
  const notification = [...notifications.values()][0];
  assert.ok(notification);
  assert.match(String((notification.payload as Prisma.InputJsonObject).text), /bloomhand/);
});

test("최초 계정과 같은 이벤트 재전송은 건별 한 줄 한 건으로 수렴한다", async (t) => {
  const { stored, notifications } = isolated(t);
  assert.equal((await POST(request())).status, 202);
  assert.equal((await POST(request())).status, 200);
  assert.equal(stored.size, 1);
  assert.equal(notifications.size, 1);
  assert.ok(notifications.has(`operational:${sample.eventId}`));
});

test("원장 저장 뒤 enqueue 실패도 재전송으로 복구하고 추가 알림을 만들지 않는다", async (t) => {
  const { stored, notifications } = isolated(t, { failEnqueue: true });
  await assert.rejects(POST(request()), /outbox temporarily unavailable/);
  assert.equal(stored.size, 1);
  assert.equal(notifications.size, 0);
  assert.equal((await POST(request())).status, 200);
  assert.equal((await POST(request())).status, 200);
  assert.equal(notifications.size, 1);
});

test("광고 보상과 테스트 결제 실패도 전용 채널에 건별로 보낸다", async (t) => {
  const { notifications } = isolated(t);
  const events: OperationalEventInput[] = [
    { ...sample, eventId: "ad_reward_delivery_12345", type: "ad.reward.delivered" as const, attributes: { provider: "admob" } },
    { ...sample, eventId: "iap_failure_delivery_12345", type: "iap.completion_failed" as const, attributes: { platform: "appstore", isTestPurchase: true } },
  ];
  for (const event of events) assert.equal((await POST(request(event))).status, 202);
  assert.equal(notifications.size, 2);
  assert.deepEqual([...notifications.values()].map(n => (n.deliveries as {create:Array<{destinationKey:string}>}).create[0].destinationKey), ["ad-rewards", "iap"]);
});

test("잘못된 서명과 금지 속성은 원장이나 알림을 만들기 전에 거부한다", async (t) => {
  const { stored, notifications } = isolated(t);
  assert.equal((await POST(request(sample, "bad-signature"))).status, 401);
  assert.equal((await POST(request({ ...sample, attributes: { platformUserId: "blocked" } }))).status, 400);
  assert.equal(stored.size, 0);
  assert.equal(notifications.size, 0);
});
