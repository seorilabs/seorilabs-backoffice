import type { Lifecycle, AiDraftKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  notify,
  esc,
  telegramResponseOk,
  type InlineButton,
} from "@/lib/telegram/client";
import { asStringArray } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { STAGE_KO } from "@/lib/domain/lifecycle";
import { visibleAppWhere, visibleIssueWhere, visibleReleaseWhere } from "@/lib/domain/app-visibility";
import { geminiComplete } from "@/lib/ai/gemini";
import { getOrgDefaultBranches } from "@/lib/github/read";
import {
  filterDefaultBranchMerges,
  formatMergedPrLines,
  mergedPrPromptLines,
  previousKstDayWindow,
  shouldUseDailyDigestGemini,
} from "@/lib/telegram/daily-digest";

// 단계 진입 시 다음 단계 에이전트를 제안하는 넛지 매핑.
const STAGE_NUDGE: Partial<
  Record<Lifecycle, { kind: AiDraftKind; emoji: string; label: string; suggest: string }>
> = {
  QA: { kind: "QA_CHECKLIST", emoji: "🧪", label: "🧪 QA 체크리스트 생성", suggest: "최근 이슈로 QA 테스트 체크리스트를 만들까요?" },
  MARKET_SUBMISSION: { kind: "STORE_COPY", emoji: "🏬", label: "🏬 스토어 문안 생성", suggest: "마켓 등록 문안을 만들까요?" },
  RELEASE: { kind: "RELEASE_NOTES", emoji: "🚀", label: "🚀 릴리스 노트 생성", suggest: "릴리스 노트를 만들까요?" },
  LIVEOPS: { kind: "IMPROVEMENT_HYPOTHESIS", emoji: "💡", label: "💡 개선 가설 생성", suggest: "개선 가설을 뽑아볼까요?" },
};

// 단계 전이 시(수동/자동) 다음 단계 에이전트 제안. 실패 무시.
export async function notifyStageNudge(appId: string, stage: Lifecycle): Promise<void> {
  try {
    const m = STAGE_NUDGE[stage];
    if (!m || !env.geminiChatConfigured()) return;
    const app = await prisma.app.findFirst({
      where: { id: appId, ...visibleAppWhere },
      select: { displayName: true },
    });
    if (!app) return;
    await notify(
      `${m.emoji} <b>${esc(app.displayName)}</b> — ${STAGE_KO[stage]} 단계 진입\n${m.suggest}`,
      [[{ text: m.label, callback_data: `gen:${m.kind}:${appId}` }]],
    );
  } catch (e) {
    console.error("[nudge] stage error:", e instanceof Error ? e.message : e);
  }
}

export interface DailyDigestResult {
  date: string;
  mergedPrCount: number;
  releaseCount: number;
  unresolvedDefaultBranchCount: number;
  geminiUsed: boolean;
  telegramSent: true;
}

// 데일리 다이제스트: 승인대기·P1·전일 default branch 병합·단계 분포 + 저비율 AI 한 줄.
export async function sendDailyDigest(now: Date): Promise<DailyDigestResult> {
  const window = previousKstDayWindow(now);

  const [apps, openIssues, mergedPrCandidates, releases, defaultBranches] = await Promise.all([
    prisma.app.findMany({ where: visibleAppWhere, select: { currentStage: true } }),
    prisma.issueMirror.findMany({
      where: { ...visibleIssueWhere, state: "OPEN" },
      orderBy: [{ priority: "asc" }],
      take: 300,
      select: { id: true, number: true, title: true, repoFullName: true, priority: true, labels: true },
    }),
    prisma.pullRequestMirror.findMany({
      where: {
        app: { is: visibleAppWhere },
        state: "MERGED",
        mergedAt: { gte: window.start, lt: window.end },
      },
      orderBy: [{ mergedAt: "asc" }, { repoFullName: "asc" }, { number: "asc" }],
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
    mergedPrCandidates,
    defaultBranches,
  );

  const pend = openIssues.filter((i) => {
    const l = asStringArray(i.labels);
    return hasApproval(l, "planning") || hasApproval(l, "release");
  });
  const p1 = openIssues.filter((i) => i.priority === "P1");

  const stageCounts: Record<string, number> = {};
  for (const a of apps) stageCounts[a.currentStage] = (stageCounts[a.currentStage] ?? 0) + 1;
  const stageLine = Object.entries(stageCounts)
    .map(([s, n]) => `${STAGE_KO[s as Lifecycle]} ${n}`)
    .join(" · ");

  const lines = [
    `<b>☀️ 오늘의 공장 다이제스트</b>`,
    "",
    `📋 승인 대기 <b>${pend.length}</b> · 🔥 열린 P1 <b>${p1.length}</b>`,
    `📦 전일 default branch 병합 <b>${mergedPrs.length}</b> · 🚀 릴리스 <b>${releases}</b>`,
    `📊 ${stageLine || "앱 없음"}`,
    "",
    `🧾 <b>${window.label} 병합 변경사항</b>`,
    ...formatMergedPrLines(mergedPrs),
  ];
  if (unresolvedCount > 0) {
    lines.push(`• ⚠️ default branch 확인 실패로 제외 ${unresolvedCount}건`);
  }

  // 확정적 목록은 항상 발송한다. Gemini는 날짜별 고정 저비율 샘플에서만 한 번 호출한다.
  let geminiUsed = false;
  if (
    mergedPrs.length > 0 &&
    env.geminiChatConfigured() &&
    shouldUseDailyDigestGemini(
      window.label,
      env.dailyDigestGeminiRolloutPercent(),
    )
  ) {
    try {
      const summary = [
        `승인대기 ${pend.length}건: ${pend.slice(0, 5).map((i) => `${i.repoFullName.replace("seorilabs/", "")}#${i.number}`).join(", ") || "없음"}`,
        `P1 ${p1.length}건: ${p1.slice(0, 5).map((i) => `${i.repoFullName.replace("seorilabs/", "")}#${i.number} ${i.title}`).join("; ") || "없음"}`,
        `${window.label} default branch 병합 ${mergedPrs.length}건:`,
        ...mergedPrPromptLines(mergedPrs),
      ].join("\n");
      const oneLiner = await geminiComplete({
        system:
          "당신은 Seorilabs 공장 운영 비서다. 제공된 PR 제목만 근거로 전일 변경의 핵심과 오늘 먼저 볼 운영 항목을 한국어 한 문장으로 요약하라. 제목에 없는 효과나 사실은 추정하지 말고 인사·부연은 쓰지 않는다.",
        prompt: summary,
        maxTokens: 240,
      });
      lines.push("", `💬 <b>AI 요약</b> ${esc(oneLiner.trim())}`);
      geminiUsed = true;
    } catch {
      // AI 실패는 무시
    }
  }

  // 승인 대기 상위 5건은 바로 승인 버튼으로.
  const buttons: InlineButton[][] = pend.slice(0, 5).map((i) => {
    const gate = hasApproval(asStringArray(i.labels), "release") ? "release" : "planning";
    return [
      {
        text: `승인 ${i.repoFullName.replace("seorilabs/", "")} #${i.number}`,
        callback_data: `approve:${gate}:${i.id}`,
      },
    ];
  });

  const telegramResponse = await notify(
    lines.join("\n"),
    buttons.length ? buttons : undefined,
  );
  if (!telegramResponseOk(telegramResponse)) {
    throw new Error("일일 다이제스트 Telegram 발송 실패");
  }
  return {
    date: window.label,
    mergedPrCount: mergedPrs.length,
    releaseCount: releases,
    unresolvedDefaultBranchCount: unresolvedCount,
    geminiUsed,
    telegramSent: true,
  };
}

// 주간 LiveOps 리뷰: 운영 앱별 개선 가설 생성 버튼.
export async function sendWeeklyLiveopsReview(): Promise<void> {
  const apps = await prisma.app.findMany({
    where: { ...visibleAppWhere, currentStage: "LIVEOPS" },
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true },
  });
  if (apps.length === 0) {
    await notify("📈 <b>주간 LiveOps 리뷰</b>\n운영(LIVEOPS) 단계 앱이 없습니다.");
    return;
  }
  const buttons: InlineButton[][] = apps.map((a) => [
    { text: `💡 ${a.displayName}`, callback_data: `gen:IMPROVEMENT_HYPOTHESIS:${a.id}` },
  ]);
  await notify(
    `📈 <b>주간 LiveOps 리뷰</b>\n운영 앱 ${apps.length}개. 버튼을 누르면 개선 가설 초안을 만듭니다.`,
    buttons,
  );
}
