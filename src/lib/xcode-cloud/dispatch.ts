// Xcode Cloud(App Store Connect API) 배포 트리거.
//
// iOS 빌드/업로드를 GitHub Actions(macOS 쿼타) 대신 Xcode Cloud 로 이관한 앱은,
// 릴리즈 시 GH workflow_dispatch 가 아니라 여기서 ASC API 로 명시적으로 빌드를
// 트리거한다(태그 ref 대상). org 릴리즈 모델(태그 자동배포가 아니라 Backoffice
// 명시 dispatch)과 동일하게 동작한다.
//
// 필요 env(App Store Connect API 팀 키):
//   APP_STORE_CONNECT_API_KEY_ID / APP_STORE_CONNECT_ISSUER_ID
//   APP_STORE_CONNECT_PRIVATE_KEY_BASE64 (.p8 PEM 의 base64)
//   XCODE_CLOUD_APP_STORE_REPOS (Xcode Cloud 로 iOS 를 빌드하는 repoFullName CSV)

import crypto from "node:crypto";

import { env } from "@/lib/env";

const ASC_BASE = "https://api.appstoreconnect.apple.com";

/** repoFullName 이 Xcode Cloud(iOS) 대상 allowlist 에 있는지. */
export function isXcodeCloudRepo(repoFullName: string): boolean {
  return env
    .optional("XCODE_CLOUD_APP_STORE_REPOS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(repoFullName);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** App Store Connect API 용 ES256 JWT(20분) 발급. 외부 라이브러리 없이 node:crypto. */
function mintToken(): string {
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

interface JsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | null }>;
}
interface JsonApiDoc {
  data?: JsonApiResource | JsonApiResource[];
  included?: JsonApiResource[];
  errors?: Array<{ title?: string; detail?: string }>;
}

async function asc(path: string, init?: RequestInit): Promise<JsonApiDoc> {
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

function asArray(data: JsonApiDoc["data"]): JsonApiResource[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

/** bundleId 로 Xcode Cloud 제품(ciProduct) 찾기. */
async function findProductId(bundleId: string): Promise<string> {
  const doc = await asc("/v1/ciProducts?include=app&limit=200");
  const apps = doc.included ?? [];
  const product = asArray(doc.data).find((p) => {
    const appId = p.relationships?.app?.data?.id;
    const app = apps.find((a) => a.id === appId);
    return app?.attributes?.bundleId === bundleId;
  });
  if (!product) throw new Error(`Xcode Cloud 제품 없음(bundleId=${bundleId})`);
  return product.id;
}

/** 제품의 활성 워크플로 1개 선택. */
async function pickWorkflowId(productId: string): Promise<string> {
  const doc = await asc(`/v1/ciProducts/${productId}/workflows?limit=200`);
  const workflows = asArray(doc.data);
  const chosen = workflows.find((w) => w.attributes?.isEnabled === true) ?? workflows[0];
  if (!chosen) throw new Error("Xcode Cloud 워크플로 없음");
  return chosen.id;
}

/** 태그 이름 → 제품의 primary repository 상 git reference id. */
async function resolveTagRefId(productId: string, tag: string): Promise<string> {
  const repos = await asc(`/v1/ciProducts/${productId}/primaryRepositories?limit=10`);
  const repoId = asArray(repos.data)[0]?.id;
  if (!repoId) throw new Error("Xcode Cloud primary repository 없음");

  const refs = await asc(`/v1/scmRepositories/${repoId}/gitReferences?limit=200`);
  const ref = asArray(refs.data).find(
    (r) => r.attributes?.kind === "TAG" && r.attributes?.name === tag,
  );
  if (!ref) {
    throw new Error(`태그 ref 가 Xcode Cloud 에 아직 동기화되지 않음: ${tag}`);
  }
  return ref.id;
}

/**
 * Xcode Cloud 빌드(archive → TestFlight)를 태그 대상으로 명시적 트리거.
 * 반환: 빌드런 id 와 번호.
 */
export async function triggerXcodeCloudDeploy(opts: {
  bundleId: string;
  tag: string;
}): Promise<{ buildRunId: string; buildNumber: number | null }> {
  const productId = await findProductId(opts.bundleId);
  const [workflowId, refId] = await Promise.all([
    pickWorkflowId(productId),
    resolveTagRefId(productId, opts.tag),
  ]);

  const doc = await asc("/v1/ciBuildRuns", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "ciBuildRuns",
        relationships: {
          workflow: { data: { type: "ciWorkflows", id: workflowId } },
          sourceBranchOrTag: { data: { type: "scmGitReferences", id: refId } },
        },
      },
    }),
  });
  const run = asArray(doc.data)[0];
  const number = run?.attributes?.number;
  return {
    buildRunId: run?.id ?? "",
    buildNumber: typeof number === "number" ? number : null,
  };
}
