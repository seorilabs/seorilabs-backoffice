import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import type { OperationalEventInput } from "@/lib/platform/operational-events";

const MILESTONE_LABELS: Partial<Record<OperationalEventInput["type"], string>> = {
  "identity.created": "첫 Platform 계정 생성",
  "iap.granted": "첫 IAP 지급 확정",
  "ad.reward.delivered": "첫 광고 보상 지급",
};

export function milestoneLabelForEvent(type: OperationalEventInput["type"]): string | undefined {
  return MILESTONE_LABELS[type];
}

export function isDuplicateMilestoneError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// 이미 마일스톤이 있는데 같은 이벤트가 다시 들어오는 경우다. Platform 재전송이
// 알림 유실의 유일한 복구 경로라서, 아직 발송하지 못한 최초 이벤트만 다시 알린다.
export function milestoneRetryAction(
  existing: { firstEventId: string; notifiedAt: Date | null } | null,
  eventId: string,
): "notify" | "skip" | "not-milestone" {
  if (!existing || existing.firstEventId !== eventId) return "not-milestone";
  return existing.notifiedAt ? "skip" : "notify";
}

export async function recordOperationalMilestone(input: {
  appId: string;
  displayName: string;
  event: OperationalEventInput;
}): Promise<boolean> {
  const label = milestoneLabelForEvent(input.event.type);
  if (!label) return false;
  let milestoneId: string;
  try {
    const milestone = await prisma.operationalMilestone.create({
      data: {
        appId: input.appId,
        eventType: input.event.type,
        firstEventId: input.event.eventId,
        firstObservedAt: new Date(input.event.occurredAt),
      },
    });
    milestoneId = milestone.id;
  } catch (error) {
    if (!isDuplicateMilestoneError(error)) throw error;
    const existing = await prisma.operationalMilestone.findUnique({
      where: { appId_eventType: { appId: input.appId, eventType: input.event.type } },
      select: { id: true, firstEventId: true, notifiedAt: true },
    });
    const action = milestoneRetryAction(existing, input.event.eventId);
    if (!existing || action === "not-milestone") return false;
    if (action === "skip") return true;
    milestoneId = existing.id;
  }
  await enqueueNotification({
    dedupeKey: `milestone:${input.appId}:${input.event.type}`,
    kind: "MILESTONE",
    occurredAt: new Date(input.event.occurredAt),
    payload: {
      text: `🎉 **${input.displayName} · ${label}**\n최초 관측: ${new Date(input.event.occurredAt).toISOString()}`,
    },
    destinations: discordDestinations(["action-events"]),
  });
  await prisma.operationalMilestone.update({ where: { id: milestoneId }, data: { notifiedAt: new Date() } });
  return true;
}
