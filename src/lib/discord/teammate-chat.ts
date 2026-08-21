import { prisma } from "@/lib/prisma";
import { GeminiNotConfiguredError } from "@/lib/ai/gemini";
import { runChatAgent } from "@/lib/ai/chat-agent";
import {
  appendDiscordTurns,
  discordTurnKey,
  factorySnapshot,
  loadDiscordHistory,
} from "@/lib/discord/chat";
import { createDiscordChannelMessageAs } from "@/lib/notifications/discord";
import type { DiscordCapability } from "@/lib/discord/roles";
import type { TeammateMeta, TeammateRole } from "@/lib/discord/teammates";

const CAPABILITY_KO: Record<DiscordCapability, string> = {
  read: "공장 현황·지표·이슈 조회",
  planning: "기획 초안 작성",
  bug: "버그 리포트 초안 작성",
  planning_approval: "기획 승인 판단",
  release_approval: "릴리즈 승인 판단",
  metric_incident: "지표 이상 확인·해석",
  ops_incident: "운영 장애 확인·분류",
  release: "배포 실행",
  vault_write: "지식 볼트 기록",
  vault_index: "지식 볼트 인덱싱",
};

// 권한 밖 요청을 받았을 때 지목할 담당 팀원 안내. 4명 모두 같은 표를 쓴다.
const REFERRAL_MATRIX = [
  "- 지표 해석·계측 공백: 서리 데이터",
  "- 코드 결함·운영 장애·배포 문제: 서리 개발",
  "- 기획·우선순위·승인 대기: 서리 프로덕트",
  "- 릴리즈 품질·스토어 리뷰 불만: 서리 QA",
].join("\n");

export function teammateSystemPrompt(meta: TeammateMeta, snapshot: string): string {
  const capabilityLines = meta.capabilities.map((cap) => `- ${CAPABILITY_KO[cap]}`).join("\n");
  return [
    `당신은 Seorilabs 앱 제작 공장의 AI 팀원 "${meta.ko}"다. 담당 영역은 ${meta.focus}다.`,
    "한국어로 결론부터 간결하게 답하고, 실제 데이터를 근거로 사용한다. 추측을 사실처럼 말하지 않고 근거 없는 단정을 하지 않는다.",
    "",
    `## 당신의 권한 (사람 ${meta.role} 역할과 동일한 경계)`,
    capabilityLines,
    "",
    "## 권한 밖 요청",
    "권한 밖 요청은 수행하지 말고 한 문장으로 거절한 뒤 담당 팀원을 안내한다:",
    REFERRAL_MATRIX,
    "직접 GitHub 쓰기나 배포를 하지 않는다. 실행이 필요한 작업은 메인 백오피스 봇의 슬래시 명령을 안내한다.",
    "출력은 Discord Markdown, 1800자 이내다.",
    "",
    "## 현재 공장 현황",
    snapshot,
  ].join("\n");
}

export function mentionDedupeKey(messageId: string, role: TeammateRole): string {
  return `mention:${messageId}:${role}`;
}

/**
 * Gemini 무료 쿼타의 429 에 대한 최소 대응. 30초 대기 후 1회만 재시도하고,
 * 재실패는 호출부가 폴백 처리한다. gemini.ts 는 건드리지 않는다.
 */
export async function withGemini429Retry<T>(fn: () => Promise<T>, waitMs = 30_000): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("(429)")) throw error;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return fn();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: unknown }).code === "P2002",
  );
}

export type TeammateMentionResult = "replied" | "skipped" | "failed";

/**
 * 팀원 멘션 1건을 처리한다. teammate_run 의 dedupeKey unique 가 INSERT-first claim
 * 역할을 해 Gateway resume replay 로 같은 메시지가 다시 와도 중복 응답하지 않는다.
 */
export async function handleTeammateMention(input: {
  meta: TeammateMeta;
  guildId: string;
  channelId: string;
  userId: string;
  messageId: string;
  text: string;
  botToken: string;
  busy?: boolean;
}): Promise<TeammateMentionResult> {
  const { meta } = input;
  let runId: string;
  try {
    const run = await prisma.teammateRun.create({
      data: {
        teammate: meta.role,
        trigger: "mention",
        dedupeKey: mentionDedupeKey(input.messageId, meta.role),
        scope: `channel:${input.channelId} user:${input.userId}`,
        status: "PROCESSING",
        attempts: 1,
        startedAt: new Date(),
      },
    });
    runId = run.id;
  } catch (error) {
    if (isUniqueViolation(error)) return "skipped";
    throw error;
  }

  const reply = async (text: string) =>
    createDiscordChannelMessageAs(input.botToken, input.channelId, text, {
      plain: true,
      replyToMessageId: input.messageId,
    });

  if (input.busy) {
    await reply("지금 다른 요청을 처리하고 있습니다. 잠시 후 다시 불러주세요.");
    await prisma.teammateRun.update({
      where: { id: runId },
      data: { status: "COMPLETED", outcome: "busy", completedAt: new Date() },
    });
    return "replied";
  }

  const key = discordTurnKey({
    guildId: input.guildId,
    channelId: input.channelId,
    userId: input.userId,
    teammate: meta.role,
  });
  const question = input.text || "당신의 역할과 지금 볼 만한 담당 영역 현황을 짧게 소개해줘.";
  let answer: string;
  try {
    const history = await loadDiscordHistory(key);
    answer = await withGemini429Retry(async () =>
      runChatAgent([
        { role: "system", content: teammateSystemPrompt(meta, await factorySnapshot()) },
        ...history,
        { role: "user", content: question },
      ]),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    if (error instanceof GeminiNotConfiguredError) {
      await reply("AI 응답이 비활성 상태입니다.");
    } else if (message.includes("(429)")) {
      await reply("지금 요청이 많습니다. 잠시 후 다시 불러주세요.");
    } else {
      console.error(`[teammate:${meta.role}] mention error`, message);
      await reply("응답 생성에 실패했습니다. 잠시 후 다시 시도하세요.");
    }
    await prisma.teammateRun.update({
      where: { id: runId },
      data: { status: "FAILED", outcome: message.slice(0, 500), completedAt: new Date() },
    });
    return "failed";
  }

  const posted = await reply(answer);
  if (posted.ok) await appendDiscordTurns(key, question, answer);
  await prisma.teammateRun.update({
    where: { id: runId },
    data: {
      status: posted.ok ? "COMPLETED" : "FAILED",
      outcome: posted.ok ? "replied" : `discord: ${posted.error ?? "전송 실패"}`.slice(0, 500),
      completedAt: new Date(),
    },
  });
  return posted.ok ? "replied" : "failed";
}
