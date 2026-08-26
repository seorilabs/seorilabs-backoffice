import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { chatFnFor } from "@/lib/ai/provider";
import { usageCostUsd } from "@/lib/ai/pricing";
import {
  createDiscordChannelMessage,
  createDiscordChannelMessageAs,
} from "@/lib/notifications/discord";
import {
  appsOwnedBy,
  TEAMMATE_KEYS,
  TEAMMATES,
  type TeammateKey,
  type TeammateMeta,
} from "@/lib/discord/teammates";
import {
  AUTO_ADOPTION_WINDOW_DAYS,
  collectAutoAdoptionStats,
  parsePatrolFindings,
} from "@/lib/discord/teammate-findings";
import { withLlm429Retry } from "@/lib/discord/teammate-chat";

// 아침 스탠드업 — 오너들이 각자 봇 정체로 통합 운영 채널에 한 줄 보고를 남기고,
// 월요일에는 주간 활동·모델 비교 요약(결정적 집계)이 메인 봇으로 추가된다.
// 한 줄 생성은 페르소나 배정 모델 1회 호출, 실패 시 결정적 폴백 라인.

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;

export function standupDedupeKey(now = new Date()): string {
  const kstDate = new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, "");
  return `standup:${kstDate}`;
}

/** KST 자정 경계 [어제 00:00, 오늘 00:00) 를 UTC Date 쌍으로. */
export function kstYesterdayWindow(now = new Date()): { start: Date; end: Date } {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const todayStart = new Date(
    Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - KST_OFFSET_MS,
  );
  return { start: new Date(todayStart.getTime() - DAY_MS), end: todayStart };
}

export interface StandupFacts {
  patrolFindings: number;
  autoRegistered: number;
  drafted: number;
  mentions: number;
  failed: number;
  portfolio: Array<{ slug: string; stage: string }>;
}

export async function collectStandupFacts(
  key: TeammateKey,
  now = new Date(),
): Promise<StandupFacts> {
  const { start, end } = kstYesterdayWindow(now);
  const runs = await prisma.teammateRun.findMany({
    where: { teammate: key, createdAt: { gte: start, lt: end } },
    select: { trigger: true, status: true, findings: true },
    take: 50,
  });
  const facts: StandupFacts = {
    patrolFindings: 0,
    autoRegistered: 0,
    drafted: 0,
    mentions: 0,
    failed: 0,
    portfolio: [],
  };
  for (const run of runs) {
    if (run.status === "FAILED") facts.failed += 1;
    if (run.trigger === "mention") {
      facts.mentions += 1;
      continue;
    }
    for (const item of parsePatrolFindings(run.findings)) {
      facts.patrolFindings += 1;
      if (item.status === "registered" && item.auto) facts.autoRegistered += 1;
      if (item.status === "drafted") facts.drafted += 1;
    }
  }
  facts.portfolio = (await appsOwnedBy(key)).map((app) => ({
    slug: app.slug,
    stage: app.currentStage,
  }));
  return facts;
}

export function fallbackStandupLine(facts: StandupFacts): string {
  return `어제: 발견 ${facts.patrolFindings}건 · 등록 ${facts.autoRegistered}건 · 초안 ${facts.drafted}건 · 멘션 ${facts.mentions}건 / 오늘: 담당 앱 ${facts.portfolio.length}개 순찰 예정`;
}

async function buildStandupLine(meta: TeammateMeta, facts: StandupFacts): Promise<string> {
  try {
    const raw = await withLlm429Retry(() =>
      chatFnFor(meta)(
        [
          {
            role: "system",
            content: [
              `당신은 Seorilabs 앱 제작 공장의 AI 담당자 "${meta.ko}"다.`,
              "아래 사실(JSON)만 근거로 아침 스탠드업 한 줄을 쓴다. 없는 사실을 만들지 않는다.",
              '형식: "어제: ... / 오늘: ..." — 한국어, 140자 이내, 마크다운·이모지 없이.',
            ].join("\n"),
          },
          { role: "user", content: JSON.stringify(facts) },
        ],
        { maxTokens: 300, usage: { path: "standup", teammate: meta.key } },
      ),
    );
    const line = raw.trim().replace(/\s+/g, " ");
    return line ? line.slice(0, 200) : fallbackStandupLine(facts);
  } catch (error) {
    console.error(
      `[teammate-standup:${meta.key}] 라인 생성 실패:`,
      error instanceof Error ? error.message : "error",
    );
    return fallbackStandupLine(facts);
  }
}

interface WeeklyTeammateStats {
  key: TeammateKey;
  findings: number;
  autoRegistered: number;
  manualRegistered: number;
  drafted: number;
  deduped: number;
  mentions: number;
  costUsd: number;
  models: Set<string>;
}

/** 최근 7일 원장·사용량 집계 — 월요일 주간 요약의 소스(결정적, LLM 불필요). */
export async function collectWeeklyStats(now = new Date()): Promise<{
  perTeammate: WeeklyTeammateStats[];
  notPlannedLine: string;
}> {
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const stats = new Map<TeammateKey, WeeklyTeammateStats>();
  const statsFor = (key: TeammateKey): WeeklyTeammateStats => {
    const existing = stats.get(key);
    if (existing) return existing;
    const created: WeeklyTeammateStats = {
      key,
      findings: 0,
      autoRegistered: 0,
      manualRegistered: 0,
      drafted: 0,
      deduped: 0,
      mentions: 0,
      costUsd: 0,
      models: new Set(),
    };
    stats.set(key, created);
    return created;
  };

  const runs = await prisma.teammateRun.findMany({
    where: { createdAt: { gte: since } },
    select: { teammate: true, trigger: true, findings: true },
    take: 500,
  });
  for (const run of runs) {
    if (!(TEAMMATE_KEYS as readonly string[]).includes(run.teammate)) continue;
    const entry = statsFor(run.teammate as TeammateKey);
    if (run.trigger === "mention") {
      entry.mentions += 1;
      continue;
    }
    for (const item of parsePatrolFindings(run.findings)) {
      entry.findings += 1;
      if (item.status === "registered") {
        if (item.auto) entry.autoRegistered += 1;
        else entry.manualRegistered += 1;
      } else if (item.status === "drafted") entry.drafted += 1;
      else if (item.status === "deduped") entry.deduped += 1;
    }
  }

  const usage = await prisma.aiUsage.groupBy({
    by: ["teammate", "model"],
    where: { createdAt: { gte: since }, teammate: { not: null } },
    _sum: { inputTokens: true, outputTokens: true, thinkingTokens: true },
  });
  for (const row of usage) {
    if (!row.teammate || !(TEAMMATE_KEYS as readonly string[]).includes(row.teammate)) continue;
    const entry = statsFor(row.teammate as TeammateKey);
    entry.models.add(row.model);
    const cost = usageCostUsd(
      row.model,
      row._sum.inputTokens ?? 0,
      row._sum.outputTokens ?? 0,
      row._sum.thinkingTokens ?? 0,
    );
    if (cost != null) entry.costUsd += cost;
  }

  const adoption = await collectAutoAdoptionStats(AUTO_ADOPTION_WINDOW_DAYS);
  const notPlannedLine =
    adoption.registered === 0
      ? `자동 등록 채택률: 최근 ${AUTO_ADOPTION_WINDOW_DAYS}일 표본 없음`
      : `자동 등록 채택률: ${AUTO_ADOPTION_WINDOW_DAYS}일간 ${adoption.registered}건 중 NOT_PLANNED ${adoption.notPlanned}건 (${Math.round((adoption.notPlanned / adoption.registered) * 100)}%)`;

  const perTeammate = TEAMMATE_KEYS.map((key) => stats.get(key)).filter(
    (entry): entry is WeeklyTeammateStats => Boolean(entry),
  );
  return { perTeammate, notPlannedLine };
}

export function renderWeeklySummary(input: {
  perTeammate: WeeklyTeammateStats[];
  notPlannedLine: string;
}): string {
  const lines = ["📊 **주간 팀원 활동·모델 비교 (최근 7일)**"];
  for (const entry of input.perTeammate) {
    const meta = TEAMMATES[entry.key];
    const model = entry.models.size > 0 ? [...entry.models].join(",") : "gemini(폴백)";
    lines.push(
      `- ${meta.ko} [${model}]: 발견 ${entry.findings} · 자동등록 ${entry.autoRegistered} · 수동등록 ${entry.manualRegistered} · 초안 ${entry.drafted} · 중복 ${entry.deduped} · 멘션 ${entry.mentions} · 비용 $${entry.costUsd.toFixed(2)}`,
    );
  }
  lines.push(input.notPlannedLine);
  return lines.join("\n");
}

/** KST 기준 월요일 아침인가 — 주간 요약 게시 여부. */
export function isKstMonday(now = new Date()): boolean {
  return new Date(now.getTime() + KST_OFFSET_MS).getUTCDay() === 1;
}

/**
 * PENDING standup run 을 하나 claim 해 실행한다. 처리했으면 true.
 * 오너별 자기 모델 한 줄(각자 봇 정체) + 총괄 결정적 라인, 월요일엔 주간 요약.
 */
export async function processNextTeammateStandup(
  withSlot: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<boolean> {
  const candidate = await prisma.teammateRun.findFirst({
    where: { status: "PENDING", trigger: "standup" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!candidate) return false;
  const claimed = await prisma.teammateRun.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING", attempts: { increment: 1 }, startedAt: new Date() },
  });
  if (claimed.count !== 1) return true;

  const channelId = env.discordChannelId("app-ops");
  if (!channelId) {
    await prisma.teammateRun.update({
      where: { id: candidate.id },
      data: {
        status: "FAILED",
        outcome: "app-ops 채널 ID 가 설정되지 않았습니다.",
        completedAt: new Date(),
      },
    });
    return true;
  }

  const now = new Date();
  let posted = 0;
  for (const key of TEAMMATE_KEYS) {
    const meta = TEAMMATES[key];
    if (!env.discordTeammateConfigured(key)) continue;
    const botToken = env.discordTeammateBotToken(key);
    const facts = await collectStandupFacts(key, now);
    const line =
      meta.kind === "chief"
        ? fallbackStandupLine(facts) // 총괄은 결정적 수치 원칙 유지(LLM 미사용)
        : await withSlot(() => buildStandupLine(meta, facts));
    const sent = await createDiscordChannelMessageAs(botToken, channelId, `🌅 ${line}`);
    if (sent.ok) posted += 1;
    else console.error(`[teammate-standup:${key}] 게시 실패:`, sent.error);
  }

  let weekly = false;
  if (isKstMonday(now)) {
    const summary = renderWeeklySummary(await collectWeeklyStats(now));
    const sent = await createDiscordChannelMessage(channelId, summary);
    weekly = sent.ok;
    if (!sent.ok) console.error("[teammate-standup] 주간 요약 게시 실패:", sent.error);
  }

  await prisma.teammateRun.update({
    where: { id: candidate.id },
    data: {
      status: "COMPLETED",
      outcome: `스탠드업 ${posted}명 게시${weekly ? " + 주간 요약" : ""}`,
      findings: Prisma.DbNull,
      completedAt: new Date(),
    },
  });
  return true;
}
