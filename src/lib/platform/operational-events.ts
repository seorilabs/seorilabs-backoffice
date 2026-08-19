import crypto from "node:crypto";
import { z } from "zod";

export const OPERATIONAL_EVENT_TYPES = [
  "identity.created",
  "iap.granted",
  "ad.reward.delivered",
  "iap.completion_failed",
  "ad.reward.delivery_failed",
] as const;

export type OperationalEventType = (typeof OPERATIONAL_EVENT_TYPES)[number];

const allowedAttributes: Record<OperationalEventType, Set<string>> = {
  // referrer는 AppsInToss 로그인의 DEFAULT/SANDBOX 구분이다. 실서비스 유입과
  // 샌드박스 테스트를 같은 카드로 읽지 않으려고 받는다.
  "identity.created": new Set(["authType", "anonymous", "referrer"]),
  "iap.granted": new Set(["platform", "entitlementId"]),
  "ad.reward.delivered": new Set([
    "provider",
    "placementId",
    "rewardKey",
    "rewardAmount",
  ]),
  "iap.completion_failed": new Set(["platform", "errorCode"]),
  "ad.reward.delivery_failed": new Set(["provider", "placementId", "errorCode"]),
};

const scalar = z.union([z.string().max(120), z.number().finite(), z.boolean(), z.null()]);

const schema = z
  .object({
    version: z.literal(1),
    eventId: z.string().regex(/^[A-Za-z0-9:_-]{10,191}$/),
    occurredAt: z.string().datetime({ offset: true }),
    type: z.enum(OPERATIONAL_EVENT_TYPES),
    appId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    outcome: z.string().regex(/^[a-z0-9_.-]{1,80}$/),
    attributes: z.record(scalar).default({}),
  })
  .strict();

export interface OperationalEventInput {
  version: 1;
  eventId: string;
  occurredAt: string;
  type: OperationalEventType;
  appId: string;
  outcome: string;
  attributes: Record<string, string | number | boolean | null>;
}

export function parseOperationalEvent(value: unknown): OperationalEventInput | null {
  const result = schema.safeParse(value);
  if (!result.success) return null;
  const keys = Object.keys(result.data.attributes);
  if (keys.length > 20 || keys.some((key) => !allowedAttributes[result.data.type].has(key))) {
    return null;
  }
  return result.data;
}

export function verifyOperationalEventSignature(input: {
  rawBody: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  secret: string;
  now?: Date;
}): boolean {
  if (!input.secret || !input.timestampHeader || !input.signatureHeader) return false;
  const timestamp = Number(input.timestampHeader);
  if (!Number.isSafeInteger(timestamp)) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  if (Math.abs(nowSeconds - timestamp) > 5 * 60) return false;
  const expected = crypto
    .createHmac("sha256", input.secret)
    .update(`${input.timestampHeader}.${input.rawBody}`)
    .digest("hex");
  const actual = input.signatureHeader.replace(/^v1=/, "");
  if (!/^[a-f0-9]{64}$/i.test(actual)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

function attr(
  event: OperationalEventInput,
  key: string,
): string | number | boolean | null | undefined {
  return event.attributes[key];
}

export function operationalEventMessage(
  event: OperationalEventInput,
  displayName: string,
): string {
  const time = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(event.occurredAt));
  const lines = [`앱: **${displayName}**`, `시각: ${time}`];
  switch (event.type) {
    case "identity.created":
      lines.unshift("👤 **신규 Platform 사용자 생성**");
      lines.push(`인증: ${String(attr(event, "authType") ?? "unknown")}`);
      if (attr(event, "anonymous") === true) lines.push("유형: 익명");
      if (attr(event, "referrer")) lines.push(`유입: ${String(attr(event, "referrer"))}`);
      break;
    case "iap.granted":
      lines.unshift("💳 **IAP 지급 확정**");
      lines.push(`마켓: ${String(attr(event, "platform") ?? "unknown")}`);
      lines.push(`상품 권리: ${String(attr(event, "entitlementId") ?? "unknown")}`);
      break;
    case "ad.reward.delivered":
      lines.unshift("🎬 **광고 보상 지급 확정**");
      lines.push(`공급자: ${String(attr(event, "provider") ?? "unknown")}`);
      lines.push(`지면: ${String(attr(event, "placementId") ?? "unknown")}`);
      lines.push(
        `보상: ${String(attr(event, "rewardKey") ?? "unknown")} × ${String(attr(event, "rewardAmount") ?? "unknown")}`,
      );
      break;
    case "iap.completion_failed":
      lines.unshift("❌ **IAP 마켓 완료 처리 실패**");
      lines.push(`마켓: ${String(attr(event, "platform") ?? "unknown")}`);
      lines.push(`오류: ${String(attr(event, "errorCode") ?? event.outcome)}`);
      break;
    case "ad.reward.delivery_failed":
      lines.unshift("❌ **광고 보상 지급 실패**");
      lines.push(`공급자: ${String(attr(event, "provider") ?? "unknown")}`);
      lines.push(`지면: ${String(attr(event, "placementId") ?? "unknown")}`);
      lines.push(`오류: ${String(attr(event, "errorCode") ?? event.outcome)}`);
      break;
  }
  return lines.join("\n");
}

export function isOpsAlert(type: OperationalEventType): boolean {
  return type.endsWith("_failed");
}
