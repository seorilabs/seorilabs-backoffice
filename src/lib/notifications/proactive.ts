import type { Lifecycle, AiDraftKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { asStringArray } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { STAGE_KO } from "@/lib/domain/lifecycle";
import {
  approvalIssueWhere,
  visibleAppWhere,
  visibleIssueWhere,
  visibleReleaseWhere,
} from "@/lib/domain/app-visibility";
import { geminiComplete } from "@/lib/ai/gemini";
import { getOrgDefaultBranches } from "@/lib/github/read";
import { discordDestinations } from "@/lib/notifications/destinations";
import { enqueueNotification } from "@/lib/notifications/outbox";
import {
  filterDefaultBranchMerges,
  formatMergedPrLines,
  mergedPrPromptLines,
  previousKstDayWindow,
  shouldUseDailyDigestGemini,
} from "@/lib/notifications/daily-digest";

const STAGE_NUDGE: Partial<Record<Lifecycle, { kind: AiDraftKind; emoji: string; suggest: string }>> = {
  QA: { kind: "QA_CHECKLIST", emoji: "🧪", suggest: "최근 이슈로 QA 테스트 체크리스트를 만들까요?" },
  MARKET_SUBMISSION: { kind: "STORE_COPY", emoji: "🏬", suggest: "마켓 등록 문안을 만들까요?" },
  RELEASE: { kind: "RELEASE_NOTES", emoji: "🚀", suggest: "릴리스 노트를 만들까요?" },
  LIVEOPS: { kind: "IMPROVEMENT_HYPOTHESIS", emoji: "💡", suggest: "개선 가설을 뽑아볼까요?" },
};

function button(label: string, customId: string) {
  return [{ type: 1, components: [{ type: 2, style: 1, label, custom_id: customId }] }];
}

export async function notifyStageNudge(appId: string, stage: Lifecycle): Promise<void> {
  try {
    const mapping = STAGE_NUDGE[stage];
    if (!mapping || !env.geminiChatConfigured()) return;
    const app = await prisma.app.findFirst({ where: { id: appId, ...visibleAppWhere }, select: { displayName: true } });
    if (!app) return;
    await enqueueNotification({
      dedupeKey: `stage-nudge:${appId}:${stage}:${new Date().toISOString().slice(0, 10)}`,
      kind: "OPS_ALERT",
      payload: {
        text: `${mapping.emoji} **${app.displayName}** · ${STAGE_KO[stage]} 단계 진입\n${mapping.suggest}`,
        components: button("초안 생성", `generate:${mapping.kind}:${appId}`),
      },
      destinations: discordDestinations(["backoffice"]),
    });
  } catch (error) {
    console.error("[nudge] stage error", error instanceof Error ? error.message : "error");
  }
}

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
  const [apps, openIssues, approvalCount, approvalIssues, mergedCandidates, releases, defaultBranches] = await Promise.all([
    prisma.app.findMany({ where: visibleAppWhere, select: { currentStage: true } }),
    prisma.issueMirror.findMany({
      where: { ...visibleIssueWhere, state: "OPEN" },
      orderBy: { priority: "asc" },
      take: 300,
      select: { id: true, number: true, title: true, repoFullName: true, priority: true, labels: true },
    }),
    prisma.issueMirror.count({ where: { ...approvalIssueWhere, state: "OPEN" } }),
    prisma.issueMirror.findMany({
      where: { ...approvalIssueWhere, state: "OPEN" },
      orderBy: [{ priority: "asc" }, { ghUpdatedAt: "desc" }],
      take: 5,
      select: { id: true, number: true, title: true, repoFullName: true, labels: true },
    }),
    prisma.pullRequestMirror.findMany({
      where: { app: { is: visibleAppWhere }, state: "MERGED", mergedAt: { gte: window.start, lt: window.end } },
      orderBy: [{ mergedAt: "asc" }, { repoFullName: "asc" }, { number: "asc" }],
      take: 300,
      select: { repoFullName: true, number: true, title: true, baseRef: true, mergedAt: true },
    }),
    prisma.releaseRecord.count({ where: { ...visibleReleaseWhere, deployedAt: { gte: window.start, lt: window.end } } }),
    getOrgDefaultBranches(),
  ]);
  const { mergedPrs, unresolvedCount } = filterDefaultBranchMerges(mergedCandidates, defaultBranches);
  const p1 = openIssues.filter((issue) => issue.priority === "P1");
  const stageCounts: Record<string, number> = {};
  for (const app of apps) stageCounts[app.currentStage] = (stageCounts[app.currentStage] ?? 0) + 1;
  const lines = [
    "**☀️ 오늘의 공장 다이제스트**",
    `📋 승인 대기 **${approvalCount}** · 🔥 열린 P1 **${p1.length}**`,
    `📦 전일 default branch 병합 **${mergedPrs.length}** · 🚀 릴리스 **${releases}**`,
    `📊 ${Object.entries(stageCounts).map(([stage, count]) => `${STAGE_KO[stage as Lifecycle]} ${count}`).join(" · ") || "앱 없음"}`,
    "",
    `**${window.label} 병합 변경사항**`,
    ...formatMergedPrLines(mergedPrs),
  ];
  if (unresolvedCount) lines.push(`• ⚠️ default branch 확인 실패로 제외 ${unresolvedCount}건`);
  let geminiUsed = false;
  if (mergedPrs.length && env.geminiChatConfigured() && shouldUseDailyDigestGemini(window.label, env.dailyDigestGeminiRolloutPercent())) {
    try {
      const summary = await geminiComplete({
        system: "제공된 PR 제목만 근거로 전일 변경의 핵심과 오늘 먼저 볼 운영 항목을 한국어 한 문장으로 요약하라. 추정하지 않는다.",
        prompt: [`승인대기 ${approvalCount}건`, `P1 ${p1.length}건`, ...mergedPrPromptLines(mergedPrs)].join("\n"),
        maxTokens: 240,
        usage: { path: "proactive" },
      });
      lines.push("", `💬 **AI 요약** ${summary.trim()}`);
      geminiUsed = true;
    } catch {
      // 확정 목록은 AI 실패와 무관하게 큐에 넣는다.
    }
  }
  const components = approvalIssues.map((issue) => {
    const gate = hasApproval(asStringArray(issue.labels), "release") ? "release" : "planning";
    return { type: 1, components: [{ type: 2, style: 3, label: `${issue.repoFullName.replace("seorilabs/", "")} #${issue.number} 승인`.slice(0, 80), custom_id: `approval:${gate}:${issue.id}` }] };
  });
  await enqueueNotification({
    dedupeKey: `daily-digest:${window.label}`,
    kind: "OPERATIONS_SUMMARY",
    payload: { text: lines.join("\n"), ...(components.length ? { components } : {}) },
    destinations: discordDestinations(["backoffice"]),
  });
  return { date: window.label, mergedPrCount: mergedPrs.length, releaseCount: releases, unresolvedDefaultBranchCount: unresolvedCount, geminiUsed, queued: true };
}

export async function sendWeeklyLiveopsReview(now = new Date()): Promise<void> {
  const apps = await prisma.app.findMany({
    where: { ...visibleAppWhere, currentStage: "LIVEOPS" },
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true },
    take: 25,
  });
  const components = apps.slice(0, 5).map((app) => ({
    type: 1,
    components: [{ type: 2, style: 1, label: `💡 ${app.displayName}`.slice(0, 80), custom_id: `generate:IMPROVEMENT_HYPOTHESIS:${app.id}` }],
  }));
  await enqueueNotification({
    dedupeKey: `weekly-liveops:${now.toISOString().slice(0, 10)}`,
    kind: "OPERATIONS_SUMMARY",
    payload: {
      text: apps.length ? `**📈 주간 LiveOps 리뷰**\n운영 앱 ${apps.length}개. 버튼을 누르면 개선 가설 초안을 만듭니다.` : "**📈 주간 LiveOps 리뷰**\n운영 단계 앱이 없습니다.",
      ...(components.length ? { components } : {}),
    },
    destinations: discordDestinations(["backoffice"]),
  });
}
