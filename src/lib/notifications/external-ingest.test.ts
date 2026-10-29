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
    "ops.notification.v1.private-feed",
    payload,
    {
      destinationConfigured: () => true,
      destinations: (route) => [{ provider: "SLACK", key: route }],
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
  assert.deepEqual(destinations, [{ provider: "SLACK", key: "private-feed" }]);
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

test("기본 설정 검증은 Slack 채널 ID를 허용하고 이전 숫자 ID를 거부한다", async () => {
  const key = "SLACK_CHANNEL_PRIVATE_FEED_ID";
  const previous = process.env[key];
  try {
    process.env[key] = "C0CD8VDS4AY";
    let deliveries: unknown;
    const ack = await ingestExternalNotification("ops.notification.v1.private-feed", payload, {
      enqueue: async (input) => { deliveries = input.destinations; return "configured-slack"; },
    });
    assert.equal(ack.accepted, true);
    assert.deepEqual(deliveries, [{provider:"SLACK",key:"private-feed"}]);
    process.env[key] = "123456789012345678";
    await assert.rejects(() => ingestExternalNotification("ops.notification.v1.private-feed", payload), /목적지 미설정/);
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

test("외부 뉴스의 선택형 표시 정보는 본문과 식별자를 유지해 저장한다", async()=>{
  const {ingestExternalNotification}=await import("./external-ingest");
  let input:Parameters<import("./outbox").enqueueNotification>[0]|undefined;
  const presentation={layout:"newsletter" as const,title:"뉴스 1건",items:[{title:"기사",summary:"요약",url:"https://example.com/a"}]};
  await ingestExternalNotification("ops.notification.v1.private-feed",{version:1,id:"news-preserved",source:"news",text:"기존 본문",presentation},{destinationConfigured:()=>true,destinations:()=>[{provider:"SLACK",key:"private-feed"}],enqueue:async value=>{input=value;return "event";}});
  assert.equal(input?.dedupeKey,"external:news:news-preserved");assert.equal(input?.payload.text,"기존 본문");assert.deepEqual(input?.payload.presentation,presentation);
});
