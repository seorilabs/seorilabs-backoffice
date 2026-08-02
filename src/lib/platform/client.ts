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

export interface PlatformHealth {
  environment: string;
  deadLetterCount: number;
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

export interface OperatorResult {
  /** false면 이미 처리된 요청이었다. 실패가 아니다. */
  applied: boolean;
  entitlements: string[];
}

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
  appleClearedConfirmed: boolean;
}

export interface SandboxResetResult {
  platformUserId: string;
  resetOrderKeys: string[];
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

function validateOperatorResult(value: unknown): OperatorResult {
  if (!isRecord(value) || typeof value.applied !== "boolean") {
    return invalidPlatformResponse("플랫폼 조작 응답 형식이 올바르지 않습니다.");
  }
  const entitlements = requiredArray(value, "entitlements");
  if (entitlements.some((item) => typeof item !== "string")) {
    return invalidPlatformResponse("플랫폼 조작 응답 형식이 올바르지 않습니다.");
  }
  return { applied: value.applied, entitlements: entitlements as string[] };
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
      (res.environment !== "sandbox" && res.environment !== "production") ||
      !Number.isInteger(res.deadLetterCount) ||
      (res.deadLetterCount as number) < 0
    ) {
      return invalidPlatformResponse("플랫폼 상태 응답 형식이 올바르지 않습니다.");
    }
    return {
      environment: res.environment,
      deadLetterCount: res.deadLetterCount as number,
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
    return {
      platformUserId: requiredString(res.user, "platformUserId"),
      appId: requiredString(res.user, "appId"),
      supportCode: requiredString(res.user, "supportCode"),
      isAnonymous: res.user.isAnonymous,
      createdAt: requiredString(res.user, "createdAt"),
      lastSeenAt: requiredString(res.user, "lastSeenAt"),
    };
  }

  /** 최근 주문. 기존 recent-purchases에 대응한다. */
  async recentOrders(limit = 20): Promise<PlatformOrder[]> {
    const res = await this.request<unknown>(
      "GET",
      `/v1/admin/orders/recent?limit=${encodeURIComponent(String(limit))}`,
    );
    return requiredArray(res, "orders").map(validateOrder);
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
    return requiredArray(res, "entitlements").map(validateEntitlement);
  }

  /** 운영자 지급·회수 이력. 기존 production-grants에 대응한다. */
  async operatorRecords(limit = 20): Promise<{
    grants: PlatformOperatorRecord[];
    revocations: PlatformOperatorRecord[];
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
    };
  }

  /** 운영자 변경 화면용 entitlement ID allowlist. SKU와 마켓 비밀은 반환하지 않는다. */
  async catalogEntitlements(): Promise<string[]> {
    const res = await this.request<unknown>(
      "GET",
      "/v1/admin/iap/catalog",
    );
    const entitlements = requiredArray(res, "entitlements");
    if (entitlements.some((item) => typeof item !== "string")) {
      return invalidPlatformResponse(
        "플랫폼 entitlement 카탈로그 응답 형식이 올바르지 않습니다.",
      );
    }
    return entitlements as string[];
  }

  /** 운영자 지급. 등급 C — dry-run과 typed confirmation을 거친 뒤 부른다. */
  async grantEntitlement(req: OperatorRequest, actor: string): Promise<OperatorResult> {
    return validateOperatorResult(
      await this.request<unknown>(
        "POST",
        "/v1/admin/entitlements/grant",
        req,
        actor,
      ),
    );
  }

  /** 운영자 회수. 등급 D — 취소할 수 없다. */
  async revokeEntitlement(
    req: RevokeOperatorRequest,
    actor: string,
  ): Promise<OperatorResult> {
    return validateOperatorResult(
      await this.request<unknown>(
        "POST",
        "/v1/admin/entitlements/revoke",
        req,
        actor,
      ),
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
    return this.request<SandboxResetResult>("POST", "/v1/admin/iap/sandbox-reset", req, actor);
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
    // audience는 Cloud Run 서비스 URL이다. 다른 서비스로 발급된
    // 토큰을 재사용하지 못하게 막는다.
    const client = await this.auth.getIdTokenClient(this.baseUrl);
    const token = await client.idTokenProvider.fetchIdToken(this.baseUrl);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
    // 누가 눌렀는지. 서비스 계정만으로는 알 수 없다.
    if (actor) {
      headers["X-Seori-Actor"] = actor;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "연결에 실패했습니다.";
      throw new PlatformApiError("network_error", message, 0);
    } finally {
      clearTimeout(timer);
    }

    return this.readEnvelope<T>(response);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
