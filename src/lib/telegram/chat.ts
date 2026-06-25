import { prisma } from "@/lib/prisma";
import { STAGE_KO } from "@/lib/domain/lifecycle";
import { asStringArray } from "@/lib/format";
import { hasApproval } from "@/lib/domain/labels";
import { MiniMaxNotConfiguredError, type ChatMessage } from "@/lib/ai/minimax";
import { runChatAgent } from "@/lib/ai/chat-agent";

// 컨텍스트로 불러올 최근 턴 수(=대화 메모리). 너무 길면 비용·지연 증가.
const HISTORY_TURNS = 10;
// chatId 당 보존 상한(초과분 정리).
const RETAIN_TURNS = 40;

// 공장 현황 스냅샷 — 비서가 사실 기반으로 답하도록 system 에 주입.
async function factorySnapshot(): Promise<string> {
  const apps = await prisma.app.findMany({
    select: { currentStage: true },
  });
  const byStage: Record<string, number> = {};
  for (const a of apps) {
    byStage[a.currentStage] = (byStage[a.currentStage] ?? 0) + 1;
  }
  const stageLine = Object.entries(byStage)
    .map(([s, n]) => `${STAGE_KO[s as keyof typeof STAGE_KO] ?? s} ${n}`)
    .join(", ");

  const p1 = await prisma.issueMirror.count({
    where: { state: "OPEN", priority: "P1" },
  });
  const openIssues = await prisma.issueMirror.findMany({
    where: { state: "OPEN" },
    select: { labels: true },
    take: 300,
  });
  const pendingApprovals = openIssues.filter((i) => {
    const l = asStringArray(i.labels);
    return hasApproval(l, "planning") || hasApproval(l, "release");
  }).length;

  return [
    `앱/게임 총 ${apps.length}개 (단계: ${stageLine || "없음"})`,
    `열린 P1 이슈 ${p1}건, 승인 대기 ${pendingApprovals}건`,
  ].join("\n");
}

function systemPrompt(snapshot: string): string {
  return [
    "당신은 Seorilabs 앱 제작 공장의 백오피스 비서다.",
    "공장은 기획→개발→QA→마켓등록→출시→운영 사이클로 Play/App Store/AppsInToss 앱·게임을 만든다.",
    "운영자(1인)와 한국어로 간결하고 실무적으로 대화한다. 추측을 사실처럼 말하지 말고 모르면 모른다고 한다.",
    "기획 브레인스토밍, 우선순위 판단, 운영/지표 해석, 문안 작성 등을 돕는다.",
    "당신은 직접 GitHub 에 쓰거나 배포하지 않는다. 실제 실행은 운영자가 백오피스(/plan, 승인 버튼) 또는 텔레그램 명령(/approvals 등)으로 한다 — 필요하면 그 방법을 안내하라.",
    "",
    "## 지식 볼트(Obsidian) 활용",
    "- '어떤 문서가 있나/목록' → browse_knowledge(키워드)로 경로를 열거한다.",
    "- 내용 질문/요약 → search_knowledge(관련 발췌) 또는 read_knowledge(특정 문서 전체).",
    "- 도구가 돌려준 경로·본문을 근거로 직접 정리·요약해 답한다. '파일을 못 읽는다/도구가 없다'는 변명 금지 — read_knowledge 로 본문을 읽을 수 있다.",
    "- 문서 요약 요청이면 browse/search 로 대상을 찾고 read_knowledge 로 본문을 읽어 핵심을 요약한다.",
    "",
    "## 출력 형식(텔레그램)",
    "- 간결하게 핵심부터. 과한 머리말('알겠습니다…') 금지.",
    "- 굵게는 **텍스트**, 목록은 줄머리 '- '. 제목·항목을 깔끔히 정리해 다음 작업으로 잇기 쉽게 한다.",
    "- 4000자 이내.",
    "",
    "## 현재 공장 현황",
    snapshot,
  ].join("\n");
}

/** 일회성 미리보기(이력/저장 없음) — 검증·디버그용. */
export async function previewChat(userText: string): Promise<string> {
  const snapshot = await factorySnapshot();
  return runChatAgent([
    { role: "system", content: systemPrompt(snapshot) },
    { role: "user", content: userText },
  ]);
}

/** 대화 이력 초기화. */
export async function resetChat(chatId: string | number): Promise<void> {
  await prisma.telegramTurn.deleteMany({ where: { chatId: String(chatId) } });
}

/**
 * 턴 기반 채팅 처리: 이력 로드 → MiniMax 호출 → 턴 저장 → 답변 반환.
 * MiniMax 미설정/오류 시 사용자용 메시지를 반환(throw 안 함).
 */
export async function handleChat(
  chatId: string | number,
  userText: string,
): Promise<string> {
  const cid = String(chatId);

  const recent = await prisma.telegramTurn.findMany({
    where: { chatId: cid },
    orderBy: { createdAt: "desc" },
    take: HISTORY_TURNS,
  });
  const history: ChatMessage[] = recent
    .reverse()
    .map((t) => ({
      role: t.role === "assistant" ? "assistant" : "user",
      content: t.content,
    }));

  const snapshot = await factorySnapshot();
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(snapshot) },
    ...history,
    { role: "user", content: userText },
  ];

  let reply: string;
  try {
    reply = await runChatAgent(messages);
  } catch (e) {
    if (e instanceof MiniMaxNotConfiguredError) {
      return "AI 채팅이 비활성 상태입니다 (MiniMax 미설정).";
    }
    console.error("[telegram] chat error:", e instanceof Error ? e.message : "error");
    return "AI 응답 생성에 실패했습니다. 잠시 후 다시 시도하세요.";
  }

  // 사용자 + 비서 턴 저장 후 오래된 턴 정리.
  await prisma.telegramTurn.createMany({
    data: [
      { chatId: cid, role: "user", content: userText },
      { chatId: cid, role: "assistant", content: reply },
    ],
  });
  const all = await prisma.telegramTurn.findMany({
    where: { chatId: cid },
    orderBy: { createdAt: "desc" },
    select: { id: true },
    skip: RETAIN_TURNS,
  });
  if (all.length > 0) {
    await prisma.telegramTurn.deleteMany({
      where: { id: { in: all.map((t) => t.id) } },
    });
  }

  return reply;
}
