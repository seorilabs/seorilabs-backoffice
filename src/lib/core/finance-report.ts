import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { discordDestinations } from "@/lib/notifications/destinations";
import {
  enqueueNotification,
  retryDeadLetterNotification,
} from "@/lib/notifications/outbox";
import {
  collectFinanceCosts,
  financeMonth,
  type CostWarning,
  type FinanceCostFigures,
} from "@/lib/core/finance-costs";
import { orgReportUrl } from "@/lib/core/org-report-link";
import { SEORI_SENDER } from "@/lib/notifications/sender";
import { EMBED_COLOR } from "@/lib/notifications/style";

// 서리 일일 재무 리포트. 종량제 4소스(GitHub Actions·GCP·LLM·Stability)의 이번 달
// 현황과 임계 경고를 통합 운영 채널에 남긴다. 전부 결정적 수치라 LLM 을 쓰지 않는다.

const SENDER_KO = "서리";

/** KST 월별 판정 키. 중요한 단계 변화마다 별도 보고를 만든다. */
export function financeReportDedupeKey(now = new Date()): string {
  return `finance-warning:${financeMonth(now).month}`;
}

export function renderFinanceReport(input: {
  month: string;
  summaryLines: readonly string[];
  warnings: readonly CostWarning[];
  /** 백오피스 Org 종합 보고서 링크(선택). 없으면 푸터를 생략한다. */
  link?: string | null;
}): string {
  const lines = [
    `💰 **${SENDER_KO} 재무 리포트 · ${input.month}**`,
    ...input.summaryLines,
  ];
  if (input.warnings.length === 0) {
    lines.push("", "경고 없음");
  } else {
    lines.push("", `⚠️ 경고 ${input.warnings.length}건`);
    input.warnings.forEach((item, index) => {
      lines.push("", `**${index + 1}. ${item.title}**`, item.detail);
      for (const evidence of item.evidence) lines.push(`- ${evidence}`);
    });
  }
  if (input.link) lines.push("", `🔗 ${input.link}`);
  return lines.join("\n");
}

export interface FinanceReportResult {
  month: string;
  warnings: number;
  dedupeKey: string;
}

export function costWarningSource(
  key: string,
): keyof FinanceCostFigures | null {
  if (key.startsWith("gh-")) return "github";
  if (key.startsWith("gcp-")) return "gcp";
  if (key.startsWith("llm-")) return "llm";
  if (key.startsWith("stability-")) return "stability";
  return null;
}
/** 조회 불가를 해소로 해석하지 않고, 실제로 확인한 단계 변화만 고른다. */
export function costWarningTransition(
  previous: CostWarning[],
  current: CostWarning[],
  figures: FinanceCostFigures,
) {
  const retained = previous.filter((w) => {
    const source = costWarningSource(w.key);
    return source !== null && figures[source] === null;
  });
  const warnings = [
    ...current,
    ...retained.filter((w) => !current.some((c) => c.key === w.key)),
  ];
  return {
    warnings,
    changed: warnings.filter((w) => !previous.some((p) => p.key === w.key)),
    resolved: previous.filter((w) => !warnings.some((c) => c.key === w.key)),
  };
}
function storedWarnings(value: unknown): CostWarning[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (w): w is CostWarning =>
      w &&
      typeof w === "object" &&
      typeof w.key === "string" &&
      typeof w.title === "string" &&
      typeof w.detail === "string" &&
      Array.isArray(w.evidence) &&
      w.evidence.every((v: unknown) => typeof v === "string"),
  );
}
/** 새 경고 단계는 새 보고로, 같은 단계는 내부 원장에만 남긴다. */
export async function sendFinanceReport(
  now = new Date(),
): Promise<FinanceReportResult> {
  const { month } = financeMonth(now);
  const collection = await import("@/lib/insights/collection");
  const run = await collection.beginCollection("finance-costs", month);
  const snapshot = await collectFinanceCosts(now);
  const { warnings, figures } = snapshot;
  await collection.completeCollection(run.id, { status: Object.values(figures).every((value) => value !== null) ? "observed" : Object.values(figures).some((value) => value !== null) ? "partial" : "needs_input", dataThrough: now, coverage: JSON.parse(JSON.stringify({ month, ...snapshot, collectedAt: now.toISOString() })) });
  const baseKey = financeReportDedupeKey(now);
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const state = await tx.notificationEvent.findUnique({
            where: { dedupeKey: `finance-state:${month}` },
            select: { payload: true },
          });
          const before = state?.payload as
            | {
                warningItems?: unknown;
                sequence?: number;
                lastEventId?: string;
                lastDedupeKey?: string;
              }
            | undefined;
          const change = costWarningTransition(
            storedWarnings(before?.warningItems),
            warnings,
            figures,
          );
          if (!change.changed.length && !change.resolved.length) {
            if (before?.lastEventId)
              await retryDeadLetterNotification(before.lastEventId, tx);
            return {
              month,
              warnings: change.warnings.length,
              dedupeKey: before?.lastDedupeKey ?? baseKey,
            };
          }
          const sequence =
            (Number.isSafeInteger(before?.sequence) ? before!.sequence! : 0) +
            1;
          const dedupeKey = `${baseKey}:${sequence}`;
          const headline =
            change.changed[0]?.title ?? "확인된 비용 경고가 해소됐습니다";
          const resolvedLines = change.resolved
            .filter(
              (old) =>
                !change.changed.some(
                  (w) =>
                    costWarningSource(w.key) === costWarningSource(old.key),
                ),
            )
            .map((w) => `- 해소: ${w.title}`);
          const eventId = await enqueueNotification(
            {
              dedupeKey,
              kind: "OPS_ALERT",
              occurredAt: now,
              payload: {
                text: renderFinanceReport({
                  month,
                  summaryLines: [
                    `**${headline}**`,
                    ...change.changed.flatMap((w) => {
                      const old = storedWarnings(before?.warningItems).find(
                        (p) =>
                          costWarningSource(p.key) === costWarningSource(w.key),
                      );
                      return old
                        ? [`이전 보고 ${old.title} → 현재 ${w.title}`]
                        : [];
                    }),
                    ...resolvedLines,
                  ],
                  warnings: change.changed,
                  link: orgReportUrl(),
                }),
                sender: SEORI_SENDER,
                report: {
                  category: "change",
                  reason: change.changed.length
                    ? "COST_WARNING_STAGE_CHANGED"
                    : "COST_WARNING_RESOLVED",
                },
                embed: {
                  color: change.changed.length
                    ? EMBED_COLOR.WARNING
                    : EMBED_COLOR.SUCCESS,
                  timestamp: now.toISOString(),
                },
              },
              destinations: discordDestinations(["app-ops"]),
            },
            tx,
          );
          await enqueueNotification(
            {
              dedupeKey: `finance-state:${month}`,
              kind: "OPS_ALERT",
              occurredAt: now,
              payload: {
                report: { category: "internal", reason: "COST_WARNING_STATE" },
                warningItems: change.warnings.map((w) => ({
                  key: w.key,
                  title: w.title,
                  detail: w.detail,
                  evidence: w.evidence,
                })),
                sequence,
                lastEventId: eventId,
                lastDedupeKey: dedupeKey,
              },
              destinations: [],
            },
            tx,
          );
          return { month, warnings: change.warnings.length, dedupeKey };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        attempt >= 3 ||
        !["P2034", "P2002"].includes((error as { code?: string }).code ?? "")
      )
        throw error;
    }
  }
}
