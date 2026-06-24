import type { Lifecycle, AiDraftKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { notify, esc, type InlineButton } from "@/lib/telegram/client";
import { asStringArray } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { STAGE_KO } from "@/lib/domain/lifecycle";
import { miniMaxComplete } from "@/lib/ai/minimax";

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
    if (!m || !env.minimaxConfigured()) return;
    const app = await prisma.app.findUnique({
      where: { id: appId },
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

const DAY_MS = 24 * 60 * 60 * 1000;

// 데일리 다이제스트: 승인대기·P1·어제 활동·단계 분포 + AI 한 줄.
export async function sendDailyDigest(now: Date): Promise<void> {
  const yesterday = new Date(now.getTime() - DAY_MS);

  const [apps, openIssues, mergedPrs, releases] = await Promise.all([
    prisma.app.findMany({ select: { currentStage: true } }),
    prisma.issueMirror.findMany({
      where: { state: "OPEN" },
      orderBy: [{ priority: "asc" }],
      take: 300,
      select: { id: true, number: true, title: true, repoFullName: true, priority: true, labels: true },
    }),
    prisma.pullRequestMirror.count({ where: { state: "MERGED", mergedAt: { gte: yesterday } } }),
    prisma.releaseRecord.count({ where: { deployedAt: { gte: yesterday } } }),
  ]);

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
    `📦 어제 머지 PR ${mergedPrs} · 🚀 릴리스 ${releases}`,
    `📊 ${stageLine || "앱 없음"}`,
  ];

  // AI '오늘 볼 것' 한 줄(설정 시).
  if (env.minimaxConfigured()) {
    try {
      const summary = [
        `승인대기 ${pend.length}건: ${pend.slice(0, 5).map((i) => `${i.repoFullName.replace("seorilabs/", "")}#${i.number}`).join(", ") || "없음"}`,
        `P1 ${p1.length}건: ${p1.slice(0, 5).map((i) => `${i.repoFullName.replace("seorilabs/", "")}#${i.number} ${i.title}`).join("; ") || "없음"}`,
      ].join("\n");
      const oneLiner = await miniMaxComplete({
        system:
          "당신은 Seorilabs 공장 운영 비서다. 아래 현황에서 오늘 가장 먼저 처리하면 좋을 것 1가지를 한 문장(한국어)으로만 제안하라. 불필요한 인사·부연 없이 핵심만.",
        prompt: summary,
        temperature: 0.4,
        maxTokens: 200,
      });
      lines.push("", `💬 ${esc(oneLiner.trim())}`);
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

  await notify(lines.join("\n"), buttons.length ? buttons : undefined);
}

// 주간 LiveOps 리뷰: 운영 앱별 개선 가설 생성 버튼.
export async function sendWeeklyLiveopsReview(): Promise<void> {
  const apps = await prisma.app.findMany({
    where: { currentStage: "LIVEOPS" },
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
