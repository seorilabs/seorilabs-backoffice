import type { NotificationProvider } from "@prisma/client";
import { env } from "@/lib/env";

export const DISCORD_BACKOFFICE = "backoffice";
export const DISCORD_METRICS = "metrics-daily";
export const DISCORD_ACTION_EVENTS = "action-events";
export const DISCORD_RELEASE_OPS = "release-ops";
export const DISCORD_OPS_ALERTS = "ops-alerts";
export const DISCORD_SEORI_REVIEW = "seori-review";
export const DISCORD_PRIVATE_FEED = "private-feed";
export const DISCORD_FINANCE_ALERTS = "finance-alerts";

export const DISCORD_DESTINATIONS = [
  DISCORD_BACKOFFICE,
  DISCORD_METRICS,
  DISCORD_ACTION_EVENTS,
  DISCORD_RELEASE_OPS,
  DISCORD_OPS_ALERTS,
  DISCORD_SEORI_REVIEW,
  DISCORD_PRIVATE_FEED,
  DISCORD_FINANCE_ALERTS,
] as const;

export type DiscordDestinationKey = (typeof DISCORD_DESTINATIONS)[number];

export interface NotificationDestination {
  provider: NotificationProvider;
  key: DiscordDestinationKey;
}

export function isDiscordDestinationKey(value: string): value is DiscordDestinationKey {
  return DISCORD_DESTINATIONS.includes(value as DiscordDestinationKey);
}

export function configuredDestinations(
  keys: DiscordDestinationKey[],
): NotificationDestination[] {
  return keys
    .filter((key) => Boolean(discordChannelId(key)))
    .map((key) => ({ provider: "DISCORD", key }));
}

export function discordChannelId(destinationKey: string): string {
  return isDiscordDestinationKey(destinationKey)
    ? env.discordChannelId(destinationKey)
    : "";
}
