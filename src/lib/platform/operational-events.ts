import crypto from "node:crypto";
import { z } from "zod";
import { kstLogStamp } from "@/lib/format/kst";

export const OPERATIONAL_EVENT_TYPES = [
  "identity.created",
  "app.version.first_seen",
  "iap.granted",
  "ad.reward.delivered",
  "iap.completion_failed",
  "ad.reward.delivery_failed",
] as const;

export type OperationalEventType = (typeof OPERATIONAL_EVENT_TYPES)[number];

const allowedAttributes: Record<OperationalEventType, Set<string>> = {
  // referrer는 AppsInToss 로그인의 DEFAULT/SANDBOX 구분이다. 실서비스 유입과
  // 샌드박스 테스트를 같은 카드로 읽지 않으려고 받는다.
  //
  // signInProvider는 Firebase ID token의 sign_in_provider다. authType은 계정이
  // 만들어진 경로(firebase_bridge 등)일 뿐이라 google.com인지 anonymous인지를
  // 가린다. platform이 uid를 새로 만드는 게스트 경로에는 없어서 선택 속성이다.
  "identity.created": new Set([
    "authType",
    "signInProvider",
    "appVersion",
    "runtime",
    "anonymous",
    "referrer",
  ]),
  // 앱·런타임·버전 조합이 Platform 세션에서 처음 관측된 순간이다. 마켓 업로드나
  // 태그가 아니라 그 빌드로 실제 세션이 처음 열린 시각이라 실유입 개시를 가른다.
  "app.version.first_seen": new Set(["appVersion", "runtime", "sdk"]),
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

/**
 * 이벤트 한 건의 사실. 표시 조립과 분리한다.
 *
 * headline 은 이모지·마크업이 없는 문장이라 그대로 장애 요약(OperationalIncident.
 * summary, DB 영구 저장)으로 쓸 수 있다. 예전에는 표시 문자열의 첫 줄을 잘라
 * 요약을 만들었는데, 표시를 한 줄로 바꾸면 요약이 통째로 망가지는 결합이었다.
 */
export interface OperationalEventFacts {
  icon: string;
  headline: string;
  facts: string[];
}

function text(event: OperationalEventInput, key: string, fallback = "unknown"): string {
  const value = attr(event, key);
  return value == null || value === "" ? fallback : String(value);
}

export function operationalEventFacts(event: OperationalEventInput): OperationalEventFacts {
  switch (event.type) {
    case "identity.created": {
      const facts = [text(event, "authType")];
      if (attr(event, "signInProvider")) facts.push(text(event, "signInProvider"));
      if (attr(event, "appVersion")) facts.push(`v${text(event, "appVersion")}`);
      if (attr(event, "runtime")) facts.push(text(event, "runtime"));
      if (attr(event, "anonymous") === true) facts.push("익명");
      if (attr(event, "referrer")) facts.push(`유입 ${text(event, "referrer")}`);
      return { icon: "👤", headline: "신규 계정", facts };
    }
    case "app.version.first_seen": {
      const facts = [`v${text(event, "appVersion")}`];
      if (attr(event, "runtime")) facts.push(text(event, "runtime"));
      if (attr(event, "sdk")) facts.push(text(event, "sdk"));
      return { icon: "🚀", headline: "새 버전 첫 유입", facts };
    }
    case "iap.granted":
      return {
        icon: "💳",
        headline: "IAP 지급",
        facts: [text(event, "platform"), text(event, "entitlementId")],
      };
    case "ad.reward.delivered":
      return {
        icon: "🎬",
        headline: "광고 보상",
        facts: [
          `${text(event, "provider")} / ${text(event, "placementId")}`,
          `${text(event, "rewardKey")} ×${text(event, "rewardAmount")}`,
        ],
      };
    case "iap.completion_failed":
      return {
        icon: "❌",
        headline: "IAP 마켓 완료 처리 실패",
        facts: [text(event, "platform"), `오류 ${text(event, "errorCode", event.outcome)}`],
      };
    case "ad.reward.delivery_failed":
      return {
        icon: "❌",
        headline: "광고 보상 지급 실패",
        facts: [
          `${text(event, "provider")} / ${text(event, "placementId")}`,
          `오류 ${text(event, "errorCode", event.outcome)}`,
        ],
      };
  }
}

/**
 * #action-events 로그 한 줄.
 *
 * 이 채널은 훑어 보는 기록이라 건마다 상자를 그리면 로그로 읽히지 않는다. Discord 는
 * 비고정폭 폰트라 열 정렬이 불가능하므로, 정렬 대신 이모지와 굵은 앱 이름으로 스캔을
 * 만든다. 시각을 맨 뒤에 두는 이유는 Discord 가 메시지 왼쪽에 게시 시각을 이미 붙이기
 * 때문이다 — 줄 안의 시각은 이벤트 발생 시각으로만 의미가 있다.
 */
export function operationalEventLine(
  event: OperationalEventInput,
  displayName: string,
  now?: Date,
): string {
  const { icon, headline, facts } = operationalEventFacts(event);
  const stamp = kstLogStamp(new Date(event.occurredAt), now);
  return `${icon} **${displayName}** ${[headline, ...facts, stamp].join(" · ")}`;
}

export function isOpsAlert(type: OperationalEventType): boolean {
  return type.endsWith("_failed");
}
