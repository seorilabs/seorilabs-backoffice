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
   * backoffice-admin@ 서비스 계정 키(JSON 문자열).
   *
   * 이 SA에는 run.invoker 외에 아무 권한도 없다. RPI 클러스터가
   * 침해되어도 폭발 반경이 Admin API 호출까지로 제한된다.
   */
  serviceAccountJson: string;
  /** 요청 제한 시간. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** 운영 화면에 보여줄 주문 요약. */
export interface PlatformOrder {
  orderKey: string;
  platformUserId: string;
  entitlementId: string;
  platform: string;
  productId: string;
  providerOrderId: string;
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
  reason: string;
  appId: string;
  createdAt: string;
  kind: "grant" | "revoke";
}

export interface PlatformHealth {
  environment: string;
  deadLetterCount: number;
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
  reason: string;
  appId: string;
}

export interface OperatorResult {
  /** false면 이미 처리된 요청이었다. 실패가 아니다. */
  applied: boolean;
  entitlements: string[];
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
    return this.request<PlatformHealth>("GET", "/v1/admin/health");
  }

  /** 최근 주문. 기존 recent-purchases에 대응한다. */
  async recentOrders(limit = 20): Promise<PlatformOrder[]> {
    const res = await this.request<{ orders: PlatformOrder[] }>(
      "GET",
      `/v1/admin/orders/recent?limit=${encodeURIComponent(String(limit))}`,
    );
    return res.orders ?? [];
  }

  /**
   * 사용자별 entitlement. 기존 account-entitlements에 대응한다.
   *
   * 비활성도 함께 온다. 왜 없는지를 봐야 CS가 가능하다.
   */
  async userEntitlements(platformUserId: string): Promise<PlatformEntitlement[]> {
    const res = await this.request<{ entitlements: PlatformEntitlement[] }>(
      "GET",
      `/v1/admin/users/${encodeURIComponent(platformUserId)}/entitlements`,
    );
    return res.entitlements ?? [];
  }

  /** 운영자 지급·회수 이력. 기존 production-grants에 대응한다. */
  async operatorRecords(limit = 20): Promise<{
    grants: PlatformOperatorRecord[];
    revocations: PlatformOperatorRecord[];
  }> {
    const res = await this.request<{
      grants: PlatformOperatorRecord[];
      revocations: PlatformOperatorRecord[];
    }>("GET", `/v1/admin/operator-grants?limit=${encodeURIComponent(String(limit))}`);

    return { grants: res.grants ?? [], revocations: res.revocations ?? [] };
  }

  /** 운영자 지급. 등급 C — dry-run과 typed confirmation을 거친 뒤 부른다. */
  async grantEntitlement(req: OperatorRequest, actor: string): Promise<OperatorResult> {
    return this.request<OperatorResult>("POST", "/v1/admin/entitlements/grant", req, actor);
  }

  /** 운영자 회수. 등급 D — 취소할 수 없다. */
  async revokeEntitlement(req: OperatorRequest, actor: string): Promise<OperatorResult> {
    return this.request<OperatorResult>("POST", "/v1/admin/entitlements/revoke", req, actor);
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
