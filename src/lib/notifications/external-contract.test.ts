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
