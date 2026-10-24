import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ingestConsoleMetrics } from "@/lib/core/console-metrics-collect";
import { validateConsoleDay, type ConsoleMetricsPush } from "../console-source";
import { verifyStoredConsoleDays } from "./readback";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { consoleReport, recordConsoleIncident } from "./report";
import { AIT_LISTINGS } from "../ait-apps";

export function consolePushAppId(push: { slug?: string; miniAppId?: number }, registry: { id: string; slug: string; aitMiniAppId: number | null }[]) {
  const slug = push.slug ?? AIT_LISTINGS.find((listing) => listing.miniAppId === push.miniAppId)?.appSlug;
  const app = registry.find((app) => app.slug === slug) ?? registry.find((app) => app.aitMiniAppId === push.miniAppId);
  return app && (push.slug == null || push.slug === app.slug) ? app.id : undefined;
}

/** 기존 수동 push도 같은 저장 대조를 거친 뒤 운영알림을 남긴다. */
export async function ingestAndVerifyConsolePush(payload: unknown, now: Date, clock: () => Date = () => new Date()) {
  const runId = randomUUID();
  let result: Awaited<ReturnType<typeof ingestConsoleMetrics>> | undefined;
  let expected = 0; let verified = 0; let failed = false;
  try {
    result = await ingestConsoleMetrics(payload, now);
    const registry = await prisma.app.findMany({ select: { id: true, slug: true, aitMiniAppId: true } });
    for (const push of (payload as ConsoleMetricsPush).apps) {
      if (!push || !Array.isArray(push.days)) continue;
      expected += push.days.length;
      const appId = consolePushAppId(push, registry);
      const days = push.days.flatMap((day) => { const checked = validateConsoleDay(day); return checked.ok ? [checked.day] : []; });
      if (appId && push.miniAppId) verified += (await verifyStoredConsoleDays(appId, push.miniAppId, days, now)).verified;
    }
    failed = verified !== expected || result.errors.length > 0 || result.skipped.length > 0;
    return { ...result, verification: { expected, verified, mismatched: expected - verified } };
  } catch (error) { failed = true; throw error; }
  finally {
    await enqueueNotification(consoleReport({ runId, manual: true, failed, startedAt: now, now: clock(),
      dataState: failed ? "failed" : result?.warnings.length ? "partial" : "complete",
      lines: [`저장 ${result?.upserts ?? "미확인"}건, 저장 대조 ${verified}/${expected}건 일치`,
        `저장 오류 ${result?.errors.length ?? "미확인"}건, 저장 제외 ${result?.skipped.length ?? "미확인"}건`,
        `자료 제공 상태: ${result?.warnings.length ? "일부 값 미제공 또는 원본 확인 필요" : "이번 입력에서 미제공 경고 없음"}`,
        failed ? "조치: 저장 대조와 실행 오류를 확인하세요. 실패 전 저장 여부는 실행 기록을 확인합니다." : "제공된 값과 방금 저장한 행이 일치합니다. 미제공 지표를 0으로 바꾸지 않았습니다."] }));
    await recordConsoleIncident(failed, runId, clock());
  }
}
