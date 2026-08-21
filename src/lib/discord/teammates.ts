import { capabilitiesForRole, type DiscordCapability } from "@/lib/discord/roles";
import type { DiscordDestinationKey } from "@/lib/notifications/destinations";
import { env } from "@/lib/env";

// AI 팀원 4명. 역할 키·capability 는 사람 역할(roles.ts)을 그대로 상속하고,
// 보고 채널은 역할별 기존 채널을 쓴다(전부 카드 버튼 allowlist 채널).
export const TEAMMATE_ROLES = ["product", "data", "development", "qa"] as const;

export type TeammateRole = (typeof TEAMMATE_ROLES)[number];

export interface TeammateMeta {
  role: TeammateRole;
  ko: string;
  channelKey: DiscordDestinationKey;
  focus: string;
  capabilities: readonly DiscordCapability[];
}

export const TEAMMATES: Record<TeammateRole, TeammateMeta> = {
  product: {
    role: "product",
    ko: "서리 프로덕트",
    channelKey: "backoffice",
    focus: "기획과 우선순위, 승인 대기, 단계 정체 앱",
    capabilities: capabilitiesForRole("product"),
  },
  data: {
    role: "data",
    ko: "서리 데이터",
    channelKey: "metrics-daily",
    focus: "지표 해석, 이상치, 계측 공백",
    capabilities: capabilitiesForRole("data"),
  },
  development: {
    role: "development",
    ko: "서리 개발",
    channelKey: "ops-alerts",
    focus: "코드 결함, 운영 장애, 배포 실패, 기술 부채",
    capabilities: capabilitiesForRole("development"),
  },
  qa: {
    role: "qa",
    ko: "서리 QA",
    channelKey: "release-ops",
    focus: "릴리즈 품질 게이트, 회귀 위험, 스토어 리뷰 불만",
    capabilities: capabilitiesForRole("qa"),
  },
};

export function isTeammateRole(value: string): value is TeammateRole {
  return (TEAMMATE_ROLES as readonly string[]).includes(value);
}

// 기능 플래그가 켜져 있고 자격증명이 주입된 팀원만. 자격증명 없이 배포해도
// 빈 배열이 되어 워커가 crashloop 없이 idle 상태로 남는다.
export function configuredTeammates(): TeammateMeta[] {
  if (!env.featureDiscordTeammates()) return [];
  return TEAMMATE_ROLES.filter((role) => env.discordTeammateConfigured(role)).map(
    (role) => TEAMMATES[role],
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
