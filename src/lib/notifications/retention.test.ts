import assert from "node:assert/strict";
import test from "node:test";
import { CHANNEL_DESTINATIONS } from "@/lib/notifications/destinations";
import {
  commandRetentionWhere,
  notificationRetentionWhere,
  reviewEventRetentionWhere,
} from "@/lib/notifications/retention";

test("보존 정리는 일반 운영 기록을 남기고 원문 기한이 지난 리뷰만 선택한다", () => {
  const cutoff = new Date("2026-07-19T00:00:00Z");
  assert.deepEqual(
    notificationRetentionWhere(cutoff, ["active-incident-message"]),
    {
      provider: "SLACK",
      status: { in: ["SENT", "SUPPRESSED", "DEAD_LETTER"] },
      deletedAt: null,
      event: { createdAt:{lt:cutoff}, OR:[{kind:"STORE_REVIEW"},{payload:{path:"$.reviewReport",equals:true}}] },
      OR: [{providerMessageId:null},{providerMessageId:{notIn:["active-incident-message"]}}],
    },
  );
});

test("30일 지난 리뷰 payload도 실제 게시물과 첨부 삭제가 확인된 뒤에만 제거한다", () => {
  const cutoff = new Date("2026-07-19T00:00:00Z");
  assert.deepEqual(reviewEventRetentionWhere(cutoff), {
    kind: "STORE_REVIEW",
    createdAt: { lt: cutoff },
    deliveries: {
      some: {},
      every: { deletedAt: { not: null } },
    },
  });
});

test("종료된 명령만 정리하며 활성 장애 카드와 game-factory 채널은 보호한다", () => {
  const cutoff = new Date("2026-07-19T00:00:00Z");
  assert.deepEqual(commandRetentionWhere(cutoff, ["active-incident-message"]), {
    sourceProvider:"SLACK",
    status: { in: ["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"] },
    completedAt: { lt: cutoff },
    messageId: { not: null, notIn: ["active-incident-message"] },
  });
  assert.equal(
    CHANNEL_DESTINATIONS.includes("game-factory-builds" as never),
    false,
  );
  assert.equal(CHANNEL_DESTINATIONS.includes("user-reviews"), true);
});
