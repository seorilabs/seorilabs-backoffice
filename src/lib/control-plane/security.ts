import type { NextRequest } from "next/server";
import { createPublicKey } from "node:crypto";
import { Prisma } from "@prisma/client";
import { GENERIC_WORKER_PRINCIPALS } from "@/lib/control-plane/automation-catalog";
import {
  agentAdapterNonceDigest,
  verifyAgentAdapterAttestation,
  type AgentAdapterAttestationPayload,
} from "@/lib/control-plane/agent-adapter-attestation";
import type { JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";
import { verifyStaticToken } from "@/lib/security";

export type InternalAudience = "control-plane" | "agent-worker" | "agent-adapter";

export interface InternalPrincipal {
  id: string;
  audience: InternalAudience;
  runtimeBindingDigest: string | null;
}

function authorizationBearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  return null;
}

function principalId(request: NextRequest): string | null {
  const value = request.headers.get("x-seori-principal")?.trim() ?? "";
  return /^[A-Za-z0-9._:/-]{1,128}$/.test(value) ? value : null;
}

function configuredAgentWorkerTokens(): ReadonlyMap<string, string> | null {
  const entries = [
    [GENERIC_WORKER_PRINCIPALS.CODEX, process.env.AGENT_WORKER_CODEX_TOKEN?.trim()],
    [GENERIC_WORKER_PRINCIPALS.CLAUDE, process.env.AGENT_WORKER_CLAUDE_TOKEN?.trim()],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  const tokens = entries.map(([, token]) => token);
  const reservedTokens = [
    process.env.CONTROL_PLANE_ADMIN_TOKEN?.trim(),
    process.env.INTERNAL_ADMIN_TOKEN?.trim(),
    process.env.AGENT_TRUSTED_ADAPTER_TOKEN?.trim(),
  ].filter((value): value is string => Boolean(value));
  if (new Set(tokens).size !== tokens.length || tokens.some((token) => reservedTokens.includes(token))) return null;
  return new Map(entries);
}

function configuredTrustedAdapter(): {
  principal: string;
  runtimeIdentity: string;
  token: string;
  publicKey: string;
} | null {
  if (process.env.AGENT_TRUSTED_ADAPTER_DEPLOYED !== "true") return null;
  const principal = process.env.AGENT_TRUSTED_ADAPTER_PRINCIPAL?.trim() ?? "";
  const runtimeIdentity = process.env.AGENT_TRUSTED_ADAPTER_RUNTIME_IDENTITY?.trim() ?? "";
  const token = process.env.AGENT_TRUSTED_ADAPTER_TOKEN?.trim() ?? "";
  const publicKey = process.env.AGENT_TRUSTED_ADAPTER_PUBLIC_KEY?.trim() ?? "";
  const reservedPrincipals = new Set<string>([
    ...Object.values(GENERIC_WORKER_PRINCIPALS),
    process.env.CONTROL_PLANE_ADMIN_PRINCIPAL?.trim() ?? "",
  ].filter(Boolean));
  const reservedTokens = [
    process.env.AGENT_WORKER_CODEX_TOKEN?.trim(),
    process.env.AGENT_WORKER_CLAUDE_TOKEN?.trim(),
    process.env.CONTROL_PLANE_ADMIN_TOKEN?.trim(),
    process.env.INTERNAL_ADMIN_TOKEN?.trim(),
  ].filter((value): value is string => Boolean(value));
  let validPublicKey = false;
  try {
    validPublicKey = createPublicKey(publicKey).asymmetricKeyType === "ed25519";
  } catch {
    validPublicKey = false;
  }
  if (
    !/^[A-Za-z0-9._:/-]{1,128}$/.test(principal)
    || !/^[A-Za-z0-9._:/-]{1,191}$/.test(runtimeIdentity)
    || !token
    || !validPublicKey
    || reservedPrincipals.has(principal)
    || reservedTokens.includes(token)
  ) return null;
  return { principal, runtimeIdentity, token, publicKey };
}

export function trustedMutationAdapterConfigured(): boolean {
  return trustedGithubStepLedgerImplemented() && configuredTrustedAdapter() !== null;
}

/** CREATE_COMMIT/CREATE_REF/CREATE_PR별 durable consume/readback가 도입되기 전에는 READY_PR을 열지 않는다. */
export function trustedGithubStepLedgerImplemented(): boolean {
  return false;
}

export function authenticateInternalRequest(
  request: NextRequest,
  audience: InternalAudience,
): InternalPrincipal | null {
  const id = principalId(request);
  if (!id) return null;
  if (audience === "agent-worker") {
    const expected = configuredAgentWorkerTokens()?.get(id);
    if (!verifyStaticToken(authorizationBearerToken(request), expected)) return null;
    const runtimeBindingDigest = request.headers.get("x-seori-worker-runtime-binding")?.trim() ?? "";
    if (!/^[0-9a-f]{64}$/.test(runtimeBindingDigest)) return null;
    return { id, audience, runtimeBindingDigest };
  } else if (audience === "agent-adapter") {
    const adapter = configuredTrustedAdapter();
    if (!adapter || id !== adapter.principal || !verifyStaticToken(authorizationBearerToken(request), adapter.token)) {
      return null;
    }
  } else {
    const token = authorizationBearerToken(request) ?? request.headers.get("x-admin-token");
    const expected = process.env.CONTROL_PLANE_ADMIN_TOKEN ?? process.env.INTERNAL_ADMIN_TOKEN;
    const expectedPrincipal = process.env.CONTROL_PLANE_ADMIN_PRINCIPAL?.trim();
    const lowerPrivilegePrincipals = new Set<string>([
      ...Object.values(GENERIC_WORKER_PRINCIPALS),
      process.env.AGENT_TRUSTED_ADAPTER_PRINCIPAL?.trim() ?? "",
    ].filter(Boolean));
    const lowerPrivilegeTokens = [
      process.env.AGENT_WORKER_CODEX_TOKEN?.trim(),
      process.env.AGENT_WORKER_CLAUDE_TOKEN?.trim(),
      process.env.AGENT_TRUSTED_ADAPTER_TOKEN?.trim(),
    ].filter((value): value is string => Boolean(value));
    if (
      !expectedPrincipal
      || !expected
      || lowerPrivilegePrincipals.has(expectedPrincipal)
      || lowerPrivilegeTokens.includes(expected.trim())
      || id !== expectedPrincipal
      || !verifyStaticToken(token, expected)
    ) return null;
  }
  return { id, audience, runtimeBindingDigest: null };
}

function publicJson(value: unknown): JsonValue | null {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}

/**
 * seori-auth 내부 control-plane과 같은 경계다. adapter bearer만으로는 실행 runtime을
 * 증명하지 못하므로 60초 Ed25519 route/body attestation과 전역 1회 nonce를 함께 소비한다.
 */
export async function verifyAndConsumeAgentAdapterAttestation(input: {
  request: NextRequest;
  route: string;
  idempotencyKey: string;
  body: unknown;
  now?: Date;
}): Promise<AgentAdapterAttestationPayload | null> {
  const adapter = configuredTrustedAdapter();
  const token = input.request.headers.get("x-seori-adapter-attestation")?.trim() ?? "";
  const body = publicJson(input.body);
  const now = input.now ?? new Date();
  if (!adapter || !token || !body) return null;
  const payload = verifyAgentAdapterAttestation({
    token,
    publicKey: adapter.publicKey,
    route: input.route,
    requestId: input.idempotencyKey,
    body,
    now,
  });
  if (!payload || payload.runtimeIdentity !== adapter.runtimeIdentity) return null;
  try {
    const accepted = await prisma.$transaction(async (tx) => {
      await tx.agentAdapterNonce.deleteMany({ where: { expiresAt: { lte: now } } });
      await tx.agentAdapterNonce.create({
        data: {
          nonceDigest: agentAdapterNonceDigest(payload.nonce),
          route: payload.route,
          bodyDigest: payload.bodyDigest,
          runtimeIdentity: payload.runtimeIdentity,
          expiresAt: new Date(payload.expiresAt),
        },
      });
      return true;
    });
    return accepted ? payload : null;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  }
}

export function requireIdempotencyKey(request: NextRequest): string | null {
  const value = request.headers.get("idempotency-key")?.trim() ?? "";
  return /^[A-Za-z0-9._:/-]{8,191}$/.test(value) ? value : null;
}

export function agentKindForPrincipal(principalId: string): "CODEX" | "CLAUDE" | null {
  if (principalId === GENERIC_WORKER_PRINCIPALS.CODEX) return "CODEX";
  if (principalId === GENERIC_WORKER_PRINCIPALS.CLAUDE) return "CLAUDE";
  return null;
}
