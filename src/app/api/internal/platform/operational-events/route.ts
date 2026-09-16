import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { prisma } from "@/lib/prisma";
import {
  isOpsAlert,
  operationalEventFacts,
  operationalEventLine,
  parseOperationalEvent,
  verifyOperationalEventSignature,
} from "@/lib/platform/operational-events";
import { recordIdentitySignup } from "@/lib/notifications/identity-summary";
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

  // 중복이어도 알림 경로를 다시 태운다. 이벤트 저장 뒤 enqueue가 실패하면 Platform
  // 재전송이 유일한 복구 경로인데, 여기서 조기 반환하면 그 경로가 막힌다. 아래 처리는
  // incident dedupe와 notification dedupeKey, 마일스톤 unique로 모두 멱등하다.
  // Platform registry app_id 가 저장소 slug 와 다른 앱(운글=ungeul/saju-reader)이 있다.
  // slug 로만 찾으면 그런 앱이 미등록으로 떨어져 요약 카드·마일스톤 경로를 통째로 놓친다.
  const app = await prisma.app.findFirst({
    where: {
      OR: [{ platformAppId: input.appId }, { platformAppId: null, slug: input.appId }],
    },
    select: {
      id: true,
      slug: true,
      platformAppId: true,
      displayName: true,
      platformUserBaseline: true,
    },
  });
  const alert = isOpsAlert(input.type);
  const occurredAt = new Date(input.occurredAt);
  const incidentKind = app ? input.type : `${input.type}:${input.appId}`;
  if (alert) {
    await recordIncident({
      source: "platform",
      kind: incidentKind,
      severity: "critical",
      // 표시 문자열을 잘라 쓰지 않는다. 표시가 한 줄로 바뀌면 요약이 통째로 망가진다.
      summary: operationalEventFacts(input).headline,
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
    // 등록된 앱의 신규 계정은 건별 카드 대신 앱·일 요약 카드 하나를 갱신한다.
    const summarized = app && input.type === "identity.created"
      ? await recordIdentitySignup({ app, event: input })
      : false;
    if (!milestone && !summarized) {
      await enqueueNotification({
        dedupeKey: `operational:${input.eventId}`,
        kind: "OPERATIONAL_EVENT",
        occurredAt,
        payload: {
          text: operationalEventLine(input, app?.displayName ?? input.appId),
          // 줄줄이 쌓이는 기록이라 건마다 상자를 그리지 않는다.
          plain: true,
        },
        destinations: discordDestinations(["action-events"]),
      });
    }
  }
  return NextResponse.json({ ok: true, duplicate }, { status: duplicate ? 200 : 202 });
}
