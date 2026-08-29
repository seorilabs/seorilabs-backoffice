import { prisma } from "@/lib/prisma";
import { STAGE_KO } from "@/lib/domain/lifecycle";
import { visibleAppWhere, visibleIssueWhere } from "@/lib/domain/app-visibility";
import { asStringArray } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { GeminiNotConfiguredError, type ChatMessage } from "@/lib/ai/gemini";
import { runChatAgent } from "@/lib/ai/chat-agent";

const HISTORY_TURNS = 10;
const RETAIN_TURNS = 40;

export async function factorySnapshot(): Promise<string> {
  const apps = await prisma.app.findMany({ where: visibleAppWhere, select: { currentStage: true } });
  const byStage: Record<string, number> = {};
  for (const app of apps) byStage[app.currentStage] = (byStage[app.currentStage] ?? 0) + 1;
  const stageLine = Object.entries(byStage)
    .map(([stage, count]) => `${STAGE_KO[stage as keyof typeof STAGE_KO] ?? stage} ${count}`)
    .join(", ");
  const [p1, openIssues] = await Promise.all([
    prisma.issueMirror.count({ where: { ...visibleIssueWhere, state: "OPEN", priority: "P1" } }),
    prisma.issueMirror.findMany({
      where: { ...visibleIssueWhere, state: "OPEN" },
      select: { labels: true },
      take: 300,
    }),
  ]);
  const approvals = openIssues.filter((issue) => {
    const labels = asStringArray(issue.labels);
    return hasApproval(labels, "planning") || hasApproval(labels, "release");
  }).length;
  return `앱/게임 총 ${apps.length}개 (단계: ${stageLine || "없음"})\n열린 P1 ${p1}건, 승인 대기 ${approvals}건`;
}

function systemPrompt(snapshot: string): string {
  return [
    "당신은 Seorilabs 앱 제작 공장의 Discord 백오피스 비서다.",
    "한국어로 결론부터 간결하게 답하고, 실제 데이터와 Obsidian 지식 볼트를 근거로 사용한다.",
    "추측을 사실처럼 말하지 않는다. 직접 GitHub 쓰기나 배포를 하지 않고 필요한 Discord 명령을 안내한다.",
    "출력은 Discord Markdown, 4000자 이내다.",
    "",
    "## 현재 공장 현황",
    snapshot,
  ].join("\n");
}

export async function previewDiscordChat(userText: string): Promise<string> {
  return runChatAgent([
    { role: "system", content: systemPrompt(await factorySnapshot()) },
    { role: "user", content: userText },
  ]);
}

// 대화는 메인 봇 /ask 하나뿐이다. discord_turn.teammate 컬럼은 contract 단계에서
// 제거될 때까지 남으므로 키에 null 을 명시해 기존 행·복합 인덱스와 계속 맞춘다.
export function discordTurnKey(input: {
  guildId: string;
  channelId: string;
  userId: string;
}) {
  return {
    guildId: input.guildId,
    channelId: input.channelId,
    userId: input.userId,
    teammate: null,
  };
}

export type DiscordTurnKey = ReturnType<typeof discordTurnKey>;

export async function loadDiscordHistory(key: DiscordTurnKey): Promise<ChatMessage[]> {
  const recent = await prisma.discordTurn.findMany({
    where: key,
    orderBy: { createdAt: "desc" },
    take: HISTORY_TURNS,
  });
  return recent.reverse().map((turn) => ({
    role: turn.role === "assistant" ? "assistant" : "user",
    content: turn.content,
  }));
}

export async function appendDiscordTurns(key: DiscordTurnKey, userText: string, reply: string): Promise<void> {
  await prisma.discordTurn.createMany({
    data: [
      { ...key, role: "user", content: userText },
      { ...key, role: "assistant", content: reply },
    ],
  });
  const stale = await prisma.discordTurn.findMany({
    where: key,
    orderBy: { createdAt: "desc" },
    select: { id: true },
    skip: RETAIN_TURNS,
  });
  if (stale.length) await prisma.discordTurn.deleteMany({ where: { id: { in: stale.map(({ id }) => id) } } });
}

export async function resetDiscordChat(input: { guildId: string; channelId: string; userId: string }) {
  await prisma.discordTurn.deleteMany({ where: discordTurnKey(input) });
}

export async function handleDiscordChat(input: {
  guildId: string;
  channelId: string;
  userId: string;
  text: string;
}): Promise<string> {
  const key = discordTurnKey(input);
  const history = await loadDiscordHistory(key);
  let reply: string;
  try {
    reply = await runChatAgent([
      { role: "system", content: systemPrompt(await factorySnapshot()) },
      ...history,
      { role: "user", content: input.text },
    ]);
  } catch (error) {
    if (error instanceof GeminiNotConfiguredError) return "AI 채팅이 비활성 상태입니다.";
    console.error("[discord] chat error", error instanceof Error ? error.message : "error");
    return "AI 응답 생성에 실패했습니다. 잠시 후 다시 시도하세요.";
  }
  await appendDiscordTurns(key, input.text, reply);
  return reply;
}
