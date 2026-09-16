import type { NotificationProvider } from "@prisma/client";
import { env } from "@/lib/env";

export const DISCORD_BACKOFFICE = "backoffice";
export const DISCORD_METRICS = "metrics-daily";
export const DISCORD_ACTION_EVENTS = "action-events";
export const DISCORD_RELEASE_OPS = "release-ops";
export const DISCORD_OPS_ALERTS = "ops-alerts";
export const DISCORD_SEORI_REVIEW = "seori-review";
export const DISCORD_PRIVATE_FEED = "private-feed";
export const DISCORD_USER_REVIEWS = "user-reviews";
// 서리 봇 정체로 나가는 일일 재무 리포트와 지표 하이라이트.
export const DISCORD_APP_OPS = "app-ops";
// IAP 결제 확정 전용. 앱·일 요약 카드와 그 쓰레드의 건별 행만 흐른다.
// 결제는 다른 운영 이벤트와 읽는 목적이 달라 #action-events 에서 떼어낸다.
export const DISCORD_IAP = "iap";
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
  DISCORD_USER_REVIEWS,
  DISCORD_APP_OPS,
  DISCORD_IAP,
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
