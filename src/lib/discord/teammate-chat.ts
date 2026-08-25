import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { GeminiNotConfiguredError } from "@/lib/ai/gemini";
import { chatFnFor } from "@/lib/ai/provider";
import { runChatAgent } from "@/lib/ai/chat-agent";
import {
  appendDiscordTurns,
  discordTurnKey,
  factorySnapshot,
  loadDiscordHistory,
} from "@/lib/discord/chat";
import { createDiscordChannelMessageAs } from "@/lib/notifications/discord";
import type { DiscordCapability } from "@/lib/discord/roles";
import {
  appsOwnedBy,
  ownerDirectoryLines,
  portfolioLines,
  TEAMMATES,
  type OwnedApp,
  type TeammateKey,
  type TeammateMeta,
} from "@/lib/discord/teammates";

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

export interface TeammatePromptContext {
  /** 오너의 담당 앱 포트폴리오(총괄은 빈 배열). */
  portfolio: readonly OwnedApp[];
  /** 담당자 디렉터리 줄 목록 — 담당 밖 질문을 실제 담당자에게 지목하는 근거. */
  directory: readonly string[];
}

export function teammateSystemPrompt(
  meta: TeammateMeta,
  snapshot: string,
  context: TeammatePromptContext,
): string {
  const capabilityLines = meta.capabilities.map((cap) => `- ${CAPABILITY_KO[cap]}`).join("\n");
  const identity =
    meta.kind === "owner"
      ? [
          `당신은 Seorilabs 앱 제작 공장의 AI 담당자 "${meta.ko}"다. 아래 앱 포트폴리오를 처음부터 끝까지 책임진다 — 론칭 진행, 운영 지표 해석, 릴리즈 품질, 개선 이슈 발굴.`,
          "한국어로 결론부터 간결하게 답하고, 실제 데이터를 근거로 사용한다. 추측을 사실처럼 말하지 않고 근거 없는 단정을 하지 않는다.",
          "",
          "## 담당 포트폴리오",
          ...portfolioLines(context.portfolio),
        ]
      : [
          `당신은 Seorilabs 앱 제작 공장의 운영 총괄 AI "${meta.ko}"다. 담당 영역은 ${meta.focus}다.`,
          "한국어로 결론부터 간결하게 답하고, 실제 데이터를 근거로 사용한다. 추측을 사실처럼 말하지 않고 근거 없는 단정을 하지 않는다.",
        ];
  return [
    ...identity,
    "",
    "## 당신의 권한",
    capabilityLines,
    "",
    "## 담당 밖 요청",
    meta.kind === "owner"
      ? "담당 밖 앱의 질문이나 권한 밖 요청은 수행하지 말고 한 문장으로 안내한 뒤 담당자를 지목한다:"
      : "앱 개별 사안은 해당 담당자를 지목한다:",
    ...context.directory,
    "직접 GitHub 쓰기나 배포를 하지 않는다. 실행이 필요한 작업은 메인 백오피스 봇의 슬래시 명령을 안내한다.",
    "출력은 Discord Markdown, 1800자 이내다.",
    "",
    "## 현재 공장 현황",
    snapshot,
  ].join("\n");
}

export function mentionDedupeKey(messageId: string, key: TeammateKey): string {
  return `mention:${messageId}:${key}`;
}

/**
 * LLM 429 에 대한 최소 대응. 30초 대기 후 1회만 재시도하고, 재실패는 호출부가
 * 폴백 처리한다. 세 provider 클라이언트 모두 "(429)" 형식으로 에러를 던진다.
 */
export async function withLlm429Retry<T>(fn: () => Promise<T>, waitMs = 30_000): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("(429)")) throw error;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return fn();
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: unknown }).code === "P2002",
  );
}

export type TeammateMentionResult = "replied" | "skipped" | "failed";

/** teammate_run.payload 에 저장하는 멘션 원문. worker 재기동 후 재시도에 쓴다. */
export interface MentionPayload {
  guildId: string;
  channelId: string;
  userId: string;
  messageId: string;
  text: string;
}

export function parseMentionPayload(value: unknown): MentionPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["guildId", "channelId", "userId", "messageId"] as const) {
    if (typeof record[key] !== "string" || !(record[key] as string)) return null;
  }
  return {
    guildId: record.guildId as string,
    channelId: record.channelId as string,
    userId: record.userId as string,
    messageId: record.messageId as string,
    text: typeof record.text === "string" ? record.text : "",
  };
}

/**
 * INSERT-first claim. dedupeKey unique 위반(P2002)은 이미 처리한 실행이라는 뜻이라
 * null 을 돌려주고, 그 외 오류는 그대로 던진다.
 */
export async function claimTeammateRun(
  create: () => Promise<{ id: string }>,
): Promise<string | null> {
  try {
    return (await create()).id;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

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
  const payload: MentionPayload = {
    guildId: input.guildId,
    channelId: input.channelId,
    userId: input.userId,
    messageId: input.messageId,
    text: input.text,
  };
  const runId = await claimTeammateRun(() =>
    prisma.teammateRun.create({
      data: {
        teammate: meta.key,
        trigger: "mention",
        dedupeKey: mentionDedupeKey(input.messageId, meta.key),
        scope: `channel:${input.channelId} user:${input.userId}`,
        status: "PROCESSING",
        attempts: 1,
        startedAt: new Date(),
        // worker 가 응답 도중 죽으면 maintain 이 payload 로 재시도한다.
        payload: payload as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    }),
  );
  if (!runId) return "skipped";

  if (input.busy) {
    await createDiscordChannelMessageAs(
      input.botToken,
      input.channelId,
      "지금 다른 요청을 처리하고 있습니다. 잠시 후 다시 불러주세요.",
      { plain: true, replyToMessageId: input.messageId },
    );
    await prisma.teammateRun.update({
      where: { id: runId },
      data: { status: "COMPLETED", outcome: "busy", completedAt: new Date(), payload: Prisma.DbNull },
    });
    return "replied";
  }

  return replyToMention(runId, meta, input.botToken, payload);
}

/**
 * claim 이 끝난 멘션 run 의 응답 본체. 최초 처리와 worker 재기동 후 재시도가
 * 같은 경로를 쓴다. 정상 완료 시 payload 를 비운다.
 */
async function replyToMention(
  runId: string,
  meta: TeammateMeta,
  botToken: string,
  payload: MentionPayload,
): Promise<TeammateMentionResult> {
  const reply = async (text: string) =>
    createDiscordChannelMessageAs(botToken, payload.channelId, text, {
      plain: true,
      replyToMessageId: payload.messageId,
    });

  const key = discordTurnKey({
    guildId: payload.guildId,
    channelId: payload.channelId,
    userId: payload.userId,
    teammate: meta.key,
  });
  const question =
    payload.text ||
    (meta.kind === "owner"
      ? "당신의 담당 포트폴리오와 지금 볼 만한 현황을 짧게 소개해줘."
      : "당신의 역할과 지금 볼 만한 조직 현황을 짧게 소개해줘.");
  let answer: string;
  try {
    const [history, snapshot, portfolio, directory] = await Promise.all([
      loadDiscordHistory(key),
      factorySnapshot(),
      meta.kind === "owner" ? appsOwnedBy(meta.key) : Promise.resolve([]),
      ownerDirectoryLines(),
    ]);
    answer = await withLlm429Retry(async () =>
      runChatAgent(
        [
          { role: "system", content: teammateSystemPrompt(meta, snapshot, { portfolio, directory }) },
          ...history,
          { role: "user", content: question },
        ],
        { chat: chatFnFor(meta), usage: { path: "chat-agent", teammate: meta.key } },
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    if (error instanceof GeminiNotConfiguredError) {
      await reply("AI 응답이 비활성 상태입니다.");
    } else if (message.includes("(429)")) {
      await reply("지금 요청이 많습니다. 잠시 후 다시 불러주세요.");
    } else {
      console.error(`[teammate:${meta.key}] mention error`, message);
      await reply("응답 생성에 실패했습니다. 잠시 후 다시 시도하세요.");
    }
    // 폴백 답변까지 보냈으므로 재시도하지 않는 최종 실패다. payload 는 진단용으로 남긴다.
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
      ...(posted.ok ? { payload: Prisma.DbNull } : {}),
    },
  });
  return posted.ok ? "replied" : "failed";
}

/**
 * maintain 이 PENDING 으로 되돌린 멘션 run 을 하나 claim 해 재시도한다.
 * 처리했으면 true. 순찰 큐와 같은 optimistic claim idiom 을 쓴다.
 */
export async function processNextTeammateMentionRetry(
  withSlot: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<boolean> {
  const candidate = await prisma.teammateRun.findFirst({
    where: { status: "PENDING", trigger: "mention" },
    orderBy: { createdAt: "asc" },
    select: { id: true, teammate: true, payload: true },
  });
  if (!candidate) return false;
  const claimed = await prisma.teammateRun.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING", attempts: { increment: 1 }, startedAt: new Date() },
  });
  if (claimed.count !== 1) return true;

  const payload = parseMentionPayload(candidate.payload);
  const meta = (TEAMMATES as Partial<Record<string, TeammateMeta>>)[candidate.teammate];
  const botToken = meta ? env.discordTeammateBotToken(meta.key) : "";
  if (!payload || !meta || !botToken) {
    await prisma.teammateRun.update({
      where: { id: candidate.id },
      data: {
        status: "FAILED",
        outcome: "재시도에 필요한 payload 또는 팀원 자격증명이 없습니다.",
        completedAt: new Date(),
      },
    });
    return true;
  }
  await withSlot(() => replyToMention(candidate.id, meta, botToken, payload));
  return true;
}
