import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { iapDestinations } from "@/lib/notifications/iap-summary";
import { destinationOrFallback, notificationDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { renderPayload } from "@/lib/notifications/format";
import { metricDayOf, metricDayStart } from "@/lib/analytics/metric-day";
import { prisma } from "@/lib/prisma";
import {
  shouldReportOperationalFailure,
  operationalEventFacts,
  operationalEventLine,
  operationalInterestCard,
  parseOperationalEvent,
  verifyOperationalEventSignature,
} from "@/lib/platform/operational-events";
import { recordIncident } from "@/lib/notifications/incidents";

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
  if (!input)
    return NextResponse.json({ error: "invalid event" }, { status: 400 });

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
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
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
      OR: [
        { platformAppId: input.appId },
        { platformAppId: null, slug: input.appId },
      ],
    },
    select: {
      id: true,
      slug: true,
      platformAppId: true,
      displayName: true,
      platformUserBaseline: true,
    },
  });
  const alert = shouldReportOperationalFailure(input);
  const occurredAt = new Date(input.occurredAt);
  const incidentKind = app ? input.type : `${input.type}:${input.appId}`;
  if (alert) {
    await recordIncident({
      source: "platform",
      kind: incidentKind,
      severity: "critical",
      // 표시 문자열을 잘라 쓰지 않는다. 표시가 한 줄로 바뀌면 요약이 통째로 망가진다.
      summary: `${app?.displayName ?? input.appId} · ${operationalEventFacts(input).headline}`,
      signalId: input.eventId,
      detectedAt: occurredAt,
      appId: app?.id,
      evidence: {
        outcome: input.outcome,
        eventType: input.type,
        ...(input.type === "iap.completion_failed"
          ? {
              purchaseEnvironment:
                input.attributes.isTestPurchase === false
                  ? "실제 주문"
                  : "실제·테스트 여부 제공 안됨",
            }
          : {}),
        impact:
          input.type === "ad.reward.delivery_failed"
            ? "광고 시청 후 보상이 지급되지 않았습니다."
            : "마켓의 결제 완료 처리가 실패했습니다. 권리 지급 상태와 마켓 완료 상태를 구분해 확인해야 합니다.",
        action: "해당 앱의 지급 원장에서 실패 주문·재시도 결과를 확인하세요.",
        platform: String(
          input.attributes.platform ?? input.attributes.provider ?? "제공 안됨",
        ),
      },
    });
  }
  // 다른 주문의 성공을 장애 해결로 보지 않고 각 확정 이벤트를 별도 키로 알린다.
  const dedupeKey = `operational:${input.eventId}`;
  let signupOrdinal: number | undefined;
  if (input.type === "identity.created") {
    const prior = await prisma.notificationEvent.findUnique({ where: { dedupeKey }, select: { payload: true } });
    const stored = prior?.payload as Prisma.JsonObject | undefined;
    if (typeof stored?.signupOrdinal === "number") signupOrdinal = stored.signupOrdinal;
    else {
      const start = metricDayStart(metricDayOf(occurredAt));
      signupOrdinal = await prisma.operationalEvent.count({ where: {
        appId: input.appId, eventType: input.type,
        occurredAt: { gte: start, lt: new Date(start.getTime() + 86400000) },
        OR: [{ occurredAt: { lt: occurredAt } }, { occurredAt, eventId: { lte: input.eventId } }],
      } });
    }
  }
  const appEvent = input.type === "identity.created" || input.type === "app.version.first_seen";
  await enqueueNotification({
    dedupeKey, kind: "OPERATIONAL_EVENT", occurredAt,
    payload: {
      ...(appEvent
        ? { text: operationalEventLine(input, app?.displayName ?? input.appId, undefined, signupOrdinal), plain: true,
            ...(signupOrdinal === undefined ? {} : { signupOrdinal }) }
        : renderPayload(operationalInterestCard(input, app?.displayName ?? input.appId))),
      report: { category: "change", reason: "REQUESTED_INDIVIDUAL_EVENT" },
    },
    destinations: input.type.startsWith("iap.") ? iapDestinations()
      : input.type.startsWith("ad.") ? destinationOrFallback("ad-rewards", "action-events")
      : notificationDestinations(["action-events"]),
  });
  return NextResponse.json(
    { ok: true, duplicate },
    { status: duplicate ? 200 : 202 },
  );
}
