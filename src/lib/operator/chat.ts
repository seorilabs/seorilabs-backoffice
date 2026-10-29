import { prisma } from "@/lib/prisma";
import { STAGE_KO } from "@/lib/domain/lifecycle";
import { approvalIssueWhere, visibleAppWhere, visibleIssueWhere } from "@/lib/domain/app-visibility";
import { LlmNotConfiguredError, type ChatMessage } from "@/lib/ai/llm";
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
  const [p1, approvals] = await Promise.all([
    prisma.issueMirror.count({ where: { ...visibleIssueWhere, state: "OPEN", priority: "P1" } }),
    prisma.issueMirror.count({ where: { ...approvalIssueWhere, state: "OPEN" } }),
  ]);
  return `앱/게임 총 ${apps.length}개 (단계: ${stageLine || "없음"})\n열린 P1 ${p1}건, 승인 대기 ${approvals}건`;
}

function systemPrompt(snapshot: string): string {
  return [
    "당신은 Seorilabs 앱 제작 공장의 Slack 백오피스 비서다.",
    "한국어로 결론부터 간결하게 답하고, 실제 데이터와 Obsidian 지식 볼트를 근거로 사용한다.",
    "추측을 사실처럼 말하지 않는다. 직접 GitHub 쓰기나 배포를 하지 않고 필요한 Slack 명령을 안내한다.",
    "출력은 Slack Markdown, 4000자 이내다.",
    "",
    "## 현재 공장 현황",
    snapshot,
  ].join("\n");
}

export async function previewOperatorChat(userText: string): Promise<string> {
  return runChatAgent([
    { role: "system", content: systemPrompt(await factorySnapshot()) },
    { role: "user", content: userText },
  ]);
}

// 대화는 메인 봇 /ask 하나뿐이라 서버·채널·사용자 조합이 곧 조회키다.
export function operatorTurnKey(input: {
  workspaceId: string;
  channelId: string;
  userId: string;
}) {
  return {
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    userId: input.userId,
  };
}

export type OperatorTurnKey = ReturnType<typeof operatorTurnKey>;

export async function loadOperatorHistory(key: OperatorTurnKey): Promise<ChatMessage[]> {
  const recent = await prisma.slackTurn.findMany({
    where: key,
    orderBy: { createdAt: "desc" },
    take: HISTORY_TURNS,
  });
  return recent.reverse().map((turn) => ({
    role: turn.role === "assistant" ? "assistant" : "user",
    content: turn.content,
  }));
}

export async function appendOperatorTurns(key: OperatorTurnKey, userText: string, reply: string): Promise<void> {
  await prisma.slackTurn.createMany({
    data: [
      { ...key, role: "user", content: userText },
      { ...key, role: "assistant", content: reply },
    ],
  });
  const stale = await prisma.slackTurn.findMany({
    where: key,
    orderBy: { createdAt: "desc" },
    select: { id: true },
    skip: RETAIN_TURNS,
  });
  if (stale.length) await prisma.slackTurn.deleteMany({ where: { id: { in: stale.map(({ id }) => id) } } });
}

export async function resetOperatorChat(input: { workspaceId: string; channelId: string; userId: string }) {
  await prisma.slackTurn.deleteMany({ where: operatorTurnKey(input) });
}

export async function handleOperatorChat(input: {
  workspaceId: string;
  channelId: string;
  userId: string;
  text: string;
}): Promise<string> {
  const key = operatorTurnKey(input);
  const history = await loadOperatorHistory(key);
  let reply: string;
  try {
    reply = await runChatAgent([
      { role: "system", content: systemPrompt(await factorySnapshot()) },
      ...history,
      { role: "user", content: input.text },
    ]);
  } catch (error) {
    if (error instanceof LlmNotConfiguredError) return "AI 채팅이 비활성 상태입니다.";
    console.error("[slack] chat error", error instanceof Error ? error.message : "error");
    return "AI 응답 생성에 실패했습니다. 잠시 후 다시 시도하세요.";
  }
  await appendOperatorTurns(key, input.text, reply);
  return reply;
}
