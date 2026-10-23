import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ingestConsoleMetrics } from "@/lib/core/console-metrics-collect";
import { validateConsoleDay, type ConsoleMetricsPush } from "../console-source";
import { verifyStoredConsoleDays } from "./readback";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { discordDestinations } from "@/lib/notifications/destinations";
import { EMBED_COLOR } from "@/lib/notifications/style";

/** 기존 수동 push도 같은 저장 대조를 거친 뒤 운영알림을 남긴다. */
export async function ingestAndVerifyConsolePush(payload: unknown, now: Date) {
  const runId = randomUUID();
  let result: Awaited<ReturnType<typeof ingestConsoleMetrics>> | undefined;
  let expected = 0; let verified = 0; let failed = false;
  try {
    result = await ingestConsoleMetrics(payload, now);
    const registry = await prisma.app.findMany({ select: { id: true, slug: true, aitMiniAppId: true } });
    for (const push of (payload as ConsoleMetricsPush).apps) {
      if (!push || !Array.isArray(push.days)) continue;
      expected += push.days.length;
      const app = registry.find((app) => push.slug ? app.slug === push.slug : app.aitMiniAppId === push.miniAppId);
      const days = push.days.flatMap((day) => { const checked = validateConsoleDay(day); return checked.ok ? [checked.day] : []; });
      if (app && push.miniAppId) verified += (await verifyStoredConsoleDays(app.id, push.miniAppId, days, now)).verified;
    }
    failed = verified !== expected || result.errors.length > 0 || result.skipped.length > 0 || result.warnings.length > 0;
    return { ...result, verification: { expected, verified, mismatched: expected - verified } };
  } catch (error) { failed = true; throw error; }
  finally {
    await enqueueNotification({ dedupeKey: `ait-console-push:${runId}`, kind: "OPERATIONAL_EVENT", occurredAt: now,
      destinations: discordDestinations(["ops-alerts"]), payload: {
        report: { category: "response", reason: "USER_REQUESTED_COLLECTION_RESULT" }, source: "ait_console",
        text: `수동 수집 저장 대조: 요청 ${expected}건, 일치 ${verified}건, 미검증 ${expected - verified}건\n저장 ${result?.upserts ?? "미확인"}건, 저장 오류 ${result?.errors.length ?? "미확인"}건, 저장 제외 ${result?.skipped.length ?? "미확인"}건, 경고 ${result?.warnings.length ?? "미확인"}건\n${failed ? "일부 또는 전체 자료의 저장을 확인하지 못했습니다." : "제공된 값과 방금 저장한 행이 일치합니다. 미제공 지표의 수집을 뜻하지 않습니다."}`,
        embed: { title: failed ? "앱인토스 수동 수집 확인 필요" : "앱인토스 수동 수집 검증 완료", color: failed ? EMBED_COLOR.WARNING : EMBED_COLOR.SUCCESS, timestamp: now.toISOString() },
      } });
  }
}
