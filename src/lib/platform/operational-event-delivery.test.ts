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
  operationalEvent: { create: unexpected, count: unexpected, findMany: unexpected },
  app: { findFirst: unexpected },
  notificationEvent: { upsert: unexpected, findUnique: unexpected },
  notificationDelivery: { updateMany: unexpected },
  $transaction: unexpected,
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

interface StoredEvent {
  id: string;
  kind: string;
  payload: Prisma.InputJsonObject;
  deliveries: Array<{ destinationKey: string; status: string }>;
}

function isolated(t: TestContext, options: { registered?: boolean; failEnqueue?: boolean } = {}) {
  const stored = new Set<string>();
  const ledger: Array<{ appId: string; eventType: string; occurredAt: Date }> = [];
  const notifications = new Map<string, StoredEvent>();
  let failEnqueue = options.failEnqueue;
  t.mock.method(env, "platformEventSharedSecret", () => secret);
  t.mock.method(db.operationalEvent, "create", async ({ data }: Prisma.OperationalEventCreateArgs) => {
    if (stored.has(data.eventId)) throw duplicate();
    stored.add(data.eventId);
    ledger.push({ appId: data.appId, eventType: data.eventType, occurredAt: new Date(data.occurredAt) });
    return data;
  });
  t.mock.method(db.app, "findFirst", async () => options.registered === false ? null : ({
    id: "app_bloomhand", slug: "bloomhand", platformAppId: null,
    displayName: "블룸핸드", platformUserBaseline: 0,
  }));
  t.mock.method(db.operationalEvent, "count", async () => 1);
  t.mock.method(db.operationalEvent, "findMany", async ({ where }: Prisma.OperationalEventFindManyArgs) => ledger.filter(row => {
    const scope = where as { appId?: string; occurredAt?: { gte: Date; lt: Date } };
    if (scope.appId && scope.appId !== row.appId) return false;
    if (scope.occurredAt && (row.occurredAt < scope.occurredAt.gte || row.occurredAt >= scope.occurredAt.lt)) return false;
    return true;
  }).map(row => ({ eventType: row.eventType, occurredAt: row.occurredAt })));
  t.mock.method(db.notificationEvent, "findUnique", async ({ where }: Prisma.NotificationEventFindUniqueArgs) => notifications.get(where.dedupeKey ?? "") ?? null);
  t.mock.method(env, "notificationChannelId", () => "1234567890");
  t.mock.method(db.notificationDelivery, "updateMany", async () => ({ count: 1 }));
  t.mock.method(db, "$transaction", async (run: (tx: unknown) => Promise<unknown>) => run(db));
  t.mock.method(db.notificationEvent, "upsert", async ({ create, update }: Prisma.NotificationEventUpsertArgs) => {
    if (failEnqueue) { failEnqueue = false; throw new Error("outbox temporarily unavailable"); }
    const existing = notifications.get(create.dedupeKey);
    if (existing) {
      if (update?.payload)
        existing.payload = update.payload as unknown as Prisma.InputJsonObject;
      return { id: existing.id };
    }
    const row: StoredEvent = {
      id: create.dedupeKey,
      kind: create.kind,
      payload: create.payload as Prisma.InputJsonObject,
      deliveries: ((create.deliveries as { create?: Array<{ destinationKey?: string }> } | undefined)?.create ?? []).map(row => ({ destinationKey: String(row.destinationKey), status: "PENDING" })),
    };
    notifications.set(create.dedupeKey, row);
    return { id: row.id };
  });
  return { stored, ledger, notifications };
}

function parentKey(day: string, appId: string, destination = "action-events") {
  return `operational-thread:${destination}:${day}:${appId}`;
}

test("신규 계정과 새 버전 첫 유입은 실제 라우트에서 한 줄 알림을 대기시킨다", async (t) => {
  const { notifications } = isolated(t);
  for (const event of [sample, {
    ...sample,
    eventId: "app_version_delivery_12345", type: "app.version.first_seen" as const,
    attributes: { appVersion: "1.0.3", runtime: "ios", sdk: "firebase" },
  }]) {
    assert.equal((await POST(request(event))).status, 202);
    const notification = notifications.get(`operational:${event.eventId}`);
    assert.ok(notification, event.type);
    assert.deepEqual(notification.deliveries.map(row => row.destinationKey), ["action-events"]);
    const payload = notification.payload;
    assert.match(String(payload.text), /블룸핸드.*1\.0\.3.*ios/);
    assert.equal(String(payload.text).includes("\n"), false);
    assert.equal(reportDecision({ kind: notification.kind, payload }).send, true);
    assert.equal(reportDecision({ kind: notification.kind, payload }, true).send, false);
  }
});

test("첫 이벤트는 본메시지와 첫 댓글로 나뉜다", async (t) => {
  const { notifications } = isolated(t);
  assert.equal((await POST(request())).status, 202);
  const parent = notifications.get(parentKey("2026-10-19", "bloomhand"));
  assert.ok(parent, "본메시지가 생긴다");
  const parentPayload = parent.payload as Prisma.InputJsonObject;
  assert.match(String(parentPayload.text), /블룸핸드/);
  assert.match(String(parentPayload.text), /2026-10-19/);
  assert.match(String(parentPayload.text), /1건/);
  assert.equal(parentPayload.editable, true);
  assert.equal(parentPayload.plain, true);
  assert.equal((parentPayload.report as { category: string }).category, "change");
  // 본메시지 본문에는 이벤트 본문이 중복되지 않는다.
  assert.equal(String(parentPayload.text).includes("신규계정"), false);
  // 부모는 댓글로 오인되지 않는다.
  assert.equal((parentPayload.appEventThread as { parentDedupeKey?: string }).parentDedupeKey, undefined);

  const reply = notifications.get(`operational:${sample.eventId}`);
  assert.ok(reply);
  const replyPayload = reply.payload as Prisma.InputJsonObject;
  assert.match(String(replyPayload.text), /신규계정/);
  assert.deepEqual(replyPayload.appEventThread, {
    parentDedupeKey: parentKey("2026-10-19", "bloomhand"),
    destinationKey: "action-events",
    day: "2026-10-19",
    appId: "bloomhand",
  });
});

test("같은 날 같은 앱의 추가 이벤트는 본메시지를 재사용하고 건수를 갱신한다", async (t) => {
  const { notifications } = isolated(t);
  const second = { ...sample, eventId: "identity_delivery_67890", occurredAt: "2026-10-19T02:30:00Z" };
  assert.equal((await POST(request())).status, 202);
  assert.equal((await POST(request(second))).status, 202);
  assert.equal(notifications.size, 3, "본메시지 하나와 댓글 둘");
  const parent = notifications.get(parentKey("2026-10-19", "bloomhand"));
  assert.ok(parent);
  const parentPayload = parent.payload as Prisma.InputJsonObject;
  assert.match(String(parentPayload.text), /2건/);
  assert.match(String(parentPayload.text), /마지막 업데이트 10-19 11:30/);
});

test("다른 앱과 다른 날은 본메시지를 따로 만든다", async (t) => {
  const { notifications } = isolated(t);
  const other = { ...sample, eventId: "identity_delivery_54321", appId: "happy-farm" };
  const nextDay = { ...sample, eventId: "identity_delivery_11111", occurredAt: "2026-10-20T00:30:00Z" };
  assert.equal((await POST(request())).status, 202);
  assert.equal((await POST(request(other))).status, 202);
  assert.equal((await POST(request(nextDay))).status, 202);
  assert.ok(notifications.get(parentKey("2026-10-19", "bloomhand")));
  assert.ok(notifications.get(parentKey("2026-10-19", "happy-farm")));
  assert.ok(notifications.get(parentKey("2026-10-20", "bloomhand")));
});

test("미등록 앱도 원본 appId로 건별 알림을 보낸다", async (t) => {
  const { notifications } = isolated(t, { registered: false });
  assert.equal((await POST(request())).status, 202);
  const notification = notifications.get(`operational:${sample.eventId}`);
  assert.ok(notification);
  assert.match(String((notification.payload as Prisma.InputJsonObject).text), /bloomhand/);
  const parent = notifications.get(parentKey("2026-10-19", "bloomhand"));
  assert.ok(parent);
  assert.match(String((parent.payload as Prisma.InputJsonObject).text), /bloomhand/);
});

test("최초 계정과 같은 이벤트 재전송은 건별 한 줄 한 건으로 수렴한다", async (t) => {
  const { stored, notifications } = isolated(t);
  assert.equal((await POST(request())).status, 202);
  assert.equal((await POST(request())).status, 200);
  assert.equal(stored.size, 1);
  assert.equal(notifications.size, 2, "본메시지 하나와 댓글 하나");
  assert.ok(notifications.has(`operational:${sample.eventId}`));
});

test("원장 저장 뒤 enqueue 실패도 재전송으로 복구하고 추가 알림을 만들지 않는다", async (t) => {
  const { stored, notifications } = isolated(t, { failEnqueue: true });
  await assert.rejects(POST(request()), /outbox temporarily unavailable/);
  assert.equal(stored.size, 1);
  assert.equal(notifications.size, 0);
  assert.equal((await POST(request())).status, 200);
  assert.equal((await POST(request())).status, 200);
  assert.equal(notifications.size, 2);
});

test("광고 보상도 본메시지와 댓글로 묶고 테스트 결제 실패는 건별 메시지를 유지한다", async (t) => {
  const { notifications } = isolated(t);
  const events: OperationalEventInput[] = [
    { ...sample, eventId: "ad_reward_delivery_12345", type: "ad.reward.delivered" as const, attributes: { provider: "admob" } },
    { ...sample, eventId: "ad_reward_delivery_67890", type: "ad.reward.delivered" as const, attributes: { provider: "admob" } },
    { ...sample, eventId: "iap_failure_delivery_12345", type: "iap.completion_failed" as const, attributes: { platform: "appstore", isTestPurchase: true } },
  ];
  for (const event of events) assert.equal((await POST(request(event))).status, 202);
  assert.equal(notifications.size, 4, "광고 본메시지 하나와 댓글 둘, 결제 댓글 하나");
  assert.deepEqual(
    [...notifications.values()].map(n => n.deliveries[0].destinationKey),
    ["ad-rewards", "ad-rewards", "ad-rewards", "iap"],
  );
  assert.ok(notifications.get(parentKey("2026-10-19", "bloomhand", "ad-rewards")));
  assert.equal(notifications.get(parentKey("2026-10-19", "bloomhand", "iap")), undefined);
});

test("잘못된 서명과 금지 속성은 원장이나 알림을 만들기 전에 거부한다", async (t) => {
  const { stored, notifications } = isolated(t);
  assert.equal((await POST(request(sample, "bad-signature"))).status, 401);
  assert.equal((await POST(request({ ...sample, attributes: { platformUserId: "blocked" } }))).status, 400);
  assert.equal(stored.size, 0);
  assert.equal(notifications.size, 0);
});
