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
    { destinations: () => [] },
  ));
});
