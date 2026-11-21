import test from "node:test";
import assert from "node:assert/strict";
import {
  appEventThreadKey,
  appEventThreadPayload,
  appEventThreadSummary,
  dayThreadStats,
  operationalDestinationKey,
  operationalEventGroup,
} from "./app-event-thread";

const CHANNEL_ENV = [
  "SLACK_CHANNEL_ACTION_EVENTS_ID",
  "SLACK_CHANNEL_AD_REWARDS_ID",
  "SLACK_CHANNEL_IAP_ID",
];

async function withChannels(
  values: Record<string, string>,
  run: () => void | Promise<void>,
): Promise<void> {
  const previous = CHANNEL_ENV.map((key) => process.env[key]);
  for (const key of CHANNEL_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    await run();
  } finally {
    CHANNEL_ENV.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}

test("전용 채널이 있으면 그 채널로, 없으면 앱이벤트로 폴백한다", async () => {
  await withChannels({ SLACK_CHANNEL_AD_REWARDS_ID: "C000AD", SLACK_CHANNEL_IAP_ID: "C000IAP" }, () => {
    assert.equal(operationalDestinationKey("ad.reward.delivered"), "ad-rewards");
    assert.equal(operationalDestinationKey("ad.reward.delivery_failed"), "ad-rewards");
    assert.equal(operationalDestinationKey("iap.granted"), "iap");
    assert.equal(operationalDestinationKey("identity.created"), "action-events");
  });
  await withChannels({}, () => {
    assert.equal(operationalDestinationKey("ad.reward.delivered"), "action-events");
    assert.equal(operationalDestinationKey("iap.granted"), "action-events");
    assert.equal(operationalDestinationKey("inbox.issued"), "action-events");
  });
});

test("이벤트 종류는 결제·광고·기타 묶음으로 갈린다", () => {
  assert.equal(operationalEventGroup("iap.completion_failed"), "iap");
  assert.equal(operationalEventGroup("ad.reward.delivered"), "ad");
  assert.equal(operationalEventGroup("identity.created"), "other");
  assert.equal(operationalEventGroup("app.version.first_seen"), "other");
});

test("쓰레드 키는 목적지·날짜·앱으로 하나로 정해진다", () => {
  assert.equal(
    appEventThreadKey("action-events", "2026-11-21", "bloomhand"),
    "operational-thread:action-events:2026-11-21:bloomhand",
  );
  assert.notEqual(
    appEventThreadKey("action-events", "2026-11-21", "bloomhand"),
    appEventThreadKey("action-events", "2026-11-22", "bloomhand"),
  );
  assert.notEqual(
    appEventThreadKey("action-events", "2026-11-21", "bloomhand"),
    appEventThreadKey("ad-rewards", "2026-11-21", "bloomhand"),
  );
});

test("본메시지는 날짜·앱 이름·건수·마지막 갱신 시각을 담는다", () => {
  const text = appEventThreadSummary({
    destinationKey: "action-events",
    day: "2026-11-21",
    appName: "블룸핸드",
    count: 12,
    lastEventAt: new Date("2026-11-21T05:32:00.000Z"),
    now: new Date("2026-11-21T06:00:00.000Z"),
  });
  assert.match(text, /블룸핸드/);
  assert.match(text, /2026-11-21/);
  assert.match(text, /12건/);
  assert.match(text, /마지막 업데이트 14:32/);
  const reward = appEventThreadSummary({
    destinationKey: "ad-rewards",
    day: "2026-11-21",
    appName: "블룸핸드",
    count: 3,
    lastEventAt: new Date("2026-11-21T00:41:00.000Z"),
    now: new Date("2026-11-21T01:00:00.000Z"),
  });
  assert.match(reward, /광고보상 3건/);
  assert.match(reward, /마지막 업데이트 09:41/);
});

test("본메시지 이름에 줄바꿈과 멘션을 넣지 않는다", () => {
  const text = appEventThreadSummary({
    destinationKey: "action-events",
    day: "2026-11-21",
    appName: "블룸\n핸드 <@U123>",
    count: 1,
    lastEventAt: new Date("2026-11-21T05:32:00.000Z"),
    now: new Date("2026-11-21T06:00:00.000Z"),
  });
  assert.equal(text.includes("\n"), false);
  assert.equal(text.includes("<@U123>"), false);
});

test("부모 payload는 댓글로 오인하지 않고 댓글 payload는 부모를 가리킨다", () => {
  assert.equal(
    appEventThreadPayload({
      text: "**[블룸핸드]** 2026-11-21 앱이벤트 1건 · 마지막 업데이트 14:32",
      appEventThread: { destinationKey: "action-events", day: "2026-11-21", appId: "bloomhand", count: 1 },
    }),
    null,
  );
  assert.deepEqual(
    appEventThreadPayload({
      text: "**[블룸핸드:1.0.3]** 신규계정#1 - firebase / 14:32",
      appEventThread: {
        parentDedupeKey: "operational-thread:action-events:2026-11-21:bloomhand",
        destinationKey: "action-events",
        day: "2026-11-21",
        appId: "bloomhand",
      },
    }),
    {
      parentDedupeKey: "operational-thread:action-events:2026-11-21:bloomhand",
      destinationKey: "action-events",
      day: "2026-11-21",
      appId: "bloomhand",
    },
  );
  assert.equal(appEventThreadPayload({ text: "본문" }), null);
  assert.equal(appEventThreadPayload(null), null);
});

test("건수와 마지막 시각은 같은 목적지로 해석되는 그날 이벤트만 센다", async () => {
  const rows = [
    { eventType: "identity.created", occurredAt: new Date("2026-11-21T01:00:00.000Z") },
    { eventType: "identity.recovered", occurredAt: new Date("2026-11-21T05:32:00.000Z") },
    { eventType: "ad.reward.delivered", occurredAt: new Date("2026-11-21T06:00:00.000Z") },
    { eventType: "iap.granted", occurredAt: new Date("2026-11-21T07:00:00.000Z") },
  ];
  const db = {
    operationalEvent: {
      findMany: async () => rows,
    },
  } as unknown as Parameters<typeof dayThreadStats>[0]["db"];
  await withChannels({ SLACK_CHANNEL_AD_REWARDS_ID: "C000AD", SLACK_CHANNEL_IAP_ID: "C000IAP" }, async () => {
    const action = await dayThreadStats({
      appId: "bloomhand",
      day: "2026-11-21",
      destinationKey: "action-events",
      db,
    });
    assert.equal(action.count, 2);
    assert.equal(action.lastEventAt?.toISOString(), "2026-11-21T05:32:00.000Z");
    const reward = await dayThreadStats({
      appId: "bloomhand",
      day: "2026-11-21",
      destinationKey: "ad-rewards",
      db,
    });
    assert.equal(reward.count, 1);
    assert.equal(reward.lastEventAt?.toISOString(), "2026-11-21T06:00:00.000Z");
  });
});
