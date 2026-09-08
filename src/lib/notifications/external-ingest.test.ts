import assert from "node:assert/strict";
import test from "node:test";
import { ingestExternalNotification } from "@/lib/notifications/external-ingest";

const payload = {
  version: 1 as const,
  id: "sweep:2026-08-18:complete",
  source: "upbit-sol-autowithdraw",
  text: "완료",
  occurredAt: "2026-08-18T00:00:00Z",
};

test("DB enqueue가 완료된 뒤에만 accepted ack를 반환한다", async () => {
  let finish!: (value: string) => void;
  const durableEnqueue = new Promise<string>((resolve) => { finish = resolve; });
  let settled = false;
  const pending = ingestExternalNotification(
    "ops.notification.v1.finance-alerts",
    payload,
    {
      destinationConfigured: () => true,
      destinations: (route) => [{ provider: "DISCORD", key: route }],
      enqueue: async (input) => {
        assert.equal(input.dedupeKey, `external:${payload.source}:${payload.id}`);
        return durableEnqueue;
      },
    },
  ).then((ack) => {
    settled = true;
    return ack;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  finish("event-1");
  assert.deepEqual(await pending, { accepted: true, id: "event-1" });
});

test("미허용 route와 미설정 목적지는 enqueue 전에 거부한다", async () => {
  await assert.rejects(() => ingestExternalNotification("ops.notification.v1.unknown", payload));
  await assert.rejects(() => ingestExternalNotification(
    "ops.notification.v1.private-feed",
    payload,
    { destinationConfigured: () => false },
  ));
});

test("전달 worker의 채널 설정이 있으면 논리 목적지를 enqueue한다", async () => {
  let destinations: unknown;
  await ingestExternalNotification(
    "ops.notification.v1.private-feed",
    payload,
    {
      destinationConfigured: () => true,
      enqueue: async (input) => {
        destinations = input.destinations;
        return "event-2";
      },
    },
  );
  assert.deepEqual(destinations, [{ provider: "DISCORD", key: "private-feed" }]);
});

test("외부 쓰레드 알림은 producer 범위의 부모 dedupe key로 변환한다", async () => {
  let enqueuedPayload: unknown;
  await ingestExternalNotification(
    "ops.notification.v1.seori-review",
    {
      ...payload,
      id: "review:entry:1",
      source: "seori-pr-bot",
      thread: {
        parentId: "review:root:1",
        name: "gemini-pr-bot #47 리뷰 로그",
        plain: false,
      },
    },
    {
      destinationConfigured: () => true,
      enqueue: async (input) => {
        enqueuedPayload = input.payload;
        return "event-thread";
      },
    },
  );

  assert.deepEqual(enqueuedPayload, {
    text: "완료",
    source: "seori-pr-bot",
    externalId: "review:entry:1",
    thread: {
      parentDedupeKey: "external:seori-pr-bot:review:root:1",
      threadName: "gemini-pr-bot #47 리뷰 로그",
      plain: false,
    },
  });
});
