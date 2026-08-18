import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { configuredDestinations } from "@/lib/notifications/destinations";
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
    if (isDuplicateMilestoneError(error)) return false;
    throw error;
  }
  const destinations = configuredDestinations(["action-events"]);
  await enqueueNotification({
    dedupeKey: `milestone:${input.appId}:${input.event.type}`,
    kind: "MILESTONE",
    occurredAt: new Date(input.event.occurredAt),
    payload: {
      text: `🎉 **${input.displayName} · ${label}**\n최초 관측: ${new Date(input.event.occurredAt).toISOString()}`,
    },
    destinations,
  });
  if (destinations.length) {
    await prisma.operationalMilestone.update({ where: { id: milestoneId }, data: { notifiedAt: new Date() } });
  }
  return true;
}
