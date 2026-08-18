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
  release_ops: ["read", "release_approval", "ops_incident", "release"],
  cs: ["read", "bug"],
  viewer: ["read"],
};

export function hasDiscordCapability(roleIds: readonly string[], capability: DiscordCapability): boolean {
  for (const [roleKey, capabilities] of Object.entries(ROLE_CAPABILITIES)) {
    const configuredId = env.discordRoleId(roleKey);
    if (configuredId && roleIds.includes(configuredId) && capabilities.includes(capability)) return true;
  }
  return false;
}

export function isDiscordInteractionScope(input: {
  guildId?: string;
  channelId?: string;
  expectedGuildId: string;
  expectedChannelId: string;
}): boolean {
  return Boolean(input.guildId) &&
    Boolean(input.channelId) &&
    input.guildId === input.expectedGuildId &&
    input.channelId === input.expectedChannelId;
}

export function capabilityForCommand(command: string): DiscordCapability {
  switch (command) {
    case "plan":
      return "planning";
    case "bug":
      return "bug";
    case "release":
    case "deploy":
      return "release";
    case "index":
      return "vault_index";
    case "save":
      return "vault_write";
    default:
      return "read";
  }
}
