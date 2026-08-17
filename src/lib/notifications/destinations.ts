import type { NotificationProvider } from "@prisma/client";
import { env } from "@/lib/env";

export const TELEGRAM_DEFAULT = "default";
export const DISCORD_METRICS = "metrics";
export const DISCORD_ACTION_EVENTS = "action-events";
export const DISCORD_RELEASE_OPS = "release-ops";
export const DISCORD_OPS_ALERTS = "ops-alerts";

export interface NotificationDestination {
  provider: NotificationProvider;
  key: string;
}

export function configuredDestinations(
  keys: Array<"telegram" | "metrics" | "action-events" | "release-ops" | "ops-alerts">,
): NotificationDestination[] {
  const destinations: NotificationDestination[] = [];
  for (const key of keys) {
    if (key === "telegram") {
      if (env.telegramEnabled() && env.telegramToken() && env.telegramChatId()) {
        destinations.push({ provider: "TELEGRAM", key: TELEGRAM_DEFAULT });
      }
      continue;
    }
    const url = discordWebhookFor(key);
    if (url) destinations.push({ provider: "DISCORD", key });
  }
  return destinations;
}

export function discordWebhookFor(destinationKey: string): string {
  switch (destinationKey) {
    case DISCORD_METRICS:
      return env.discordMetricsWebhook();
    case DISCORD_ACTION_EVENTS:
      return env.discordActionEventsWebhook();
    case DISCORD_RELEASE_OPS:
      return env.discordReleaseOpsWebhook();
    case DISCORD_OPS_ALERTS:
      return env.discordOpsAlertsWebhook();
    default:
      return "";
  }
}

export function discordUsername(destinationKey: string): string {
  switch (destinationKey) {
    case DISCORD_METRICS:
      return "Seorilabs Metrics";
    case DISCORD_ACTION_EVENTS:
      return "Seorilabs Action Log";
    case DISCORD_RELEASE_OPS:
      return "Seorilabs Release Ops";
    case DISCORD_OPS_ALERTS:
      return "Seorilabs Ops Alerts";
    default:
      return "Seorilabs Backoffice";
  }
}
