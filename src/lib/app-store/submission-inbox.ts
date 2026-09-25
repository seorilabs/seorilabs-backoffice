import { prisma } from "@/lib/prisma";
import { asc, asArray } from "@/lib/app-store/asc-client";
import { extractAppleSubmissionEvent } from "@/lib/app-store/submission-events";
import { receiveAppStoreSubmissionEvent } from "@/lib/app-store/submission-receiver";

async function processOne(id: string, payload: unknown): Promise<void> {
  const event = extractAppleSubmissionEvent(payload);
  if (!event || event.externalEventId !== id) throw new Error("Apple 웹훅 형식 오류");
  const version = await asc(`/v1/appStoreVersions/${encodeURIComponent(event.externalVersionId)}?include=app`);
  const resource = asArray(version.data)[0];
  const app = version.included?.find((item) => item.type === "apps");
  const bundleId = app?.attributes?.bundleId;
  if (resource?.id !== event.externalVersionId || typeof bundleId !== "string") {
    throw new Error("Apple 버전의 앱 식별자를 확인할 수 없음");
  }
  const result = await receiveAppStoreSubmissionEvent({
    ...event,
    bundleId,
    externalVersionLabel: typeof resource.attributes?.versionString === "string"
      ? resource.attributes.versionString : null,
  });
  if (result.decision !== "ignored") {
    const localApp = await prisma.app.findFirst({
      where: { iosBundle: bundleId }, select: { id: true },
    });
    if (localApp) await prisma.storeReviewSubmissionSync.upsert({
      where: { appId_store: { appId: localApp.id, store: "APP_STORE" } },
      create: { appId: localApp.id, store: "APP_STORE", lastSuccessAt: new Date() },
      update: { lastSuccessAt: new Date(), lastFailureReason: null },
    });
  }
}

export async function drainAppleSubmissionInbox(now = new Date()): Promise<{
  processed: number; failed: number;
}> {
  // 처리 중 종료된 worker의 lease를 다음 실행에서 복구한다.
  await prisma.storeSubmissionWebhookEvent.updateMany({
    where: { status: "PROCESSING", updatedAt: { lt: new Date(now.getTime() - 5 * 60_000) } },
    data: { status: "PENDING" },
  });
  const rows = await prisma.storeSubmissionWebhookEvent.findMany({
    where: { status: "PENDING", eligibleAt: { lte: now } },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    const claim = await prisma.storeSubmissionWebhookEvent.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "PROCESSING", attempts: { increment: 1 } },
    });
    if (claim.count !== 1) continue;
    try {
      await processOne(row.id, row.payload);
      await prisma.storeSubmissionWebhookEvent.update({
        where: { id: row.id },
        data: { status: "PROCESSED", processedAt: new Date(), error: null },
      });
      processed++;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 200) : "unknown";
      const attempts = row.attempts + 1;
      await prisma.storeSubmissionWebhookEvent.update({
        where: { id: row.id },
        data: {
          status: attempts >= 10 ? "FAILED" : "PENDING",
          eligibleAt: new Date(Date.now() + Math.min(30_000 * 2 ** attempts, 30 * 60_000)),
          error: message,
        },
      });
      console.error("[appstore-webhook] 처리 실패", row.id, message);
      failed++;
    }
  }
  return { processed, failed };
}

export async function purgeSubmissionPayloads(now = new Date()): Promise<void> {
  const expired = await prisma.storeReviewSubmissionObservation.findMany({
    where: { expiresAt: { lte: now } }, select: { id: true }, take: 100,
  });
  if (expired.length) await prisma.storeReviewSubmissionObservation.updateMany({
    where: { id: { in: expired.map((item) => item.id) } },
    data: { rawPayload: {}, expiresAt: null },
  });
  await prisma.storeSubmissionWebhookEvent.deleteMany({
    where: { status: "PROCESSED", processedAt: { lt: new Date(now.getTime() - 7 * 24 * 60 * 60_000) } },
  });
  await prisma.storeSubmissionWebhookEvent.updateMany({
    where: { status: "FAILED", createdAt: { lt: new Date(now.getTime() - 7 * 24 * 60 * 60_000) } },
    data: { payload: {}, error: "7일 보존기한 경과" },
  });
}
