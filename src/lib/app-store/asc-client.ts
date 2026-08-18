// App Store Connect API 공용 클라이언트 — ES256 JWT 발급 + fetch + JSON:API 헬퍼.
//
// Xcode Cloud 빌드 트리거(xcode-cloud/dispatch.ts)와 App Store 심사 제출
// (app-store/submit.ts)이 공유한다. 외부 라이브러리 없이 node:crypto + fetch 만 사용.
//
// 필요 env(App Store Connect API 팀 키):
//   APP_STORE_CONNECT_API_KEY_ID / APP_STORE_CONNECT_ISSUER_ID
//   APP_STORE_CONNECT_PRIVATE_KEY_BASE64 (.p8 PEM 의 base64)

import crypto from "node:crypto";

import { env } from "@/lib/env";

export const ASC_BASE = "https://api.appstoreconnect.apple.com";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** App Store Connect API 용 ES256 JWT(20분) 발급. 외부 라이브러리 없이 node:crypto. */
export function mintToken(): string {
  const kid = env.get("APP_STORE_CONNECT_API_KEY_ID");
  const iss = env.get("APP_STORE_CONNECT_ISSUER_ID");
  const pem = Buffer.from(
    env.get("APP_STORE_CONNECT_PRIVATE_KEY_BASE64"),
    "base64",
  ).toString("utf8");

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid, typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss, iat: now, exp: now + 20 * 60, aud: "appstoreconnect-v1" }),
  );
  const signingInput = `${header}.${payload}`;
  // ES256 = ECDSA(P-256, SHA-256), JWS 는 raw r||s(IEEE P1363) 서명을 요구.
  const signature = crypto
    .sign("sha256", Buffer.from(signingInput), { key: pem, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

export interface JsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | null }>;
}
export interface JsonApiDoc {
  data?: JsonApiResource | JsonApiResource[];
  included?: JsonApiResource[];
  links?: { next?: string };
  errors?: Array<{ status?: string; code?: string; title?: string; detail?: string }>;
}

/** ASC REST 호출. 2xx 아니면 errors detail 을 묶어 throw. 204/빈 응답 허용. */
export async function asc(path: string, init?: RequestInit): Promise<JsonApiDoc> {
  const res = await fetch(`${ASC_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${mintToken()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const doc = (text ? JSON.parse(text) : {}) as JsonApiDoc;
  if (!res.ok) {
    const detail =
      doc.errors?.map((e) => e.detail ?? e.title).filter(Boolean).join("; ") || text;
    throw new Error(`App Store Connect API ${res.status}: ${detail}`);
  }
  return doc;
}

export function asArray(data: JsonApiDoc["data"]): JsonApiResource[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}
