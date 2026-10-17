import { env } from "@/lib/env";
import { putDiscordApi } from "@/lib/notifications/discord";

import { discordCommandManifest } from "./command-definitions";

export const DISCORD_COMMANDS = discordCommandManifest();

export async function registerDiscordGuildCommands() {
  const appId = env.discordApplicationId();
  const guildId = env.discordGuildId();
  if (!/^\d+$/.test(appId) || !/^\d+$/.test(guildId) || !env.discordBotToken()) {
    throw new Error("Discord Application/Guild/Bot 설정이 없습니다.");
  }
  const result = await putDiscordApi(`/applications/${appId}/guilds/${guildId}/commands`, DISCORD_COMMANDS);
  if (!result.ok) throw new Error(result.error ?? "Discord command 등록 실패");
  return { commands: DISCORD_COMMANDS.length };
}
