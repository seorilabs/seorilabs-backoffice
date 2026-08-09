/**
 * Seorilabs 공통 플랫폼 Admin API 클라이언트.
 *
 * 백오피스가 런타임 유저 데이터를 직접 만지지 않게 하는 것이 목적이다.
 * 전에는 `adapters/lizard-tycoon.ts`가 firebase-admin으로 앱의 Firestore를
 * 직접 조작했다. 앱마다 SA 키를 보관해야 했고, 원장 불변식을 백오피스가
 * 따로 지켜야 했다.
 *
 * 이제 플랫폼이 SoT다. 백오피스는 API만 부른다.
 *
 * R1: 백오피스는 런타임 경로에 없다. 이 클라이언트가 죽어도
 * 게임의 결제와 검증은 그대로 동작한다.
 */

import { GoogleAuth } from "google-auth-library";

import {
  PLATFORM_OPERATION_REASON_CODES,
  type PlatformOperationReason,
} from "@/lib/platform/reasons";
import {
  PLATFORM_REFUND_REVIEW_PREFERENCES,
  PLATFORM_REFUND_REVIEW_REASONS,
  PLATFORM_REFUND_REVIEW_STATES,
  type PlatformRefundReviewDecisionReason,
  type PlatformRefundReviewDecisionState,
  type PlatformRefundReviewPreference,
  type PlatformRefundReviewState,
} from "@/lib/platform/refund-review";

/** 플랫폼이 돌려주는 오류. */
export class PlatformApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "PlatformApiError";
    this.code = code;
    this.status = status;
  }
}

export interface PlatformClientOptions {
  /** Admin API 주소. Cloud Run URL이다. */
  baseUrl: string;
  /**
   * Admin API 호출용 서비스 계정 키(JSON 문자열).
   *
   * read 계정은 웹 Pod, write 계정은 AppOps worker에만 둔다. 두 계정
   * 모두 Cloud Run run.invoker 외 프로젝트 권한을 갖지 않는다.
   */
  serviceAccountJson: string;
  /** 요청 제한 시간. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function abortError(): Error {
  const error = new Error("플랫폼 요청 제한 시간을 초과했습니다.");
  error.name = "AbortError";
  return error;
}

function assertBeforeDeadline(
  controller: AbortController,
  deadlineAt: number,
): void {
  // event loop이 잠시 멈추면 timer callback보다 완료 promise의 microtask가
  // 먼저 실행될 수 있다. signal뿐 아니라 절대 시각도 검사해 늦은 fetch를 막는다.
  if (controller.signal.aborted || Date.now() >= deadlineAt) {
    controller.abort();
    throw abortError();
  }
}

/** signal을 받지 않는 GoogleAuth promise도 전체 요청 deadline에 묶는다. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** 운영 화면에 보여줄 주문 요약. */
export interface PlatformOrder {
  orderKey: string;
  /** identity binding에서 확인한 앱. 삭제된 사용자의 tombstone은 빈 문자열이다. */
  appId: string;
  platformUserId: string;
  entitlementId: string;
  platform: string;
  productId: string;
  state: string;
  purchasedAt: string;
  observedAt: string;
  tombstone: boolean;
}

export interface PlatformEntitlementSource {
  platform: string;
  productId: string;
  state: string;
  orderKey: string;
  observedAt: string;
}

export interface PlatformEntitlement {
  entitlementId: string;
  active: boolean;
  updatedAt: string;
  sources: PlatformEntitlementSource[];
}

export interface PlatformOperatorRecord {
  requestId: string;
  platformUserId: string;
  entitlementId: string;
  actorLogin: string;
  reason: PlatformOperationReason;
  appId: string;
  createdAt: string;
  kind: "grant" | "revoke";
  /** revoke 기록이 대상으로 삼은 운영자 grant requestId. */
  grantRequestId?: string;
}

/** 레지스트리가 선언한 원장 환경이 서비스 환경과 다른 앱. */
export interface PlatformEnvironmentMismatch {
  appId: string;
  /** 레지스트리가 선언한 환경. 선언하지 않았으면 빈 문자열이다. */
  registry: string;
  /** 플랫폼 서비스가 실제로 읽고 쓰는 환경. */
  ledger: string;
}

export interface PlatformHealth {
  environment: string;
  deadLetterCount: number;
  /** 세 환불 검토 health 필드와 Admin endpoint가 함께 배포된 세대다. */
  refundReviewAvailable: boolean;
  pendingRefundReviewCount: number;
  dueSoonRefundReviewCount: number;
  failedRefundReviewCount: number;
  /**
   * 비어 있지 않으면 그 앱의 운영 조작이 전부 422로 막힌다.
   *
   * 반대로 유저 결제는 계속 된다. 환경 대조가 Admin 경로에만 있고 검증
   * 경로에는 없기 때문이다. 그래서 5xx나 트래픽 변화로는 잡히지 않는다.
   */
  environmentMismatches: PlatformEnvironmentMismatch[];
}

/**
 * 앱을 가로지르는 플랫폼 전체 사용자 규모.
 *
 * 앱별 제품 지표가 아니다. IAP 원장 환경과도 무관하다 — `users` 컬렉션은
 * identity가 소유하고 sandbox/production prefix를 타지 않으므로, sandbox
 * 원장을 보고 있어도 같은 배포 환경 전체를 센다.
 */
export interface PlatformUserMetrics {
  totalUsers: number;
  /**
   * 직전 1시간 활성. 시계열 해상도를 주는 값이다.
   *
   * dailyActiveUsers를 매시 찍으면 이웃한 두 점이 창을 23/24 공유해
   * 곡선이 뭉개진다. 이 값은 창이 겹치지 않아 굴곡이 남는다.
   */
  hourlyActiveUsers: number;
  dailyActiveUsers: number;
  weeklyActiveUsers: number;
  /**
   * 활성 판정 근거.
   *
   * `session_last_seen`은 세션 발급·갱신 시각 기준이라는 뜻이다. 앱을
   * 열었지만 토큰이 아직 유효해 재발급이 없었던 사용자는 세지 않으므로
   * GA4 DAU보다 작게 나온다. 나중에 이벤트 기반 집계가 붙어도 화면이
   * 정의 변화를 알아챌 수 있게 값으로 받는다.
   */
  activitySource: string;
  measuredAt: string;
}

export interface PlatformAppIapCatalog {
  appId: string;
  entitlements: string[];
}

/** token·order ID·ciphertext·PUID가 없는 환불 검토 projection. */
export interface PlatformRefundReview {
  reviewId: string;
  appId: string;
  expectedEnvironment: "sandbox" | "production";
  state: PlatformRefundReviewState;
  refundReason: number;
  receivedAt: string;
  dueAt: string;
  requestId?: string;
  refundPreference?: PlatformRefundReviewPreference;
  sampleContentProvided?: boolean;
  decisionReason?: PlatformRefundReviewDecisionReason;
  decidedAt?: string;
  respondedAt?: string;
  failedAt?: string;
  expiredAt?: string;
  lastErrorCode?: string;
}

export interface RefundReviewDecisionRequest {
  requestId: string;
  appId: string;
  reviewId: string;
  expectedEnvironment: "sandbox" | "production";
  refundPreference: PlatformRefundReviewPreference;
  sampleContentProvided: boolean;
  reason: PlatformRefundReviewDecisionReason;
  confirmation: string;
}

export interface RefundReviewDecisionResult {
  applied: boolean;
  requestId: string;
  appId: string;
  reviewId: string;
  expectedEnvironment: "sandbox" | "production";
  state: PlatformRefundReviewDecisionState;
  refundPreference: PlatformRefundReviewPreference;
  sampleContentProvided: boolean;
  operation: "refund_review_decision";
}

/** PII를 제외한 플랫폼 인증 사용자 조회 결과. */
export interface PlatformUser {
  platformUserId: string;
  appId: string;
  supportCode: string;
  /** true는 서명 없는 anonymous credential이며 Firebase 익명 Auth와 다르다. */
  isAnonymous: boolean;
  createdAt: string;
  lastSeenAt: string;
}

export type AdsPolicyReason = "operator" | "ad_free";
export interface PlatformAdsPolicy {
  appUsesAds: boolean;
  adsEnabled: boolean;
  disabledBy: AdsPolicyReason[];
  checkedAt: string;
}
export interface PlatformAdsSuppressionRecord {
  requestId: string;
  grantRequestId?: string;
  appId: string;
  platformUserId: string;
  actorLogin: string;
  reason: PlatformOperationReason;
  operation: "grant" | "revoke";
  applied: boolean;
  createdAt: string;
}
export interface PlatformUserAds {
  appId: string;
  platformUserId: string;
  supportCode: string;
  isAnonymous: boolean;
  authType: "firebase" | "firebase_bridge" | "apps_in_toss" | "anonymous";
  lastSeenAt: string;
  policy: PlatformAdsPolicy;
  auditHistory: PlatformAdsSuppressionRecord[];
}
export interface PlatformAdsHealth {
  status: "ok";
  lastSsvSuccessAt?: string;
  invalidSignatureCount: number;
  stalePendingClaimCount: number;
  policyFailureCount: number;
  checkedAt: string;
}
export interface PlatformAdReward { key: string; amount: number }
export interface PlatformAdClaim {
  claimId: string;
  appId: string;
  placement: string;
  provider: "admob" | "apps_in_toss";
  clientPlatform: "android" | "ios" | "apps_in_toss";
  reward: PlatformAdReward;
  state: "accepted" | "confirmed" | "delivered" | "expired";
  assurance: "pending" | "server_verified" | "client_confirmed";
  createdAt: string;
  confirmedAt?: string;
  acknowledgedAt?: string;
  expiresAt: string;
}
export interface PlatformAdsProviderConfig {
  androidAdUnitSuffix?: string;
  iosAdUnitSuffix?: string;
  adGroupSuffix?: string;
  rewardItem?: string;
  rewardAmount?: number;
}
export interface PlatformAdsConfig {
  appId: string;
  providers: Array<"admob" | "apps_in_toss">;
  registrySyncedAt: string;
  placements: Array<{
    id: string;
    format: "rewarded" | "interstitial";
    providers: Record<string, PlatformAdsProviderConfig>;
    reward?: { key: string; min_amount: number; max_amount: number };
    dailyLimit: number;
    cooldownSeconds: number;
  }>;
}
export interface AdsSuppressionRequest {
  requestId: string;
  appId: string;
  platformUserId: string;
  grantRequestId?: string;
  reason: PlatformOperationReason;
  confirmation: string;
}
export interface AdsSuppressionResult {
  applied: boolean;
  requestId: string;
  activeGrantRequestId?: string;
}

/** 운영자 지급·회수 요청. */
export interface OperatorRequest {
  /**
   * 멱등 키. 백오피스의 `isAppOpsRequestId` 규격을 그대로 쓴다.
   *
   * 네트워크가 끊겨 재시도해도 보상이 두 번 나가지 않는 근거다.
   */
  requestId: string;
  platformUserId: string;
  entitlementId: string;
  /** 왜 했는지. 비어 있으면 플랫폼이 거부한다. */
  reason: PlatformOperationReason;
  appId: string;
  /** 화면 표시 환경과 원장 환경이 어긋나면 서버가 거부한다. */
  expectedEnvironment: "sandbox" | "production";
  /** 서버가 계산한 정확한 문구와 일치해야 한다. */
  confirmation: string;
}

export interface RevokeOperatorRequest extends OperatorRequest {
  /** 회수할 운영자 지급 requestId. 마켓 구매 source는 대상으로 삼지 않는다. */
  grantRequestId: string;
}

interface OperatorResultBase {
  /** false면 이미 처리된 요청이었다. 실패가 아니다. */
  applied: boolean;
  entitlements: string[];
  requestId: string;
  appId: string;
  platformUserId: string;
  entitlementId: string;
  expectedEnvironment: "sandbox" | "production";
}

export interface GrantOperatorResult extends OperatorResultBase {
  operation: "grant";
  grantRequestId?: never;
}

export interface RevokeOperatorResult extends OperatorResultBase {
  operation: "revoke";
  grantRequestId: string;
}

export type OperatorResult = GrantOperatorResult | RevokeOperatorResult;

/** App Store sandbox 구매내역 초기화 요청. */
export interface SandboxResetRequest {
  requestId: string;
  platformUserId: string;
  reason: PlatformOperationReason;
  appId: string;
  expectedEnvironment: "sandbox";
  confirmation: string;
  /**
   * App Store Connect에서 구매내역을 실제로 지웠다는 확인.
   *
   * 플랫폼은 App Store Connect API 자격증명이 없어 스스로 확인할 수 없다.
   * 확인 없이 원장만 지우면 Apple에는 거래가 남아 다음 검증이 그걸
   * 새 구매로 보고 다시 지급한다. 초기화한 줄 알았던 테스터가
   * 상품을 그대로 갖게 된다.
   */
  appleClearedConfirmed: true;
}

export interface SandboxResetResult {
  requestId: string;
  appId: string;
  platformUserId: string;
  expectedEnvironment: "sandbox";
  operation: "sandbox_reset";
  resetOrderKeys: string[];
}

/** 민감한 대상 정보 없이 durable reset intent의 진행 상태만 조회한다. */
export interface SandboxResetStatus {
  requestId: string;
  appId: string;
  state: "prepared" | "completed" | "closed_not_started";
  expectedEnvironment: "sandbox";
  operation: "sandbox_reset";
}

/** 만료된 백오피스 command가 prepared intent를 같은 ID로 재개할 때 쓴다. */
export interface SandboxResetResumeRequest {
  requestId: string;
  appId: string;
  confirmation: string;
}

/** durable intent 부재를 영구 확정하는 write 요청과 응답. */
export interface SandboxResetCloseRequest {
  requestId: string;
  appId: string;
  confirmation: string;
}

export interface SandboxResetCloseResult extends SandboxResetStatus {
  state: "closed_not_started";
  applied: boolean;
}

export interface MaintenanceResult {
  appId: string;
  active: boolean;
  minutes: number;
}

function invalidPlatformResponse(message: string): never {
  throw new PlatformApiError("platform_response_invalid", message, 200);
}

function requiredArray(
  value: unknown,
  key: string,
): unknown[] {
  if (!isRecord(value) || !Array.isArray(value[key])) {
    return invalidPlatformResponse(`플랫폼 ${key} 응답 형식이 올바르지 않습니다.`);
  }
  return value[key];
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  if (typeof value[key] !== "string") {
    return invalidPlatformResponse(`플랫폼 ${key} 응답 형식이 올바르지 않습니다.`);
  }
  return value[key];
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const item = value[key];
  if (item === undefined) return undefined;
  if (typeof item !== "string" || item === "") {
    return invalidPlatformResponse(`플랫폼 ${key} 응답 형식이 올바르지 않습니다.`);
  }
  return item;
}

function nonnegativeInteger(
  value: Record<string, unknown>,
  key: string,
  fallback?: number,
): number {
  const item = value[key];
  if (item === undefined && fallback !== undefined) return fallback;
  if (!Number.isInteger(item) || (item as number) < 0) {
    return invalidPlatformResponse(`플랫폼 ${key} 응답 형식이 올바르지 않습니다.`);
  }
  return item as number;
}

function requiredReason(
  value: Record<string, unknown>,
  key: string,
): PlatformOperationReason {
  const reason = requiredString(value, key);
  if (!(PLATFORM_OPERATION_REASON_CODES as readonly string[]).includes(reason)) {
    return invalidPlatformResponse(
      "플랫폼 운영 사유 응답 형식이 올바르지 않습니다.",
    );
  }
  return reason as PlatformOperationReason;
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  if (typeof value[key] !== "boolean") {
    return invalidPlatformResponse(`플랫폼 ${key} 응답 형식이 올바르지 않습니다.`);
  }
  return value[key];
}

const ADS_CLAIM_FORBIDDEN_FIELDS = new Set([
  "transactionId",
  "transactionHash",
  "signature",
  "query",
  "rawQuery",
  "userKey",
  "platformUserId",
  "supportCode",
]);

function containsForbiddenAdsField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenAdsField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, item]) => ADS_CLAIM_FORBIDDEN_FIELDS.has(key) || containsForbiddenAdsField(item),
  );
}

function validateAdClaim(value: unknown): PlatformAdClaim {
  if (!isRecord(value) || containsForbiddenAdsField(value) || !isRecord(value.reward)) {
    return invalidPlatformResponse("광고 Claim 응답에 허용되지 않은 필드가 있습니다.");
  }
  const provider = requiredString(value, "provider");
  const clientPlatform = requiredString(value, "clientPlatform");
  const state = requiredString(value, "state");
  const assurance = requiredString(value, "assurance");
  if (
    (provider !== "admob" && provider !== "apps_in_toss") ||
    !["android", "ios", "apps_in_toss"].includes(clientPlatform) ||
    !["accepted", "confirmed", "delivered", "expired"].includes(state) ||
    !["pending", "server_verified", "client_confirmed"].includes(assurance)
  ) {
    return invalidPlatformResponse("광고 Claim 상태 응답 형식이 올바르지 않습니다.");
  }
  const amount = nonnegativeInteger(value.reward, "amount");
  if (amount < 1) {
    return invalidPlatformResponse("광고 Claim 보상 응답 형식이 올바르지 않습니다.");
  }
  return {
    claimId: requiredString(value, "claimId"),
    appId: requiredString(value, "appId"),
    placement: requiredString(value, "placement"),
    provider,
    clientPlatform: clientPlatform as PlatformAdClaim["clientPlatform"],
    reward: { key: requiredString(value.reward, "key"), amount },
    state: state as PlatformAdClaim["state"],
    assurance: assurance as PlatformAdClaim["assurance"],
    createdAt: requiredString(value, "createdAt"),
    confirmedAt: optionalString(value, "confirmedAt"),
    acknowledgedAt: optionalString(value, "acknowledgedAt"),
    expiresAt: requiredString(value, "expiresAt"),
  };
}

function validateAdsProviderConfig(value: unknown): PlatformAdsProviderConfig {
  if (!isRecord(value)) {
    return invalidPlatformResponse("광고 provider 설정 응답 형식이 올바르지 않습니다.");
  }
  return {
    androidAdUnitSuffix: optionalString(value, "androidAdUnitSuffix"),
    iosAdUnitSuffix: optionalString(value, "iosAdUnitSuffix"),
    adGroupSuffix: optionalString(value, "adGroupSuffix"),
    rewardItem: optionalString(value, "rewardItem"),
    ...(value.rewardAmount === undefined
      ? {}
      : { rewardAmount: nonnegativeInteger(value, "rewardAmount") }),
  };
}

function validateAdsConfig(value: unknown, appId: string): PlatformAdsConfig {
  if (!isRecord(value) || value.appId !== appId) {
    return invalidPlatformResponse("광고 앱 설정 응답 대상이 일치하지 않습니다.");
  }
  const providers = requiredArray(value, "providers");
  if (providers.some((item) => item !== "admob" && item !== "apps_in_toss")) {
    return invalidPlatformResponse("광고 provider 목록 응답 형식이 올바르지 않습니다.");
  }
  const placements = requiredArray(value, "placements").map((item) => {
    if (!isRecord(item) || !isRecord(item.providers)) {
      return invalidPlatformResponse("광고 placement 응답 형식이 올바르지 않습니다.");
    }
    const format = requiredString(item, "format");
    if (format !== "rewarded" && format !== "interstitial") {
      return invalidPlatformResponse("광고 format 응답 형식이 올바르지 않습니다.");
    }
    const placementProviders = Object.fromEntries(
      Object.entries(item.providers).map(([name, config]) => [name, validateAdsProviderConfig(config)]),
    );
    let reward: PlatformAdsConfig["placements"][number]["reward"];
    if (item.reward !== undefined) {
      if (!isRecord(item.reward)) {
        return invalidPlatformResponse("광고 reward 범위 응답 형식이 올바르지 않습니다.");
      }
      reward = {
        key: requiredString(item.reward, "key"),
        min_amount: nonnegativeInteger(item.reward, "min_amount"),
        max_amount: nonnegativeInteger(item.reward, "max_amount"),
      };
    }
    return {
      id: requiredString(item, "id"),
      format: format as "rewarded" | "interstitial",
      providers: placementProviders,
      ...(reward ? { reward } : {}),
      dailyLimit: nonnegativeInteger(item, "dailyLimit"),
      cooldownSeconds: nonnegativeInteger(item, "cooldownSeconds"),
    };
  });
  return {
    appId,
    providers: providers as PlatformAdsConfig["providers"],
    registrySyncedAt: requiredString(value, "registrySyncedAt"),
    placements,
  };
}

function validateOrder(value: unknown): PlatformOrder {
  if (!isRecord(value) || typeof value.tombstone !== "boolean") {
    return invalidPlatformResponse("플랫폼 주문 응답 형식이 올바르지 않습니다.");
  }
  return {
    orderKey: requiredString(value, "orderKey"),
    appId: requiredString(value, "appId"),
    platformUserId: requiredString(value, "platformUserId"),
    entitlementId: requiredString(value, "entitlementId"),
    platform: requiredString(value, "platform"),
    productId: requiredString(value, "productId"),
    state: requiredString(value, "state"),
    purchasedAt: requiredString(value, "purchasedAt"),
    observedAt: requiredString(value, "observedAt"),
    tombstone: value.tombstone,
  };
}

function validateEntitlement(value: unknown): PlatformEntitlement {
  if (!isRecord(value) || typeof value.active !== "boolean") {
    return invalidPlatformResponse(
      "플랫폼 entitlement 응답 형식이 올바르지 않습니다.",
    );
  }
  return {
    entitlementId: requiredString(value, "entitlementId"),
    active: value.active,
    updatedAt: requiredString(value, "updatedAt"),
    sources: requiredArray(value, "sources").map((source) => {
      if (!isRecord(source)) {
        return invalidPlatformResponse(
          "플랫폼 entitlement source 응답 형식이 올바르지 않습니다.",
        );
      }
      return {
        platform: requiredString(source, "platform"),
        productId: requiredString(source, "productId"),
        state: requiredString(source, "state"),
        orderKey: requiredString(source, "orderKey"),
        observedAt: requiredString(source, "observedAt"),
      };
    }),
  };
}

function validateOperatorRecord(value: unknown): PlatformOperatorRecord {
  if (!isRecord(value) || (value.kind !== "grant" && value.kind !== "revoke")) {
    return invalidPlatformResponse(
      "플랫폼 운영자 이력 응답 형식이 올바르지 않습니다.",
    );
  }
  const grantRequestId = value.grantRequestId;
  if (grantRequestId !== undefined && typeof grantRequestId !== "string") {
    return invalidPlatformResponse(
      "플랫폼 운영자 이력 응답 형식이 올바르지 않습니다.",
    );
  }
  return {
    requestId: requiredString(value, "requestId"),
    grantRequestId,
    platformUserId: requiredString(value, "platformUserId"),
    entitlementId: requiredString(value, "entitlementId"),
    actorLogin: requiredString(value, "actorLogin"),
    reason: requiredReason(value, "reason"),
    appId: requiredString(value, "appId"),
    createdAt: requiredString(value, "createdAt"),
    kind: value.kind,
  };
}

const FORBIDDEN_REFUND_REVIEW_KEYS = [
  "orderId",
  "pendingRefundToken",
  "ciphertext",
  "secret",
  "packageName",
  "platformUserId",
] as const;

function validateRefundReview(
  value: unknown,
  expectedAppId: string,
  expectedEnvironment: "sandbox" | "production",
): PlatformRefundReview {
  if (
    !isRecord(value) ||
    FORBIDDEN_REFUND_REVIEW_KEYS.some((key) => key in value) ||
    !Number.isSafeInteger(value.refundReason) ||
    (value.expectedEnvironment !== "sandbox" &&
      value.expectedEnvironment !== "production") ||
    !(PLATFORM_REFUND_REVIEW_STATES as readonly unknown[]).includes(value.state)
  ) {
    return invalidPlatformResponse(
      "플랫폼 환불 검토 응답 형식이 올바르지 않습니다.",
    );
  }
  const appId = requiredString(value, "appId");
  const reviewId = requiredString(value, "reviewId");
  const receivedAt = requiredString(value, "receivedAt");
  const dueAt = requiredString(value, "dueAt");
  if (
    appId !== expectedAppId ||
    value.expectedEnvironment !== expectedEnvironment ||
    !/^[0-9a-f]{64}$/.test(reviewId) ||
    Number.isNaN(Date.parse(receivedAt)) ||
    Number.isNaN(Date.parse(dueAt))
  ) {
    return invalidPlatformResponse(
      "플랫폼 환불 검토 응답 대상이 요청과 일치하지 않습니다.",
    );
  }

  const refundPreference = optionalString(value, "refundPreference");
  const decisionReason = optionalString(value, "decisionReason");
  if (
    (refundPreference !== undefined &&
      !(PLATFORM_REFUND_REVIEW_PREFERENCES as readonly string[]).includes(
        refundPreference,
      )) ||
    (decisionReason !== undefined &&
      !(PLATFORM_REFUND_REVIEW_REASONS as readonly string[]).includes(
        decisionReason,
      )) ||
    (value.sampleContentProvided !== undefined &&
      typeof value.sampleContentProvided !== "boolean")
  ) {
    return invalidPlatformResponse(
      "플랫폼 환불 검토 결정 응답 형식이 올바르지 않습니다.",
    );
  }

  return {
    reviewId,
    appId,
    expectedEnvironment: value.expectedEnvironment,
    state: value.state as PlatformRefundReviewState,
    refundReason: value.refundReason as number,
    receivedAt,
    dueAt,
    requestId: optionalString(value, "requestId"),
    refundPreference: refundPreference as
      | PlatformRefundReviewPreference
      | undefined,
    sampleContentProvided: value.sampleContentProvided as boolean | undefined,
    decisionReason: decisionReason as
      | PlatformRefundReviewDecisionReason
      | undefined,
    decidedAt: optionalString(value, "decidedAt"),
    respondedAt: optionalString(value, "respondedAt"),
    failedAt: optionalString(value, "failedAt"),
    expiredAt: optionalString(value, "expiredAt"),
    lastErrorCode: optionalString(value, "lastErrorCode"),
  };
}

function validateRefundReviewDecisionResult(
  value: unknown,
  expected: RefundReviewDecisionRequest,
): RefundReviewDecisionResult {
  if (
    !isRecord(value) ||
    typeof value.applied !== "boolean" ||
    value.requestId !== expected.requestId ||
    value.appId !== expected.appId ||
    value.reviewId !== expected.reviewId ||
    value.expectedEnvironment !== expected.expectedEnvironment ||
    (value.state !== "decided" &&
      value.state !== "responded" &&
      value.state !== "expired" &&
      value.state !== "failed") ||
    value.refundPreference !== expected.refundPreference ||
    value.sampleContentProvided !== expected.sampleContentProvided ||
    value.operation !== "refund_review_decision"
  ) {
    return invalidPlatformResponse(
      "플랫폼 환불 검토 결정 응답 대상이 요청과 일치하지 않습니다.",
    );
  }
  return {
    applied: value.applied,
    requestId: expected.requestId,
    appId: expected.appId,
    reviewId: expected.reviewId,
    expectedEnvironment: expected.expectedEnvironment,
    state: value.state,
    refundPreference: expected.refundPreference,
    sampleContentProvided: expected.sampleContentProvided,
    operation: "refund_review_decision",
  };
}

function validateOperatorResult(
  value: unknown,
  expected: OperatorRequest,
  operation: "grant",
): GrantOperatorResult;
function validateOperatorResult(
  value: unknown,
  expected: RevokeOperatorRequest,
  operation: "revoke",
): RevokeOperatorResult;
function validateOperatorResult(
  value: unknown,
  expected: OperatorRequest | RevokeOperatorRequest,
  operation: "grant" | "revoke",
): OperatorResult {
  if (!isRecord(value) || typeof value.applied !== "boolean") {
    return invalidPlatformResponse("플랫폼 조작 응답 형식이 올바르지 않습니다.");
  }
  const entitlements = requiredArray(value, "entitlements");
  const requestId = requiredString(value, "requestId");
  const appId = requiredString(value, "appId");
  const platformUserId = requiredString(value, "platformUserId");
  const entitlementId = requiredString(value, "entitlementId");
  const expectedEnvironment = requiredString(value, "expectedEnvironment");
  const responseOperation = requiredString(value, "operation");
  const expectedGrantRequestId =
    operation === "revoke"
      ? (expected as RevokeOperatorRequest).grantRequestId
      : undefined;
  const grantRequestId = value.grantRequestId;
  if (
    entitlements.some((item) => typeof item !== "string") ||
    requestId !== expected.requestId ||
    appId !== expected.appId ||
    platformUserId !== expected.platformUserId ||
    entitlementId !== expected.entitlementId ||
    expectedEnvironment !== expected.expectedEnvironment ||
    responseOperation !== operation ||
    grantRequestId !== expectedGrantRequestId
  ) {
    return invalidPlatformResponse(
      "플랫폼 조작 응답 대상이 요청과 일치하지 않습니다.",
    );
  }
  const base = {
    applied: value.applied,
    entitlements: entitlements as string[],
    requestId,
    appId,
    platformUserId,
    entitlementId,
    expectedEnvironment: expected.expectedEnvironment,
  };
  return operation === "grant"
    ? { ...base, operation }
    : { ...base, operation, grantRequestId: expectedGrantRequestId! };
}

function validateSandboxResetResult(
  value: unknown,
  expected: SandboxResetRequest,
): SandboxResetResult {
  if (!isRecord(value)) {
    return invalidPlatformResponse(
      "플랫폼 sandbox reset 응답 형식이 올바르지 않습니다.",
    );
  }
  const requestId = requiredString(value, "requestId");
  const appId = requiredString(value, "appId");
  const platformUserId = requiredString(value, "platformUserId");
  const expectedEnvironment = requiredString(value, "expectedEnvironment");
  const operation = requiredString(value, "operation");
  const resetOrderKeys = requiredArray(value, "resetOrderKeys");
  if (
    requestId !== expected.requestId ||
    appId !== expected.appId ||
    platformUserId !== expected.platformUserId ||
    expectedEnvironment !== expected.expectedEnvironment ||
    operation !== "sandbox_reset" ||
    resetOrderKeys.some((item) => typeof item !== "string")
  ) {
    return invalidPlatformResponse(
      "플랫폼 sandbox reset 응답 대상이 요청과 일치하지 않습니다.",
    );
  }
  return {
    requestId,
    appId,
    platformUserId,
    expectedEnvironment: "sandbox",
    operation: "sandbox_reset",
    resetOrderKeys: resetOrderKeys as string[],
  };
}

function validateSandboxResetStatus(
  value: unknown,
  expected: { requestId: string; appId: string },
): SandboxResetStatus {
  if (!isRecord(value)) {
    return invalidPlatformResponse(
      "플랫폼 sandbox reset 상태 응답 형식이 올바르지 않습니다.",
    );
  }
  const requestId = requiredString(value, "requestId");
  const appId = requiredString(value, "appId");
  const state = requiredString(value, "state");
  const expectedEnvironment = requiredString(value, "expectedEnvironment");
  const operation = requiredString(value, "operation");
  if (
    requestId !== expected.requestId ||
    appId !== expected.appId ||
    (state !== "prepared" &&
      state !== "completed" &&
      state !== "closed_not_started") ||
    expectedEnvironment !== "sandbox" ||
    operation !== "sandbox_reset"
  ) {
    return invalidPlatformResponse(
      "플랫폼 sandbox reset 상태 응답 대상이 요청과 일치하지 않습니다.",
    );
  }
  return {
    requestId,
    appId,
    state,
    expectedEnvironment: "sandbox",
    operation: "sandbox_reset",
  };
}

function validateSandboxResetCloseResult(
  value: unknown,
  expected: SandboxResetCloseRequest,
): SandboxResetCloseResult {
  const status = validateSandboxResetStatus(value, expected);
  if (
    status.state !== "closed_not_started" ||
    !isRecord(value) ||
    typeof value.applied !== "boolean"
  ) {
    return invalidPlatformResponse(
      "플랫폼 sandbox reset 미시작 종료 응답 대상이 요청과 일치하지 않습니다.",
    );
  }
  return { ...status, state: "closed_not_started", applied: value.applied };
}

function validateSandboxResetResumeResult(
  value: unknown,
  expected: SandboxResetResumeRequest,
): SandboxResetResult {
  if (!isRecord(value)) {
    return invalidPlatformResponse(
      "플랫폼 sandbox reset 재개 응답 형식이 올바르지 않습니다.",
    );
  }
  const requestId = requiredString(value, "requestId");
  const appId = requiredString(value, "appId");
  const platformUserId = requiredString(value, "platformUserId");
  const expectedEnvironment = requiredString(value, "expectedEnvironment");
  const operation = requiredString(value, "operation");
  const resetOrderKeys = requiredArray(value, "resetOrderKeys");
  if (
    requestId !== expected.requestId ||
    appId !== expected.appId ||
    platformUserId === "" ||
    expectedEnvironment !== "sandbox" ||
    operation !== "sandbox_reset" ||
    resetOrderKeys.some((item) => typeof item !== "string")
  ) {
    return invalidPlatformResponse(
      "플랫폼 sandbox reset 재개 응답 대상이 요청과 일치하지 않습니다.",
    );
  }
  return {
    requestId,
    appId,
    platformUserId,
    expectedEnvironment: "sandbox",
    operation: "sandbox_reset",
    resetOrderKeys: resetOrderKeys as string[],
  };
}

export class PlatformClient {
  private readonly baseUrl: string;
  private readonly auth: GoogleAuth;
  private readonly timeoutMs: number;

  constructor(options: PlatformClientOptions) {
    if (!options.baseUrl) {
      throw new Error("플랫폼 Admin API 주소가 필요합니다.");
    }
    if (!options.serviceAccountJson.trim()) {
      throw new Error("플랫폼 Admin API 서비스 계정이 필요합니다.");
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let credentials: Record<string, unknown>;
    try {
      credentials = JSON.parse(options.serviceAccountJson) as Record<string, unknown>;
    } catch {
      throw new Error("플랫폼 Admin API 서비스 계정 JSON을 해석하지 못했습니다.");
    }

    this.auth = new GoogleAuth({ credentials });
  }

  /** 운영 상태 요약. dead-letter가 0이 아니면 사람이 봐야 한다. */
  async health(): Promise<PlatformHealth> {
    const res = await this.request<unknown>("GET", "/v1/admin/health");
    if (
      !isRecord(res) ||
      (res.environment !== "sandbox" && res.environment !== "production")
    ) {
      return invalidPlatformResponse("플랫폼 상태 응답 형식이 올바르지 않습니다.");
    }
    const refundReviewAvailable = [
      "pendingRefundReviewCount",
      "dueSoonRefundReviewCount",
      "failedRefundReviewCount",
    ].every((key) => Object.prototype.hasOwnProperty.call(res, key));
    return {
      environment: res.environment,
      deadLetterCount: nonnegativeInteger(res, "deadLetterCount"),
      refundReviewAvailable,
      // rolling deploy 중 구버전 Admin 응답은 세 필드가 없다. 잠깐 0으로
      // 보이게 하되 신규 API가 배포되면 실제 값으로 즉시 전환한다.
      pendingRefundReviewCount: nonnegativeInteger(
        res,
        "pendingRefundReviewCount",
        0,
      ),
      dueSoonRefundReviewCount: nonnegativeInteger(
        res,
        "dueSoonRefundReviewCount",
        0,
      ),
      failedRefundReviewCount: nonnegativeInteger(
        res,
        "failedRefundReviewCount",
        0,
      ),
      // 구버전 Admin API는 이 필드를 주지 않는다. 없으면 빈 배열로 본다.
      // 조회 기능 전체를 막을 만한 값이 아니다.
      environmentMismatches: parseEnvironmentMismatches(res.environmentMismatches),
    };
  }

  /**
   * 플랫폼 전체 사용자 규모.
   *
   * 이 endpoint가 없는 구버전 Admin API를 만나면 던지지 않고 null을
   * 준다. rolling deploy 중 잠깐 없는 것과 진짜 장애를 화면에서 같은
   * 빨간 경고로 보여주면 운영자가 경고를 무시하게 된다.
   */
  async metrics(): Promise<PlatformUserMetrics | null> {
    let res: unknown;
    try {
      res = await this.request<unknown>("GET", "/v1/admin/metrics");
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 404) return null;
      throw error;
    }
    if (!isRecord(res)) {
      return invalidPlatformResponse("플랫폼 지표 응답 형식이 올바르지 않습니다.");
    }
    return {
      totalUsers: nonnegativeInteger(res, "totalUsers"),
      // 구버전 Admin API에는 없다. 0으로 보되 지표 전체를 막지 않는다.
      hourlyActiveUsers: nonnegativeInteger(res, "hourlyActiveUsers", 0),
      dailyActiveUsers: nonnegativeInteger(res, "dailyActiveUsers"),
      weeklyActiveUsers: nonnegativeInteger(res, "weeklyActiveUsers"),
      activitySource: requiredString(res, "activitySource"),
      measuredAt: requiredString(res, "measuredAt"),
    };
  }

  /** platform_user_id 또는 지원 코드로 PII 없는 인증 사용자 정보를 찾는다. */
  async user(reference: string): Promise<PlatformUser> {
    const res = await this.request<unknown>(
      "GET",
      `/v1/admin/users/${encodeURIComponent(reference)}`,
    );
    if (!isRecord(res) || !isRecord(res.user) || typeof res.user.isAnonymous !== "boolean") {
      return invalidPlatformResponse("플랫폼 사용자 응답 형식이 올바르지 않습니다.");
    }
    const platformUserId = requiredString(res.user, "platformUserId");
    const supportCode = requiredString(res.user, "supportCode");
    const normalizedReference = reference.trim().toUpperCase();
    const responseReference = normalizedReference.startsWith("PU_")
      ? platformUserId.toUpperCase()
      : supportCode.toUpperCase();
    if (responseReference !== normalizedReference) {
      return invalidPlatformResponse(
        "플랫폼 사용자 응답 대상이 요청과 일치하지 않습니다.",
      );
    }
    return {
      platformUserId,
      appId: requiredString(res.user, "appId"),
      supportCode,
      isAnonymous: res.user.isAnonymous,
      createdAt: requiredString(res.user, "createdAt"),
      lastSeenAt: requiredString(res.user, "lastSeenAt"),
    };
  }

  async adsHealth(): Promise<PlatformAdsHealth> {
    const value = await this.request<unknown>("GET", "/v1/admin/ads/health");
    if (!isRecord(value) || value.status !== "ok") {
      return invalidPlatformResponse("광고 서비스 상태 응답 형식이 올바르지 않습니다.");
    }
    return {
      status: "ok",
      lastSsvSuccessAt: optionalString(value, "lastSsvSuccessAt"),
      invalidSignatureCount: nonnegativeInteger(value, "invalidSignatureCount"),
      stalePendingClaimCount: nonnegativeInteger(value, "stalePendingClaimCount"),
      policyFailureCount: nonnegativeInteger(value, "policyFailureCount"),
      checkedAt: requiredString(value, "checkedAt"),
    };
  }

  async userAds(platformUserId: string): Promise<PlatformUserAds> {
    const value = await this.request<unknown>(
      "GET",
      `/v1/admin/users/${encodeURIComponent(platformUserId)}/ads`,
    );
    if (!isRecord(value) || value.platformUserId !== platformUserId || !isRecord(value.policy)) {
      return invalidPlatformResponse("사용자 광고 정책 응답 형식이 올바르지 않습니다.");
    }
    const disabledBy = requiredArray(value.policy, "disabledBy");
    const authType = requiredString(value, "authType");
    if (!["firebase", "firebase_bridge", "apps_in_toss", "anonymous"].includes(authType)) {
      return invalidPlatformResponse("광고 정책 인증 유형 응답이 올바르지 않습니다.");
    }
    if (disabledBy.some((item) => item !== "operator" && item !== "ad_free")) {
      return invalidPlatformResponse("사용자 광고 차단 원인 응답이 올바르지 않습니다.");
    }
    const appId = requiredString(value, "appId");
    const auditHistory = requiredArray(value, "auditHistory").map((item) => {
      if (!isRecord(item) || (item.operation !== "grant" && item.operation !== "revoke")) {
        return invalidPlatformResponse("광고 차단 감사 이력 응답이 올바르지 않습니다.");
      }
      if (item.appId !== appId || item.platformUserId !== platformUserId) {
        return invalidPlatformResponse("광고 차단 감사 이력 대상이 사용자와 다릅니다.");
      }
      return {
        requestId: requiredString(item, "requestId"),
        grantRequestId: optionalString(item, "grantRequestId"),
        appId,
        platformUserId,
        actorLogin: requiredString(item, "actorLogin"),
        reason: requiredReason(item, "reason"),
        operation: item.operation as "grant" | "revoke",
        applied: requiredBoolean(item, "applied"),
        createdAt: requiredString(item, "createdAt"),
      };
    });
    return {
      appId,
      platformUserId,
      supportCode: requiredString(value, "supportCode"),
      isAnonymous: requiredBoolean(value, "isAnonymous"),
      authType: authType as PlatformUserAds["authType"],
      lastSeenAt: requiredString(value, "lastSeenAt"),
      policy: {
        appUsesAds: requiredBoolean(value.policy, "appUsesAds"),
        adsEnabled: requiredBoolean(value.policy, "adsEnabled"),
        disabledBy: disabledBy as AdsPolicyReason[],
        checkedAt: requiredString(value.policy, "checkedAt"),
      },
      auditHistory,
    };
  }

  async adsConfig(appId: string): Promise<PlatformAdsConfig> {
    const value = await this.request<unknown>(
      "GET",
      `/v1/admin/apps/${encodeURIComponent(appId)}/ads/config`,
    );
    return validateAdsConfig(value, appId);
  }

  async adClaims(query: Record<string, string | undefined>): Promise<PlatformAdClaim[]> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value) params.set(key, value);
    }
    const value = await this.request<unknown>(
      "GET",
      `/v1/admin/ads/reward-claims?${params.toString()}`,
    );
    return requiredArray(value, "claims").map(validateAdClaim);
  }

  async grantAdsSuppression(
    req: AdsSuppressionRequest,
    actor: string,
  ): Promise<AdsSuppressionResult> {
    return this.mutateAdsSuppression("grant", req, actor);
  }

  async revokeAdsSuppression(
    req: AdsSuppressionRequest,
    actor: string,
  ): Promise<AdsSuppressionResult> {
    return this.mutateAdsSuppression("revoke", req, actor);
  }

  private async mutateAdsSuppression(
    operation: "grant" | "revoke",
    req: AdsSuppressionRequest,
    actor: string,
  ): Promise<AdsSuppressionResult> {
    const value = await this.request<unknown>(
      "POST",
      `/v1/admin/ads/suppressions/${operation}`,
      req,
      actor,
    );
    if (!isRecord(value) || value.requestId !== req.requestId) {
      return invalidPlatformResponse("광고 차단 조작 응답 대상이 일치하지 않습니다.");
    }
    return {
      applied: requiredBoolean(value, "applied"),
      requestId: req.requestId,
      activeGrantRequestId: optionalString(value, "activeGrantRequestId"),
    };
  }

  /**
   * 최근 주문. 기존 recent-purchases에 대응한다.
   *
   * hidden은 계약 형식을 만족하지 않아 Admin API가 제외한 건수다.
   * 0이 아니면 이 목록은 불완전하므로 화면이 반드시 알려야 한다.
   */
  async recentOrders(
    limit = 20,
  ): Promise<{ orders: PlatformOrder[]; hidden: number }> {
    const res = await this.request<unknown>(
      "GET",
      `/v1/admin/orders/recent?limit=${encodeURIComponent(String(limit))}`,
    );
    return {
      orders: requiredArray(res, "orders").map(validateOrder),
      // 구버전 Admin API는 이 필드를 주지 않는다. 0으로 보되, 실제로
      // 제외가 있었는지는 알 수 없다는 뜻이라 조용히 넘어가도 되는 값은
      // 아니다. 다만 목록 자체를 막을 근거는 못 된다.
      hidden: isRecord(res) ? nonnegativeInteger(res, "hiddenOrderCount", 0) : 0,
    };
  }

  /**
   * 사용자별 entitlement. 기존 account-entitlements에 대응한다.
   *
   * 비활성도 함께 온다. 왜 없는지를 봐야 CS가 가능하다.
   */
  async userEntitlements(platformUserId: string): Promise<PlatformEntitlement[]> {
    const res = await this.request<unknown>(
      "GET",
      `/v1/admin/users/${encodeURIComponent(platformUserId)}/entitlements`,
    );
    if (
      !isRecord(res) ||
      requiredString(res, "platformUserId") !== platformUserId
    ) {
      return invalidPlatformResponse(
        "플랫폼 entitlement 응답 대상이 요청과 일치하지 않습니다.",
      );
    }
    return requiredArray(res, "entitlements").map(validateEntitlement);
  }

  /**
   * 운영자 지급·회수 이력. 기존 production-grants에 대응한다.
   *
   * hidden은 계약 형식을 만족하지 않아 Admin API가 제외한 건수다.
   * 감사 이력이라 조용한 누락이 특히 위험하다 — 짧아진 목록을 보고
   * "지급한 적 없다"는 잘못된 결론이 나올 수 있다.
   */
  async operatorRecords(limit = 20): Promise<{
    grants: PlatformOperatorRecord[];
    revocations: PlatformOperatorRecord[];
    hidden: number;
  }> {
    const res = await this.request<unknown>(
      "GET",
      `/v1/admin/operator-grants?limit=${encodeURIComponent(String(limit))}`,
    );

    return {
      grants: requiredArray(res, "grants").map(validateOperatorRecord),
      revocations: requiredArray(res, "revocations").map(
        validateOperatorRecord,
      ),
      hidden: isRecord(res)
        ? nonnegativeInteger(res, "hiddenGrantCount", 0) +
          nonnegativeInteger(res, "hiddenRevocationCount", 0)
        : 0,
    };
  }

  /** 앱별 운영자 변경 allowlist. SKU와 마켓 비밀은 반환하지 않는다. */
  async catalogEntitlements(appId: string): Promise<PlatformAppIapCatalog> {
    const res = await this.request<unknown>(
      "GET",
      `/v1/admin/apps/${encodeURIComponent(appId)}/iap/catalog`,
    );
    if (!isRecord(res) || requiredString(res, "appId") !== appId) {
      return invalidPlatformResponse(
        "플랫폼 entitlement 카탈로그 응답 대상이 요청과 일치하지 않습니다.",
      );
    }
    const entitlements = requiredArray(res, "entitlements");
    if (entitlements.some((item) => typeof item !== "string")) {
      return invalidPlatformResponse(
        "플랫폼 entitlement 카탈로그 응답 형식이 올바르지 않습니다.",
      );
    }
    return { appId, entitlements: entitlements as string[] };
  }

  /** 앱별 Google Play 환불 검토 queue. 민감 필드가 섞이면 응답 전체를 거부한다. */
  async refundReviews(
    appId: string,
    state?: PlatformRefundReviewState,
    limit = 50,
  ): Promise<PlatformRefundReview[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (state) query.set("state", state);
    const res = await this.request<unknown>(
      "GET",
      `/v1/admin/apps/${encodeURIComponent(appId)}/iap/refund-reviews?${query.toString()}`,
    );
    const environment = isRecord(res) ? res.environment : undefined;
    if (
      !isRecord(res) ||
      requiredString(res, "appId") !== appId ||
      (environment !== "sandbox" && environment !== "production")
    ) {
      return invalidPlatformResponse(
        "플랫폼 환불 검토 목록 응답 대상이 요청과 일치하지 않습니다.",
      );
    }
    return requiredArray(res, "refundReviews").map((item) =>
      validateRefundReview(item, appId, environment),
    );
  }

  /** 운영자 지급. 등급 C — dry-run과 typed confirmation을 거친 뒤 부른다. */
  async grantEntitlement(
    req: OperatorRequest,
    actor: string,
  ): Promise<GrantOperatorResult> {
    return validateOperatorResult(
      await this.request<unknown>(
        "POST",
        "/v1/admin/entitlements/grant",
        req,
        actor,
      ),
    req,
    "grant",
    );
  }

  /** 운영자 회수. 등급 D — 취소할 수 없다. */
  async revokeEntitlement(
    req: RevokeOperatorRequest,
    actor: string,
  ): Promise<RevokeOperatorResult> {
    return validateOperatorResult(
      await this.request<unknown>(
        "POST",
        "/v1/admin/entitlements/revoke",
        req,
        actor,
      ),
    req,
    "revoke",
    );
  }

  /** 첫 호출만 반영되는 Google 결정. worker write identity에서만 호출한다. */
  async decideRefundReview(
    req: RefundReviewDecisionRequest,
    actor: string,
  ): Promise<RefundReviewDecisionResult> {
    return validateRefundReviewDecisionResult(
      await this.request<unknown>(
        "POST",
        `/v1/admin/apps/${encodeURIComponent(req.appId)}/iap/refund-reviews/${encodeURIComponent(req.reviewId)}/decision`,
        {
          requestId: req.requestId,
          expectedEnvironment: req.expectedEnvironment,
          refundPreference: req.refundPreference,
          sampleContentProvided: req.sampleContentProvided,
          reason: req.reason,
          confirmation: req.confirmation,
        },
        actor,
      ),
      req,
    );
  }

  /**
   * App Store sandbox 초기화. 등급 D — 취소할 수 없다.
   *
   * Apple 쪽 구매내역은 App Store Connect에서 사람이 먼저 지운다.
   * 플랫폼은 그 뒤에 원장을 맞추는 일만 한다. sandbox 원장에서만
   * 동작하고 production에서는 플랫폼이 거부한다.
   */
  async resetAppStoreSandbox(
    req: SandboxResetRequest,
    actor: string,
  ): Promise<SandboxResetResult> {
    return validateSandboxResetResult(
      await this.request<unknown>(
        "POST",
        "/v1/admin/iap/sandbox-reset",
        req,
        actor,
      ),
    req,
    );
  }

  /** prepared/completed/closed 상태를 반환한다. 404만 아직 기록이 없다는 뜻이다. */
  async sandboxResetStatus(
    requestId: string,
    appId: string,
  ): Promise<SandboxResetStatus | null> {
    try {
      return validateSandboxResetStatus(
        await this.request<unknown>(
          "GET",
          `/v1/admin/iap/sandbox-resets/${encodeURIComponent(requestId)}`,
        ),
        { requestId, appId },
      );
    } catch (error) {
      if (
        error instanceof PlatformApiError &&
        error.status === 404 &&
        error.code === "sandbox_reset_not_found"
      ) {
        return null;
      }
      throw error;
    }
  }

  /** prepared durable intent를 immutable requestId 그대로 완료한다. */
  async resumeSandboxReset(
    req: SandboxResetResumeRequest,
    actor: string,
  ): Promise<SandboxResetResult> {
    return validateSandboxResetResumeResult(
      await this.request<unknown>(
        "POST",
        `/v1/admin/iap/sandbox-resets/${encodeURIComponent(req.requestId)}/resume`,
        { appId: req.appId, confirmation: req.confirmation },
        actor,
      ),
      req,
    );
  }

  /** intent 부재를 영구 closure로 확정한다. write identity에서만 호출한다. */
  async closeSandboxResetNotStarted(
    req: SandboxResetCloseRequest,
    actor: string,
  ): Promise<SandboxResetCloseResult> {
    return validateSandboxResetCloseResult(
      await this.request<unknown>(
        "POST",
        `/v1/admin/iap/sandbox-resets/${encodeURIComponent(req.requestId)}/close-not-started`,
        { appId: req.appId, confirmation: req.confirmation },
        actor,
      ),
      req,
    );
  }

  /** 앱 점검 모드를 켜거나 끈다. write 계정으로만 호출할 수 있다. */
  async setMaintenance(appId: string, minutes: number, actor: string): Promise<MaintenanceResult> {
    return this.request<MaintenanceResult>(
      "POST",
      "/v1/admin/config/maintenance",
      { appId, minutes },
      actor,
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    actor?: string,
  ): Promise<T> {
    // 인증 client·토큰 획득·remote fetch·body 해석을 하나의 절대 deadline에
    // 묶는다. token promise 자체는 취소할 수 없지만 timeout 뒤 fetch는 금지한다.
    const controller = new AbortController();
    const deadlineAt = Date.now() + this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // audience는 Cloud Run 서비스 URL이다. 다른 서비스로 발급된
      // 토큰을 재사용하지 못하게 막는다.
      const client = await abortable(
        this.auth.getIdTokenClient(this.baseUrl),
        controller.signal,
      );
      assertBeforeDeadline(controller, deadlineAt);
      const token = await abortable(
        client.idTokenProvider.fetchIdToken(this.baseUrl),
        controller.signal,
      );
      // token이 deadline 경계에서 늦게 완료된 경우 remote mutation을 새로
      // 시작하지 않는다. abortable의 검사와 별도 명시해 회귀를 막는다.
      assertBeforeDeadline(controller, deadlineAt);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      // 누가 눌렀는지. 서비스 계정만으로는 알 수 없다.
      if (actor) {
        headers["X-Seori-Actor"] = actor;
      }

      const response = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      assertBeforeDeadline(controller, deadlineAt);
      const result = await this.readEnvelope<T>(response);
      assertBeforeDeadline(controller, deadlineAt);
      return result;
    } catch (error) {
      if (error instanceof PlatformApiError && !controller.signal.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "연결에 실패했습니다.";
      throw new PlatformApiError(
        "network_error",
        controller.signal.aborted
          ? "플랫폼 요청 제한 시간을 초과했습니다."
          : message,
        0,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async readEnvelope<T>(response: Response): Promise<T> {
    let parsed: unknown;
    try {
      const text = await response.text();
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
      throw new PlatformApiError(
        "platform_response_invalid",
        "플랫폼 응답 형식이 올바르지 않습니다.",
        response.status,
      );
    }

    const httpOk = response.ok;
    if (httpOk !== parsed.ok) {
      // 상태 코드와 ok가 어긋난다. 어느 쪽을 믿을지 정할 수 없다.
      throw new PlatformApiError(
        "platform_response_invalid",
        "플랫폼 응답 상태가 일치하지 않습니다.",
        response.status,
      );
    }

    if (parsed.ok) {
      return (parsed.result ?? {}) as T;
    }

    const error = isRecord(parsed.error) ? parsed.error : {};
    throw new PlatformApiError(
      typeof error.code === "string" ? error.code : "platform_error",
      typeof error.message === "string" ? error.message : "플랫폼 호출에 실패했습니다.",
      response.status,
    );
  }
}

/**
 * 환경 불일치 목록을 읽는다.
 *
 * 형식이 이상하면 던지지 않고 버린다. 이 값은 진단 정보이고, 여기서 실패하면
 * 정작 문제를 봐야 할 상태 화면 전체가 닫힌다. 대신 항목 단위로 걸러서
 * 온전한 것만 보여준다.
 */
function parseEnvironmentMismatches(
  value: unknown,
): PlatformEnvironmentMismatch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.appId !== "string" ||
      typeof item.registry !== "string" ||
      typeof item.ledger !== "string" ||
      item.appId.trim() === ""
    ) {
      return [];
    }
    return [
      { appId: item.appId, registry: item.registry, ledger: item.ledger },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
