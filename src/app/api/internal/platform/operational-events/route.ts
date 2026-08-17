import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { configuredDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { prisma } from "@/lib/prisma";
import {
  isOpsAlert,
  operationalEventMessage,
  parseOperationalEvent,
  verifyOperationalEventSignature,
} from "@/lib/platform/operational-events";
import { drainAllNotifications } from "@/lib/telegram/deploy-notifications";

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

  const app = await prisma.app.findUnique({
    where: { slug: input.appId },
    select: { displayName: true },
  });
  const alert = isOpsAlert(input.type);
  await enqueueNotification({
    dedupeKey: `operational:${input.eventId}`,
    kind: alert ? "OPS_ALERT" : "OPERATIONAL_EVENT",
    occurredAt: new Date(input.occurredAt),
    payload: {
      text: operationalEventMessage(input, app?.displayName ?? input.appId),
    },
    destinations: configuredDestinations([alert ? "ops-alerts" : "action-events"]),
  });
  await drainAllNotifications();
  return NextResponse.json({ ok: true, duplicate }, { status: duplicate ? 200 : 202 });
}
