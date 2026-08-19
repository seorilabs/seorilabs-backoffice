import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import {
  isDuplicateMilestoneError,
  milestoneLabelForEvent,
  milestoneRetryAction,
} from "@/lib/notifications/milestones";

test("최초 알림 대상은 계정 생성·IAP 지급·광고 보상 지급만 포함한다", () => {
  assert.equal(milestoneLabelForEvent("identity.created"), "첫 Platform 계정 생성");
  assert.equal(milestoneLabelForEvent("iap.granted"), "첫 IAP 지급 확정");
  assert.equal(milestoneLabelForEvent("ad.reward.delivered"), "첫 광고 보상 지급");
  assert.equal(milestoneLabelForEvent("iap.completion_failed"), undefined);
});

test("appId와 eventType 중복은 이미 발송된 최초 마일스톤으로 처리한다", () => {
  const duplicate = new Prisma.PrismaClientKnownRequestError("unique constraint", {
    code: "P2002",
    clientVersion: "6.3.0",
  });
  const other = new Prisma.PrismaClientKnownRequestError("database unavailable", {
    code: "P1001",
    clientVersion: "6.3.0",
  });
  assert.equal(isDuplicateMilestoneError(duplicate), true);
  assert.equal(isDuplicateMilestoneError(other), false);
});

test("재전송된 최초 이벤트는 발송 전일 때만 다시 알린다", () => {
  const notified = { firstEventId: "identity_a", notifiedAt: new Date("2026-08-18T00:00:00Z") };
  const pending = { firstEventId: "identity_a", notifiedAt: null };
  assert.equal(milestoneRetryAction(pending, "identity_a"), "notify");
  assert.equal(milestoneRetryAction(notified, "identity_a"), "skip");
  assert.equal(milestoneRetryAction(pending, "identity_b"), "not-milestone");
  assert.equal(milestoneRetryAction(null, "identity_a"), "not-milestone");
});
