import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyAppleWebhookSignature } from "@/lib/app-store/webhook-verify";
import { extractAppleSubmissionEvent } from "@/lib/app-store/submission-events";
import { discordRender } from "@/lib/notifications/format";

const payload = {
  data: {
    type: "appStoreVersionAppVersionStateUpdated",
    id: "apple-event-1",
    attributes: {
      newValue: "READY_FOR_REVIEW",
      oldValue: "PREPARE_FOR_SUBMISSION",
      timestamp: "2026-09-25T05:00:52.745Z",
    },
    relationships: {
      instance: { data: { type: "appStoreVersions", id: "version-1" } },
    },
  },
};

test("Apple 공식 이벤트를 검증하고 버전 ID와 새 단계를 읽는다", () => {
  const body = JSON.stringify(payload);
  const secret = "test-only-secret";
  const signature = "hmacsha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyAppleWebhookSignature({ body, signature, secret }), true);
  assert.equal(verifyAppleWebhookSignature({ body: body + " ", signature, secret }), false);
  assert.equal(verifyAppleWebhookSignature({ body, signature: "hmacsha256=zz", secret }), false);
  const event = extractAppleSubmissionEvent(payload);
  assert.equal(event?.externalEventId, "apple-event-1");
  assert.equal(event?.externalVersionId, "version-1");
  assert.equal(event?.state, "READY_FOR_REVIEW");
});

test("알림 payload는 기존 Discord 렌더러 계약을 충족한다", () => {
  const rendered = discordRender("STORE_REVIEW", {
    text: "✓ 심사 중",
    embed: { title: "App Store · Test", color: 0x0a84ff },
  });
  assert.equal(rendered?.text, "✓ 심사 중");
  assert.equal(rendered?.embed?.color, 0x0a84ff);
});
