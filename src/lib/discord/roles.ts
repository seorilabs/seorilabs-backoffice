import { env } from "@/lib/env";

export type DiscordCapability =
  | "read"
  | "planning"
  | "bug"
  | "planning_approval"
  | "release_approval"
  | "metric_incident"
  | "ops_incident"
  | "release"
  | "vault_write"
  | "vault_index";

const ROLE_CAPABILITIES: Record<string, DiscordCapability[]> = {
  operations_admin: ["read", "planning", "bug", "planning_approval", "release_approval", "metric_incident", "ops_incident", "release", "vault_write", "vault_index"],
  operator: ["read", "planning", "bug", "planning_approval", "release_approval", "metric_incident", "ops_incident", "release", "vault_write"],
  product: ["read", "planning", "planning_approval", "metric_incident", "vault_write"],
  design: ["read", "planning"],
  development: ["read", "bug", "ops_incident"],
  qa: ["read", "bug", "release_approval", "ops_incident"],
  data: ["read", "metric_incident"],
  finance: ["read", "metric_incident"],
  release_ops: ["read", "release_approval", "ops_incident", "release"],
  cs: ["read", "bug"],
  viewer: ["read"],
};

/** 역할 키의 capability 목록. */
export function capabilitiesForRole(roleKey: string): readonly DiscordCapability[] {
  return ROLE_CAPABILITIES[roleKey] ?? [];
}

export function hasDiscordCapability(roleIds: readonly string[], capability: DiscordCapability): boolean {
  for (const [roleKey, capabilities] of Object.entries(ROLE_CAPABILITIES)) {
    const configuredId = env.discordRoleId(roleKey);
    if (configuredId && roleIds.includes(configuredId) && capabilities.includes(capability)) return true;
  }
  return false;
}

/**
 * 버튼이 실려 나가는 알림 채널. 카드는 이 채널들에 놓이므로 버튼을 누르는 인터랙션도
 * 여기서 온다. 슬래시 명령은 #backoffice 로만 제한하고, 버튼은 카드가 있는 곳에서
 * 눌러야 의미가 있다. 실제 실행 권한은 채널이 아니라 Discord 역할로 건다.
 */
export const DISCORD_CARD_CHANNEL_KEYS = [
  "backoffice", // 승인·초안·명령 확인 카드
  "release-ops", // 배포 상태 카드의 마켓 후속 작업
  "ops-alerts", // 장애 확인·담당 지정
  "metrics-daily", // 지표 계열 장애 카드
] as const;

/**
 * 인터랙션 종류별 허용 채널 키.
 * 슬래시 명령·모달은 #backoffice 로 묶고, 버튼만 카드가 놓인 채널까지 넓힌다.
 * 명령까지 넓히면 운영 알림 채널 어디서나 배포를 시작할 수 있게 된다.
 */
export function interactionChannelKeys(
  isMessageComponent: boolean,
): readonly string[] {
  return isMessageComponent ? DISCORD_CARD_CHANNEL_KEYS : ["backoffice"];
}

export function isDiscordInteractionScope(input: {
  guildId?: string;
  channelId?: string;
  expectedGuildId: string;
  allowedChannelIds: readonly string[];
}): boolean {
  if (!input.guildId || !input.channelId) return false;
  if (input.guildId !== input.expectedGuildId) return false;
  // 미설정 채널은 빈 문자열로 허용 목록에 섞여 들어오는 것이 정상 경로다(env 미설정).
  // channelId 가 비면 위에서 이미 거부되지만, 매칭 대상에서도 빈 값을 명시적으로 뺀다.
  return input.allowedChannelIds.some((id) => id !== "" && id === input.channelId);
}

export function capabilityForCommand(command: string): DiscordCapability {
  switch (command) {
    case "plan":
      return "planning";
    case "bug":
      return "bug";
    case "release":
    case "deploy":
    case "snapshot":
      return "release";
    case "index":
      return "vault_index";
    case "save":
      return "vault_write";
    default:
      return "read";
  }
}
