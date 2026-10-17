import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  approvalIssueWhere,
  visibleAppWhere,
  visibleIssueWhere,
  visibleReleaseWhere,
} from "@/lib/domain/app-visibility";
import { llmChatConfigured } from "@/lib/ai/llm";
import { getOrgDefaultBranches } from "@/lib/github/read";
import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import {
  filterDefaultBranchMerges,
  formatMergedPrLines,
  previousKstDayWindow,
  shouldUseDailyDigestGemini,
} from "@/lib/notifications/daily-digest";
import { generateInsight } from "@/lib/insights/generate";
import { renderInsight } from "@/lib/insights/contract";
import { EMBED_COLOR } from "@/lib/notifications/style";

export interface DailyDigestResult {
  date: string;
  mergedPrCount: number;
  releaseCount: number;
  unresolvedDefaultBranchCount: number;
  geminiUsed: boolean;
  queued: true;
}

export async function sendDailyDigest(now: Date): Promise<DailyDigestResult> {
  const window = previousKstDayWindow(now);
  const [
    openIssues,
    approvalCount,
    mergedCandidates,
    releases,
    defaultBranches,
  ] = await Promise.all([
    prisma.issueMirror.findMany({
      where: { ...visibleIssueWhere, state: "OPEN" },
      orderBy: { priority: "asc" },
      take: 300,
      select: {
        id: true,
        number: true,
        title: true,
        repoFullName: true,
        priority: true,
        labels: true,
        ghUpdatedAt: true,
      },
    }),
    prisma.issueMirror.count({
      where: { ...approvalIssueWhere, state: "OPEN" },
    }),
    prisma.pullRequestMirror.findMany({
      where: {
        app: { is: visibleAppWhere },
        state: "MERGED",
        mergedAt: { gte: window.start, lt: window.end },
      },
      orderBy: [
        { mergedAt: "asc" },
        { repoFullName: "asc" },
        { number: "asc" },
      ],
      take: 300,
      select: {
        repoFullName: true,
        number: true,
        title: true,
        baseRef: true,
        mergedAt: true,
      },
    }),
    prisma.releaseRecord.count({
      where: {
        ...visibleReleaseWhere,
        deployedAt: { gte: window.start, lt: window.end },
      },
    }),
    getOrgDefaultBranches(),
  ]);
  const { mergedPrs, unresolvedCount } = filterDefaultBranchMerges(
    mergedCandidates,
    defaultBranches,
  );
  const p1 = openIssues.filter(
    (issue) =>
      issue.priority === "P1" &&
      issue.ghUpdatedAt >= window.start &&
      issue.ghUpdatedAt < window.end,
  );
  const lines = [
    `**${window.label} 개발 변경과 필요한 결정**`,
    ...(approvalCount
      ? [
          `승인 대기 ${approvalCount}건 · 대상은 운영명령의 기존 승인 카드에서 확인할 수 있습니다.`,
        ]
      : []),
    ...p1
      .slice(0, 5)
      .map(
        (issue) =>
          `- **${issue.repoFullName.replace("seorilabs/", "")}** · 우선 처리: ${issue.title}`,
      ),
    ...(mergedPrs.length
      ? ["", "**앱별 반영한 변경**", ...formatMergedPrLines(mergedPrs)]
      : []),
  ];
  if (unresolvedCount)
    lines.push(
      "기본 브랜치를 확인한 저장소의 변경만 표시합니다. 전체 개발 변경은 상세 화면에서 확인하세요.",
    );
  let geminiUsed = false;
  if (
    mergedPrs.length &&
    llmChatConfigured() &&
    shouldUseDailyDigestGemini(
      window.label,
      env.dailyDigestGeminiRolloutPercent(),
    )
  ) {
    try {
      const facts = [
        {
          id: "approvals",
          label: "승인 대기",
          value: approvalCount + "건",
          source: window.label + " 운영 원장",
        },
        {
          id: "priority",
          label: "어제 갱신된 P1",
          value: p1.length + "건",
          source: "GitHub 미러",
        },
        ...mergedPrs.slice(0, 10).map((pr, i) => ({
          id: `merge_${i}`,
          label: pr.repoFullName.replace("seorilabs/", "").slice(0, 100),
          value: pr.title.slice(0, 160),
          source: window.label + " GitHub 기본 브랜치 병합",
        })),
      ];
      const summary = await generateInsight(facts, "operations");
      if (!summary.fallback) {
        lines.push(
          "",
          renderInsight(
            {
              ...summary.content,
              bullets: summary.content.bullets.filter((b) => b.kind !== "fact"),
            },
            facts,
          ),
        );
        geminiUsed = true;
      }
    } catch {
      // 확정 목록은 AI 실패와 무관하게 큐에 넣는다.
    }
  }
  await enqueueNotification({
    dedupeKey: `daily-digest:${window.label}`,
    kind: "OPERATIONS_SUMMARY",
    payload: {
      text: lines.join("\n"),
      report: {
        category: p1.length || mergedPrs.length ? "change" : "internal",
        reason: "DEVELOPMENT_CHANGE_OR_DECISION",
      },
      embed: { color: EMBED_COLOR.INFO },
    },
    destinations: discordDestinations(["backoffice"]),
  });
  return {
    date: window.label,
    mergedPrCount: mergedPrs.length,
    releaseCount: releases,
    unresolvedDefaultBranchCount: unresolvedCount,
    geminiUsed,
    queued: true,
  };
}

export async function sendWeeklyLiveopsReview(now = new Date()): Promise<void> {
  const { publishWeeklySignals } = await import("@/lib/insights/triggers");
  await publishWeeklySignals(now);
}
