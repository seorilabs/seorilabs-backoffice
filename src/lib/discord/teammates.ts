import { prisma } from "@/lib/prisma";
import { visibleAppWhere } from "@/lib/domain/app-visibility";
import { STAGE_KO } from "@/lib/domain/lifecycle";
import type { DiscordCapability } from "@/lib/discord/roles";
import type { DiscordDestinationKey } from "@/lib/notifications/destinations";
import { env } from "@/lib/env";

// 담당제 AI 팀원. 오너 5명이 각자 앱 포트폴리오(App.ownerTeammate)를 E2E 로
// 책임지고(론칭 진행·운영 보고·개선 이슈 발굴), 운영 총괄 "서리"가 조직 횡단
// (재무·org 장애·담당 미배정)을 맡는다. 보고·카드·스탠드업은 통합 운영 채널
// (app-ops) 한 곳에 모인다.
export const TEAMMATE_KEYS = ["noeul", "iseul", "baram", "saebyeok", "maru", "seori"] as const;

export type TeammateKey = (typeof TEAMMATE_KEYS)[number];

// 오너 공통 권한 번들. 사람 역할 상속 대신 레지스트리에서 직접 정의하되,
// 배포 트리거·파괴 작업은 여전히 포함하지 않는다(사람 게이트 유지).
const OWNER_CAPABILITIES: readonly DiscordCapability[] = [
  "read",
  "planning",
  "bug",
  "metric_incident",
  "release_approval",
];
const CHIEF_CAPABILITIES: readonly DiscordCapability[] = ["read", "metric_incident", "ops_incident"];

export interface TeammateModel {
  provider: "gemini" | "anthropic" | "openai";
  model: string;
}

export interface TeammateMeta {
  key: TeammateKey;
  kind: "owner" | "chief";
  ko: string;
  channelKey: DiscordDestinationKey;
  focus: string;
  capabilities: readonly DiscordCapability[];
  /**
   * 페르소나 고정 배정 모델(2026-08-26 승인, 3사 교차). 전 경로(멘션·순찰 서술·
   * 스탠드업)에 적용해 모델별 품질·비용 비교가 원장에 쌓인다. 총괄(서리)은
   * 결정적 수치만 다뤄 LLM 미사용(undefined). provider 키 미설정 시 Gemini 폴백.
   */
  model?: TeammateModel;
  // 순찰에서 GitHub 이슈 초안(confirm 카드)을 만드는 팀원인가. 초안 카드에는
  // 버튼이 실리므로 이 값이 true 인 팀원의 보고 채널은 반드시 카드 버튼
  // allowlist(DISCORD_CARD_CHANNEL_KEYS) 채널이어야 한다. 총괄(서리)은
  // repo 없는 조직 경고 전용이라 초안을 만들지 않는다.
  draftsEnabled: boolean;
}

const OWNER_FOCUS = "담당 앱 포트폴리오의 론칭 진행, 운영 지표, 릴리즈 품질, 개선 백로그";

function owner(key: TeammateKey, ko: string, model: TeammateModel): TeammateMeta {
  return {
    key,
    kind: "owner",
    ko,
    channelKey: "app-ops",
    focus: OWNER_FOCUS,
    capabilities: OWNER_CAPABILITIES,
    model,
    draftsEnabled: true,
  };
}

export const TEAMMATES: Record<TeammateKey, TeammateMeta> = {
  noeul: owner("noeul", "노을", { provider: "anthropic", model: "claude-opus-5" }),
  iseul: owner("iseul", "이슬", { provider: "anthropic", model: "claude-sonnet-5" }),
  baram: owner("baram", "바람", { provider: "openai", model: "gpt-5.6-terra" }),
  saebyeok: owner("saebyeok", "새벽", { provider: "gemini", model: "gemini-3.7-flash" }),
  maru: owner("maru", "마루", { provider: "openai", model: "gpt-5.6-luna" }),
  seori: {
    key: "seori",
    kind: "chief",
    ko: "서리",
    channelKey: "app-ops",
    focus: "조직 재무(종량제 비용·예산·크레딧), 조직 횡단 장애, 담당 미배정 앱",
    capabilities: CHIEF_CAPABILITIES,
    draftsEnabled: false,
  },
};

export function isTeammateKey(value: string): value is TeammateKey {
  return (TEAMMATE_KEYS as readonly string[]).includes(value);
}

// 기능 플래그가 켜져 있고 자격증명이 주입된 팀원만. 자격증명 없이 배포해도
// 빈 배열이 되어 워커가 crashloop 없이 idle 상태로 남는다.
export function configuredTeammates(): TeammateMeta[] {
  if (!env.featureDiscordTeammates()) return [];
  return TEAMMATE_KEYS.filter((key) => env.discordTeammateConfigured(key)).map(
    (key) => TEAMMATES[key],
  );
}

export interface OwnedApp {
  id: string;
  slug: string;
  displayName: string;
  repoFullName: string;
  currentStage: string;
}

/** 오너의 담당 앱 포트폴리오. 배분은 App.ownerTeammate 데이터라 재배분에 배포가 필요 없다. */
export async function appsOwnedBy(key: TeammateKey): Promise<OwnedApp[]> {
  const apps = await prisma.app.findMany({
    where: { ...visibleAppWhere, ownerTeammate: key },
    orderBy: [{ currentStage: "desc" }, { slug: "asc" }],
    select: { id: true, slug: true, displayName: true, repoFullName: true, currentStage: true },
  });
  return apps.map((app) => ({ ...app, currentStage: app.currentStage as string }));
}

/**
 * 담당자 디렉터리 — "담당자: 앱, 앱, ..." 줄 목록. 멘션 프롬프트가 담당 밖 앱
 * 질문을 실제 담당자에게 지목할 때 쓴다(정적 매트릭스 대체).
 */
export async function ownerDirectoryLines(): Promise<string[]> {
  const apps = await prisma.app.findMany({
    where: { ...visibleAppWhere, ownerTeammate: { not: null } },
    orderBy: { slug: "asc" },
    select: { slug: true, ownerTeammate: true },
  });
  const byOwner = new Map<string, string[]>();
  for (const app of apps) {
    if (!app.ownerTeammate || !isTeammateKey(app.ownerTeammate)) continue;
    const list = byOwner.get(app.ownerTeammate) ?? [];
    list.push(app.slug);
    byOwner.set(app.ownerTeammate, list);
  }
  const lines: string[] = [];
  for (const key of TEAMMATE_KEYS) {
    const slugs = byOwner.get(key);
    if (slugs?.length) lines.push(`- ${TEAMMATES[key].ko}: ${slugs.join(", ")}`);
  }
  lines.push("- 서리(운영 총괄): 종량제 비용·예산, 조직 횡단 장애·인프라");
  return lines;
}

/** 포트폴리오를 프롬프트용 줄 목록으로. */
export function portfolioLines(apps: readonly OwnedApp[]): string[] {
  if (apps.length === 0) return ["- (배분된 앱 없음)"];
  return apps.map(
    (app) =>
      `- ${app.displayName} (${app.slug}) · ${STAGE_KO[app.currentStage as keyof typeof STAGE_KO] ?? app.currentStage}`,
  );
}

export interface GatewayMessage {
  id?: string;
  guild_id?: string;
  channel_id?: string;
  content?: string;
  author?: { id?: string; bot?: boolean };
  mentions?: Array<{ id?: string } | null>;
}

/**
 * 이 팀원 봇이 응답해야 할 멘션인지 판별한다.
 * 봇 작성 메시지(자기 자신 포함)는 무시해 봇 간 무한 루프를 원천 차단한다.
 */
export function shouldHandleTeammateMention(
  message: GatewayMessage,
  botUserId: string,
  guildId: string,
): boolean {
  if (!botUserId || !message.id || !message.channel_id || !message.author?.id) return false;
  if (message.author.bot) return false;
  if (!guildId || message.guild_id !== guildId) return false;
  return Boolean(message.mentions?.some((mention) => mention?.id === botUserId));
}

// 멘션 태그(<@id>, <@!id>)를 벗겨 사용자 발화만 남긴다.
export function stripMentionTags(content: string, botUserId: string): string {
  if (!botUserId) return content.trim();
  return content
    .replace(new RegExp(`<@!?${botUserId}>`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
}
