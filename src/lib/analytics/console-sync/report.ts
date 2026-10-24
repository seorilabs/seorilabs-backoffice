import { recordIncident, recoverIncident } from "@/lib/notifications/incidents";
import { discordDestinations } from "@/lib/notifications/destinations";
import { EMBED_COLOR } from "@/lib/notifications/style";

export const kstTime = (date: Date) => new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(date);

export function consoleReport(input: {
  runId: string; now: Date; failed: boolean; dataState: string; lines: string[]; manual?: boolean; startedAt?: Date; skipped?: boolean;
}) {
  return {
    dedupeKey: `ait-console-${input.manual ? "push" : "collection"}:${input.runId}`,
    kind: "OPERATIONAL_EVENT" as const,
    occurredAt: input.now,
    destinations: discordDestinations(["batch-monitoring"]),
    payload: {
      report: { category: "response", reason: "USER_REQUESTED_COLLECTION_RESULT" },
      text: [`${input.manual ? "수동 수집 " : ""}시작 ${kstTime(input.startedAt ?? input.now)}`, `종료 ${kstTime(input.now)} (한국 시간)`, ...input.lines].join("\n"),
      source: "ait_console", runId: input.runId, state: input.dataState,
      executionStatus: input.skipped ? "skipped" : input.failed ? "failed" : "succeeded",
      embed: { title: `${input.skipped ? "⏸" : input.failed ? "❌" : "✅"} 앱인토스 지표 수집 ${input.skipped ? "보류" : input.failed ? "실패" : "성공"}`,
        timestamp: input.now.toISOString(), color: input.skipped ? EMBED_COLOR.NEUTRAL : input.failed ? EMBED_COLOR.FAILURE : EMBED_COLOR.SUCCESS },
    },
  };
}


export async function recordConsoleIncident(failed: boolean, runId: string, now: Date, jobUid?: string) {
  const key = jobUid
    ? { source: "scheduled-batch", kind: "k8s:platform:backoffice-ait-console-metrics", signalId: `batch:k8s:${jobUid}` }
    : { source: "ait-console-manual", kind: "collection", signalId: runId };
  if (failed) await recordIncident({ ...key, severity: "warning", detectedAt: now, summary: "앱인토스 지표 수집 실패",
    evidence: { impact: "수집 작업의 일부 또는 전체를 완료하지 못했습니다.", action: "배치모니터링의 실패 단계와 수집 기록을 확인하세요." } });
  else await recoverIncident({ ...key, recoveredAt: now });
}
