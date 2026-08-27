import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { collectFinanceCosts, financeMonth, type CostWarning } from "@/lib/core/finance-costs";
import { SEORI_SENDER } from "@/lib/notifications/sender";

// 서리 일일 재무 리포트. 종량제 4소스(GitHub Actions·GCP·LLM·Stability)의 이번 달
// 현황과 임계 경고를 통합 운영 채널에 남긴다. 전부 결정적 수치라 LLM 을 쓰지 않는다.

const SENDER_KO = "서리";

/** KST 날짜 기준 하루 1건. CronJob 중복 발화가 리포트를 두 번 올리지 않는다. */
export function financeReportDedupeKey(now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  return `finance:${kst.toISOString().slice(0, 10)}`;
}

export function renderFinanceReport(input: {
  month: string;
  summaryLines: readonly string[];
  warnings: readonly CostWarning[];
}): string {
  const lines = [`💰 **${SENDER_KO} 재무 리포트 · ${input.month}**`, ...input.summaryLines];
  if (input.warnings.length === 0) {
    lines.push("", "경고 없음");
    return lines.join("\n");
  }
  lines.push("", `⚠️ 경고 ${input.warnings.length}건`);
  input.warnings.forEach((item, index) => {
    lines.push("", `**${index + 1}. ${item.title}**`, item.detail);
    for (const evidence of item.evidence) lines.push(`- ${evidence}`);
  });
  return lines.join("\n");
}

export interface FinanceReportResult {
  month: string;
  warnings: number;
  dedupeKey: string;
}

/** 비용 수집 → 리포트 렌더 → 알림 outbox. 전달은 notification worker 가 한다. */
export async function sendFinanceReport(now = new Date()): Promise<FinanceReportResult> {
  const { month } = financeMonth(now);
  const { warnings, summaryLines } = await collectFinanceCosts(now);
  const dedupeKey = financeReportDedupeKey(now);
  await enqueueNotification({
    dedupeKey,
    kind: "OPS_ALERT",
    occurredAt: now,
    payload: {
      text: renderFinanceReport({ month, summaryLines, warnings }),
      // 메인 봇이 아니라 서리 정체로 게시한다. 토큰 값은 payload 에 담지 않는다.
      sender: SEORI_SENDER,
    },
    destinations: discordDestinations(["app-ops"]),
  });
  return { month, warnings: warnings.length, dedupeKey };
}
