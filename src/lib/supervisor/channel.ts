import { env } from "@/lib/env";
import { CHANNEL_SUPERVISOR } from "@/lib/notifications/destinations";

/** 뉴스 목적지로 대체하지 않고 대표 에이전트 전용 설정만 읽는다. */
export function supervisorSlackChannelId(): string {
  const channel = env.notificationChannelId(CHANNEL_SUPERVISOR);
  return /^[CG][A-Z0-9]+$/.test(channel) ? channel : "";
}
