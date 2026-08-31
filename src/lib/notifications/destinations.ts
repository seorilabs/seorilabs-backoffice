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
export const DISCORD_USER_REVIEWS = "user-reviews";
// AI 팀원 통합 운영 채널 — 담당자 순찰 보고, 이슈 초안 confirm 카드, 스탠드업.
export const DISCORD_APP_OPS = "app-ops";
// GitHub 이슈 생성·종료 알림 전용. 등급과 무관하게 전체 이슈가 흐르는 곳이라
// 버튼이 실리는 #backoffice 와 분리한다.
export const DISCORD_GITHUB_ISSUES = "github-issues";

export const DISCORD_DESTINATIONS = [
  DISCORD_BACKOFFICE,
  DISCORD_METRICS,
  DISCORD_ACTION_EVENTS,
  DISCORD_RELEASE_OPS,
  DISCORD_OPS_ALERTS,
  DISCORD_SEORI_REVIEW,
  DISCORD_PRIVATE_FEED,
  DISCORD_FINANCE_ALERTS,
  DISCORD_USER_REVIEWS,
  DISCORD_APP_OPS,
  DISCORD_GITHUB_ISSUES,
] as const;

export type DiscordDestinationKey = (typeof DISCORD_DESTINATIONS)[number];

export interface NotificationDestination {
  provider: NotificationProvider;
  key: DiscordDestinationKey;
}

export function isDiscordDestinationKey(value: string): value is DiscordDestinationKey {
  return DISCORD_DESTINATIONS.includes(value as DiscordDestinationKey);
}

export function discordDestinations(
  keys: DiscordDestinationKey[],
): NotificationDestination[] {
  // 생산자는 논리 목적지만 기록하고, 실제 채널 설정은 전송 worker가 확인한다.
  return keys.map((key) => ({ provider: "DISCORD", key }));
}

export function discordChannelId(destinationKey: string): string {
  return isDiscordDestinationKey(destinationKey)
    ? env.discordChannelId(destinationKey)
    : "";
}

/**
 * 전용 채널이 아직 설정되지 않았으면 기존 채널로 보낸다.
 *
 * 채널 ID 를 봉인하기 전에 배포해도 알림이 끊기지 않게 한다. 채널 미설정이면 전달
 * 단계에서 "channel ID 미설정" 으로 실패해 재시도 끝에 dead letter 가 되는데,
 * 그 사이 알림이 통째로 사라진다. enqueue 시점에 결정해 그 구간을 없앤다.
 */
export function discordDestinationOrFallback(
  preferred: DiscordDestinationKey,
  fallback: DiscordDestinationKey,
): NotificationDestination[] {
  return discordDestinations([discordChannelId(preferred) ? preferred : fallback]);
}
