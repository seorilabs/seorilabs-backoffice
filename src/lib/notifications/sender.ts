import type { Prisma } from "@prisma/client";
import { env } from "@/lib/env";

// 알림을 메인 봇이 아닌 다른 봇 정체로 게시할 때의 발신자 해석.
//
// 토큰 값은 payload 에 담지 않고 발신자 키만 남긴다. 전송(worker)과 보존기한 삭제가
// 같은 규칙을 써야 게시한 정체가 지우지 못하는 메시지가 남지 않는다.

/** 서리(운영 총괄) 봇. 현재는 일일 재무 리포트 한 경로만 쓴다. */
export const SEORI_SENDER = "seori";

export function senderKey(payload: Prisma.JsonValue): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Prisma.JsonObject).sender;
  return typeof value === "string" && value ? value : null;
}

/** 발신자 키 → 봇 토큰. 미지정이거나 토큰이 없으면 undefined(메인 봇). */
export function senderBotToken(payload: Prisma.JsonValue): string | undefined {
  return senderKey(payload) === SEORI_SENDER ? env.discordSeoriBotToken() || undefined : undefined;
}
