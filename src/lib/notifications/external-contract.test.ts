import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DISCORD_ATTACHMENT_BASE64_CHARS,
  notificationSubject,
  parseExternalNotification,
  routeFromNotificationSubject,
} from "@/lib/notifications/external-contract";

test("허용된 운영 알림 route만 NATS subject로 변환한다", () => {
  assert.equal(notificationSubject("finance-alerts"), "ops.notification.v1.finance-alerts");
  assert.equal(routeFromNotificationSubject("ops.notification.v1.private-feed"), "private-feed");
  assert.equal(routeFromNotificationSubject("ops.notification.v1.unknown"), null);
  assert.throws(() => notificationSubject("ops-alerts"));
});

test("외부 알림 payload를 엄격 검증한다", () => {
  const payload = parseExternalNotification({
    version: 1,
    id: "sweep:2026-08-18:complete",
    source: "upbit-sol-autowithdraw",
    text: "완료",
    occurredAt: "2026-08-18T00:00:00Z",
  });
  assert.equal(payload.id, "sweep:2026-08-18:complete");
  assert.throws(() => parseExternalNotification({ ...payload, unknown: true }));
  assert.throws(() => parseExternalNotification({ ...payload, id: "contains space" }));
  assert.throws(() => parseExternalNotification({ ...payload, text: "" }));
  assert.throws(() => parseExternalNotification({
    ...payload,
    attachment: {
      filename: "oversized.bin",
      contentType: "application/octet-stream",
      base64: "A".repeat(MAX_DISCORD_ATTACHMENT_BASE64_CHARS + 1),
    },
  }));
});

test("외부 알림은 같은 producer의 부모 알림 아래 Discord 쓰레드를 지정할 수 있다", () => {
  const payload = parseExternalNotification({
    version: 1,
    id: "review:entry:1",
    source: "seori-pr-bot",
    text: "MiniMax 응답 원문",
    thread: {
      parentId: "review:root:1",
      name: "gemini-pr-bot #47 리뷰 로그",
      plain: false,
    },
  });

  assert.deepEqual(payload.thread, {
    parentId: "review:root:1",
    name: "gemini-pr-bot #47 리뷰 로그",
    plain: false,
  });
  assert.throws(() => parseExternalNotification({
    ...payload,
    thread: { ...payload.thread, parentId: payload.id },
  }));
});
