import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { notificationDestinations } from "@/lib/notifications/destinations";
import { enqueueEditableNotification, enqueueNotification } from "@/lib/notifications/outbox";
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
import {
  appEventParentDedupeKey,
  appEventThreadSummary,
  dayThreadStats,
  isAppEventThreadDestination,
  operationalDestinationKey,
} from "@/lib/platform/app-event-thread";
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
                  : "구분 미확인",
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
  const appName = app?.displayName ?? input.appId;
  // 이벤트가 실제로 놓이는 채널. 전용 채널이 없으면 기존 폴백 규칙을 따른다.
  const destinationKey = operationalDestinationKey(input.type);
  const destinations = notificationDestinations([destinationKey]);
  const eventPayload: Prisma.InputJsonObject = appEvent
    ? {
        text: operationalEventLine(input, appName, undefined, signupOrdinal),
        plain: true,
        ...(signupOrdinal === undefined ? {} : { signupOrdinal }),
      }
    : renderPayload(operationalInterestCard(input, appName));
  const report = { category: "change", reason: "REQUESTED_INDIVIDUAL_EVENT" };

  if (isAppEventThreadDestination(destinationKey)) {
    // 그날·그 앱의 첫 이벤트가 루트 메시지(본메시지)를 만들고, 그 이벤트부터
    // 쓰레드 댓글로 싣는다. 본메시지는 건수와 마지막 갱신 시각만 들고 댓글이
    // 늘어날 때마다 같은 메시지를 편집해 갱신한다.
    const day = metricDayOf(occurredAt);
    const stats = await dayThreadStats({
      appId: input.appId,
      day,
      destinationKey,
    });
    const parentDedupeKey = appEventParentDedupeKey(
      destinationKey,
      day,
      input.appId,
    );
    await enqueueEditableNotification({
      dedupeKey: parentDedupeKey,
      kind: "OPERATIONAL_EVENT",
      occurredAt,
      payload: {
        text: appEventThreadSummary({
          destinationKey,
          day,
          appName,
          count: stats.count,
          lastEventAt: stats.lastEventAt,
        }),
        plain: true,
        editable: true,
        report: { category: "change", reason: "DAILY_APP_EVENT_THREAD" },
        appEventThread: {
          destinationKey,
          day,
          appId: input.appId,
          count: stats.count,
          ...(stats.lastEventAt
            ? { lastEventAt: stats.lastEventAt.toISOString() }
            : {}),
        },
      },
      destinations,
    });
    await enqueueNotification({
      dedupeKey,
      kind: "OPERATIONAL_EVENT",
      occurredAt,
      payload: {
        ...eventPayload,
        report,
        appEventThread: {
          parentDedupeKey,
          destinationKey,
          day,
          appId: input.appId,
        },
      },
      destinations,
    });
  } else {
    await enqueueNotification({
      dedupeKey,
      kind: "OPERATIONAL_EVENT",
      occurredAt,
      payload: { ...eventPayload, report },
      destinations,
    });
  }
  return NextResponse.json(
    { ok: true, duplicate },
    { status: duplicate ? 200 : 202 },
  );
}
