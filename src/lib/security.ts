import crypto from "node:crypto";

// 길이 비의존 상수시간 비교(양쪽을 sha256 고정폭으로 해시 후 timingSafeEqual).
export function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// 헤더 토큰 검증(미설정/미존재 시 fail-closed).
export function verifyStaticToken(
  header: string | null,
  expected: string | undefined,
): boolean {
  if (!header || !expected) return false;
  return constantTimeEqual(header, expected);
}
