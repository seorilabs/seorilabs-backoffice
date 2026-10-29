import type { NotificationProvider } from "@prisma/client";
import { env } from "@/lib/env";

export const CHANNEL_BACKOFFICE = "backoffice";
export const CHANNEL_METRICS = "metrics-daily";
export const CHANNEL_ACTION_EVENTS = "action-events";
export const CHANNEL_RELEASE_OPS = "release-ops";
export const CHANNEL_BATCH_MONITORING = "batch-monitoring";
export const CHANNEL_OPS_ALERTS = "ops-alerts";
export const CHANNEL_SEORI_REVIEW = "seori-review";
export const CHANNEL_PRIVATE_FEED = "private-feed";
export const CHANNEL_USER_REVIEWS = "user-reviews";
// 서리 봇 정체로 나가는 일일 재무 리포트와 지표 하이라이트.
export const CHANNEL_APP_OPS = "app-ops";
// IAP 결제 확정 전용. 앱·일 요약 카드와 건별 카드가 흐른다.
// 결제는 다른 운영 이벤트와 읽는 목적이 달라 #action-events 에서 떼어낸다.
export const CHANNEL_IAP = "iap";
export const CHANNEL_AD_REWARDS = "ad-rewards";
// GitHub 이슈 생성·종료 알림 전용. 등급과 무관하게 전체 이슈가 흐르는 곳이라
// 버튼이 실리는 #backoffice 와 분리한다.
export const CHANNEL_GITHUB_ISSUES = "github-issues";

export const CHANNEL_DESTINATIONS = [
  CHANNEL_BACKOFFICE,
  CHANNEL_METRICS,
  CHANNEL_ACTION_EVENTS,
  CHANNEL_RELEASE_OPS,
  CHANNEL_OPS_ALERTS,
  CHANNEL_BATCH_MONITORING,
  CHANNEL_SEORI_REVIEW,
  CHANNEL_PRIVATE_FEED,
  CHANNEL_USER_REVIEWS,
  CHANNEL_APP_OPS,
  CHANNEL_IAP,
  CHANNEL_AD_REWARDS,
  CHANNEL_GITHUB_ISSUES,
] as const;

export type DestinationKey = (typeof CHANNEL_DESTINATIONS)[number];

export interface NotificationDestination {
  provider: NotificationProvider;
  key: DestinationKey;
}

export function isDestinationKey(value: string): value is DestinationKey {
  return CHANNEL_DESTINATIONS.includes(value as DestinationKey);
}

export function notificationDestinations(
  keys: DestinationKey[],
): NotificationDestination[] {
  // 생산자는 논리 목적지만 기록하고, 실제 채널 설정은 전송 worker가 확인한다.
  return keys.map((key) => ({ provider: "SLACK", key }));
}

export function notificationChannelId(destinationKey: string): string {
  return isDestinationKey(destinationKey)
    ? env.notificationChannelId(destinationKey)
    : "";
}

/**
 * 전용 채널이 아직 설정되지 않았으면 기존 채널로 보낸다.
 *
 * 채널 ID 를 봉인하기 전에 배포해도 알림이 끊기지 않게 한다. 채널 미설정이면 전달
 * 단계에서 "channel ID 미설정" 으로 실패해 재시도 끝에 dead letter 가 되는데,
 * 그 사이 알림이 통째로 사라진다. enqueue 시점에 결정해 그 구간을 없앤다.
 */
export function destinationOrFallback(
  preferred: DestinationKey,
  fallback: DestinationKey,
): NotificationDestination[] {
  return notificationDestinations([notificationChannelId(preferred) ? preferred : fallback]);
}
