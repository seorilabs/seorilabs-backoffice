import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { recordIapGrant } from "@/lib/notifications/iap-summary";
import { prisma } from "@/lib/prisma";
import {
  shouldReportOperationalFailure,
  operationalEventFacts,
  parseOperationalEvent,
  verifyOperationalEventSignature,
} from "@/lib/platform/operational-events";
import { recordOperationalMilestone } from "@/lib/notifications/milestones";
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
        ...(input.type === "iap.completion_failed"
          ? {
              purchaseEnvironment:
                input.attributes.isTestPurchase === false
                  ? "실제 주문"
                  : "실제·테스트 여부 제공 안됨",
            }
          : {}),
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
  } else {
    // 다른 주문의 성공은 기존 지급 실패가 해결됐다는 근거가 아니다.
    if (app) {
      if (input.type === "iap.granted")
        await recordIapGrant({ app, event: input });
      else
        await recordOperationalMilestone({
          appId: app.id,
          displayName: app.displayName,
          event: input,
        });
    }
    // 반복 성공은 operational_event 원장에서 조회한다. 동일 실패의 두 번째 카드도 만들지 않는다.
  }
  return NextResponse.json(
    { ok: true, duplicate },
    { status: duplicate ? 200 : 202 },
  );
}
