import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { prisma } from "@/lib/prisma";
import {
  isOpsAlert,
  operationalEventMessage,
  parseOperationalEvent,
  verifyOperationalEventSignature,
} from "@/lib/platform/operational-events";
import { recordOperationalMilestone } from "@/lib/notifications/milestones";
import { recordIncident, recoverIncident } from "@/lib/notifications/incidents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  if (
    !verifyOperationalEventSignature({
      rawBody,
      timestampHeader: request.headers.get("x-seori-timestamp"),
      signatureHeader: request.headers.get("x-seori-signature"),
      secret: env.platformEventSharedSecret(),
    })
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const input = parseOperationalEvent(parsedBody);
  if (!input) return NextResponse.json({ error: "invalid event" }, { status: 400 });

  let duplicate = false;
  try {
    await prisma.operationalEvent.create({
      data: {
        eventId: input.eventId,
        eventType: input.type,
        appId: input.appId,
        occurredAt: new Date(input.occurredAt),
        outcome: input.outcome,
        attributes: input.attributes as Prisma.InputJsonObject,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      duplicate = true;
    } else {
      throw error;
    }
  }

  if (duplicate) return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });

  const app = await prisma.app.findUnique({
    where: { slug: input.appId },
    select: { id: true, displayName: true },
  });
  const alert = isOpsAlert(input.type);
  const occurredAt = new Date(input.occurredAt);
  const incidentKind = app ? input.type : `${input.type}:${input.appId}`;
  if (alert) {
    await recordIncident({
      source: "platform",
      kind: incidentKind,
      severity: "critical",
      summary: operationalEventMessage(input, app?.displayName ?? input.appId).split("\n")[0].replace(/[*]/g, ""),
      signalId: input.eventId,
      detectedAt: occurredAt,
      appId: app?.id,
      evidence: { outcome: input.outcome, eventType: input.type },
    });
  } else {
    const recoveryKind = input.type === "iap.granted"
      ? "iap.completion_failed"
      : input.type === "ad.reward.delivered"
        ? "ad.reward.delivery_failed"
        : null;
    if (recoveryKind) {
      await recoverIncident({
        source: "platform",
        kind: app ? recoveryKind : `${recoveryKind}:${input.appId}`,
        appId: app?.id,
        signalId: input.eventId,
        recoveredAt: occurredAt,
      });
    }
    const milestone = app
      ? await recordOperationalMilestone({ appId: app.id, displayName: app.displayName, event: input })
      : false;
    if (!milestone) {
      await enqueueNotification({
        dedupeKey: `operational:${input.eventId}`,
        kind: "OPERATIONAL_EVENT",
        occurredAt,
        payload: { text: operationalEventMessage(input, app?.displayName ?? input.appId) },
        destinations: discordDestinations(["action-events"]),
      });
    }
  }
  return NextResponse.json({ ok: true, duplicate: false }, { status: 202 });
}
