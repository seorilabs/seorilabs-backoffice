import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

import { GENERIC_WORKER_PRINCIPALS } from "@/lib/control-plane/automation-catalog";
import { containsCredentialCandidate } from "@/lib/control-plane/contracts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,190}$/;
const FORBIDDEN_RESPONSE_KEYS = new Set([
  "actiontoken",
  "accesstoken",
  "apikey",
  "authorization",
  "bearer",
  "clientsecret",
  "cookie",
  "granttoken",
  "leasetoken",
  "password",
  "privatekey",
  "recoverycode",
  "refreshtoken",
  "secret",
  "sessioncookie",
  "token",
  "capability",
  "totp",
  "totpseed",
]);
const PUBLIC_SESSION_ID = /^agent-session:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const workerPrincipalSchema = z.enum([
  GENERIC_WORKER_PRINCIPALS.CODEX,
  GENERIC_WORKER_PRINCIPALS.CLAUDE,
]);

export type WorkerPrincipal = z.infer<typeof workerPrincipalSchema>;

export const seoriAuthPublicRequestSchema = z.object({
  requestId: z.string().regex(IDENTIFIER),
  operation: z.enum([
    "CLAIM",
    "HEARTBEAT",
    "COMPLETE",
    "FAIL",
    "READBACK_REQUIRED",
    "READBACK_RESOLVE",
    "GITHUB_READY_PR",
  ]),
  body: z.unknown(),
}).strict();

export type SeoriAuthPublicRequest = z.infer<typeof seoriAuthPublicRequestSchema>;

/** URL의 path나 userinfo를 허용하지 않아 look-alike endpoint로 credential이 나가지 않게 한다. */
export function parseExactHttpsOrigin(value: string): URL {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:"
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
    || origin.username
    || origin.password
  ) throw new Error("SEORI_AUTH_HTTPS_ORIGIN_INVALID");
  return origin;
}

/**
 * Kubernetes projected Secret의 ..data symlink는 허용하되, 고정 root 밖으로 나가는
 * symlink와 world-readable 파일은 거부한다. 반환 Buffer는 호출자가 반드시 zeroize한다.
 */
export async function readBoundSecretFile(input: {
  root: string;
  relativePath: string;
  allowGroupRead?: boolean;
  maxBytes?: number;
}): Promise<Buffer> {
  if (!input.relativePath || input.relativePath.startsWith("/") || input.relativePath.split("/").includes("..")) {
    throw new Error("SEORI_AUTH_SECRET_PATH_INVALID");
  }
  const rootPath = await realpath(input.root);
  const candidate = resolve(rootPath, input.relativePath);
  const parentPath = await realpath(dirname(candidate));
  const lexicalParent = relative(rootPath, parentPath);
  if (lexicalParent === ".." || lexicalParent.startsWith(`..${sep}`) || isAbsoluteRelative(lexicalParent)) {
    throw new Error("SEORI_AUTH_SECRET_PATH_ESCAPE");
  }
  await lstat(candidate);
  const resolved = await realpath(candidate);
  const relativeTarget = relative(rootPath, resolved);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsoluteRelative(relativeTarget)) {
    throw new Error("SEORI_AUTH_SECRET_TARGET_ESCAPE");
  }
  const metadata = await stat(resolved);
  if (!metadata.isFile() || (metadata.mode & 0o007) !== 0 || (!input.allowGroupRead && (metadata.mode & 0o070) !== 0)) {
    throw new Error("SEORI_AUTH_SECRET_FILE_UNSAFE");
  }
  const value = await readFile(resolved);
  if (value.length === 0 || value.length > (input.maxBytes ?? 64 * 1024)) {
    value.fill(0);
    throw new Error("SEORI_AUTH_SECRET_FILE_SIZE_INVALID");
  }
  return value;
}

export async function withBoundSecretText<T>(input: {
  root: string;
  relativePath: string;
  allowGroupRead?: boolean;
  maxBytes?: number;
}, callback: (secret: string) => Promise<T>): Promise<T> {
  const value = await readBoundSecretFile(input);
  try {
    let end = value.length;
    while (end > 0 && (value[end - 1] === 0x0a || value[end - 1] === 0x0d)) end -= 1;
    if (end === 0 || value.subarray(0, end).some((byte) => byte === 0 || byte < 0x20 || byte === 0x7f)) {
      throw new Error("SEORI_AUTH_SECRET_TEXT_INVALID");
    }
    return await callback(value.subarray(0, end).toString("utf8"));
  } finally {
    value.fill(0);
  }
}

function isAbsoluteRelative(value: string): boolean {
  return value.startsWith(sep);
}

function assertPublicNode(value: unknown, path: string, key?: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPublicNode(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
      if (FORBIDDEN_RESPONSE_KEYS.has(normalized)) throw new Error("SEORI_AUTH_PRIVATE_RESPONSE_FIELD");
      assertPublicNode(entry, `${path}.${key}`, key);
    }
    return;
  }
  if (
    typeof value === "string"
    && !(key === "sessionId" && PUBLIC_SESSION_ID.test(value))
    && containsCredentialCandidate(value)
  ) {
    throw new Error(`SEORI_AUTH_PRIVATE_RESPONSE_VALUE:${path}`);
  }
}

/** 모델로 반환하기 직전 모든 helper/adapter 응답에 적용한다. */
export function assertPublicAgentResponse<T>(value: T): T {
  assertPublicNode(value, "response");
  return value;
}

/** 응답 검증이나 직렬화가 실패해도 runtime 요청 핸들러 밖으로 예외를 전파하지 않는다. */
export function serializePublicAgentResponse(statusCode: number, value: unknown): {
  statusCode: number;
  body: Buffer;
} {
  const unavailable = () => Buffer.from(
    '{"error":{"code":"SEORI_AUTH_RUNTIME_UNAVAILABLE"}}',
    "utf8",
  );
  if (statusCode >= 500) return { statusCode, body: unavailable() };
  try {
    const serialized = JSON.stringify(assertPublicAgentResponse(value));
    if (serialized === undefined) throw new Error("SEORI_AUTH_PUBLIC_RESPONSE_UNSERIALIZABLE");
    return { statusCode, body: Buffer.from(serialized, "utf8") };
  } catch {
    return { statusCode: 500, body: unavailable() };
  }
}

export function workerIdentityFromMtlsPeer(input: {
  subjectAltName: string | undefined;
  fingerprint256: string | undefined;
  serialNumber: string | undefined;
  codexSpiffePrefix: string;
  claudeSpiffePrefix: string;
}): { principal: WorkerPrincipal; runtimeBindingDigest: string; spiffeId: string } {
  const prefixes = new Map<string, WorkerPrincipal>([
    [input.codexSpiffePrefix, GENERIC_WORKER_PRINCIPALS.CODEX],
    [input.claudeSpiffePrefix, GENERIC_WORKER_PRINCIPALS.CLAUDE],
  ] as const);
  if (prefixes.size !== 2 || !input.subjectAltName?.startsWith("URI:")) {
    throw new Error("SEORI_AUTH_WORKER_SPIFFE_ID_MISMATCH");
  }
  const spiffeId = input.subjectAltName.slice("URI:".length);
  const matching = [...prefixes.entries()].filter(([prefix]) => {
    try {
      const parsed = new URL(prefix);
      return parsed.protocol === "spiffe:"
        && !parsed.search
        && !parsed.hash
        && prefix.endsWith("/instance")
        && new RegExp(`^${escapeRegex(prefix)}/[A-Za-z0-9][A-Za-z0-9.-]{15,63}$`, "u").test(spiffeId);
    } catch {
      return false;
    }
  });
  if (matching.length !== 1) throw new Error("SEORI_AUTH_WORKER_SPIFFE_ID_MISMATCH");
  if (
    !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/iu.test(input.fingerprint256 ?? "")
    || !/^[0-9A-F]{2,64}$/iu.test(input.serialNumber ?? "")
  ) throw new Error("SEORI_AUTH_WORKER_CERTIFICATE_BINDING_INVALID");
  const principal = matching[0][1];
  const runtimeBindingDigest = createHash("sha256").update(JSON.stringify({
    version: 1,
    principal,
    spiffeId,
    fingerprint256: input.fingerprint256!.toUpperCase(),
    serialNumber: input.serialNumber!.toUpperCase(),
  }), "utf8").digest("hex");
  return { principal, runtimeBindingDigest, spiffeId };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function agentKindForWorkerPrincipal(principal: WorkerPrincipal): "CODEX" | "CLAUDE" {
  return principal === GENERIC_WORKER_PRINCIPALS.CODEX ? "CODEX" : "CLAUDE";
}
