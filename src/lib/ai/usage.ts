import { prisma } from "@/lib/prisma";
import { usageCostUsd } from "@/lib/ai/pricing";

// LLM 호출 사용량 원장 적재·집계. provider 클라이언트가 응답 usage 를 받은 직후
// fire-and-forget 으로 기록하며, 기록 실패가 본 호출을 실패시키지 않는다.

export interface AiUsageContext {
  path: string;
}

export interface AiUsageRecord extends AiUsageContext {
  provider: "gemini" | "anthropic" | "openai";
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  totalTokens?: number;
}

export async function recordAiUsage(record: AiUsageRecord): Promise<void> {
  try {
    await prisma.aiUsage.create({
      data: {
        provider: record.provider,
        model: record.model,
        path: record.path,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        thinkingTokens: record.thinkingTokens ?? 0,
        totalTokens:
          record.totalTokens ??
          record.inputTokens + record.outputTokens + (record.thinkingTokens ?? 0),
      },
    });
  } catch (error) {
    console.error("[ai-usage] 기록 실패", error instanceof Error ? error.message : error);
  }
}

export interface MonthlyAiUsage {
  totalUsd: number;
  /** 모델별 내역 — "gemini-3.1-flash-lite $0.12 (in 412k/out 88k)" 형식. */
  lines: string[];
  hasUnpricedModel: boolean;
}

/** KST 이번 달 1일 00:00 을 UTC Date 로. financeMonth 와 같은 KST 월 경계를 쓴다. */
export function kstMonthStart(now: Date): Date {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const month = kst.toISOString().slice(0, 7);
  return new Date(`${month}-01T00:00:00+09:00`);
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export async function monthlyAiUsageSummary(now: Date): Promise<MonthlyAiUsage> {
  const grouped = await prisma.aiUsage.groupBy({
    by: ["provider", "model"],
    where: { createdAt: { gte: kstMonthStart(now) } },
    _sum: { inputTokens: true, outputTokens: true, thinkingTokens: true },
  });
  let totalUsd = 0;
  let hasUnpricedModel = false;
  const lines: string[] = [];
  for (const row of grouped) {
    const input = row._sum.inputTokens ?? 0;
    const output = row._sum.outputTokens ?? 0;
    const thinking = row._sum.thinkingTokens ?? 0;
    const cost = usageCostUsd(row.model, input, output, thinking);
    if (cost == null) {
      hasUnpricedModel = true;
      lines.push(`${row.model} 단가 미등재 (in ${fmtTokens(input)}/out ${fmtTokens(output)})`);
      continue;
    }
    totalUsd += cost;
    lines.push(`${row.model} $${cost.toFixed(2)} (in ${fmtTokens(input)}/out ${fmtTokens(output + thinking)})`);
  }
  return { totalUsd, lines, hasUnpricedModel };
}
