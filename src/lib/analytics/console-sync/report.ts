import { recordCollectionIssue } from "@/lib/notifications/collection-issues";
import { notificationDestinations } from "@/lib/notifications/destinations";
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
    destinations: notificationDestinations([]),
    payload: {
      report: { category: input.failed ? "response" : "internal", reason: input.failed ? "COLLECTION_FAILURE" : "COLLECTION_SUCCESS_LEDGER" },
      text: [`${input.manual ? "수동 수집 " : ""}시작 ${kstTime(input.startedAt ?? input.now)}`, `종료 ${kstTime(input.now)} (한국 시간)`, ...input.lines].join("\n"),
      source: "ait_console", runId: input.runId, manual: input.manual === true, state: input.dataState,
      executionStatus: input.skipped ? "skipped" : input.failed ? "failed" : "succeeded",
      embed: { title: `${input.skipped ? "⏸" : input.failed ? "❌" : "✅"} 앱인토스 지표 수집 ${input.skipped ? "보류" : input.failed ? "실패" : "성공"}`,
        timestamp: input.now.toISOString(), color: input.skipped ? EMBED_COLOR.NEUTRAL : input.failed ? EMBED_COLOR.FAILURE : EMBED_COLOR.SUCCESS },
    },
  };
}


export async function publishConsoleReport(report: ReturnType<typeof consoleReport>):Promise<string> {
 const p=report.payload;
 const issue=await recordCollectionIssue({job:p.manual ? "backoffice-ait-console-manual" : "backoffice-ait-console-metrics",runId:p.runId,at:report.occurredAt,failed:p.executionStatus === "failed",skipped:p.executionStatus === "skipped",target:"앱인토스 지표",items:p.text.split("\n").filter(line=>/실패 항목:|원인:|대상:|확인 필요|미제공/.test(line)),period:p.text.split("\n").find(line=>line.startsWith("기준 기간:"))??"이번 요청 기간",cause:p.text.split("\n").filter(line=>/원인:|실패 항목:/.test(line)).join("; ")||"저장 대조 또는 수집 실패",action:"수집 기록에서 실패한 항목과 운영 연결을 확인하세요."});
 return issue?.id ?? "";
}

export function consoleVerificationLine(verified: number, expected: number): string {
  if (!expected) return "저장 대조: 제공된 검증 대상 없음";
  return verified === expected ? `저장 대조 ${verified}/${expected}건 일치`
    : `저장 대조: 일치 ${verified}건, 확인 필요 ${Math.max(0, expected - verified)}건 (대상 ${expected}건)`;
}
