import type { NextRequest } from "next/server";
import { verifyStaticToken } from "@/lib/security";

export type InternalAudience = "control-plane" | "agent-worker";

export interface InternalPrincipal {
  id: string;
  audience: InternalAudience;
}

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  return request.headers.get("x-admin-token");
}

function principalId(request: NextRequest): string | null {
  const value = request.headers.get("x-seori-principal")?.trim() ?? "";
  return /^[A-Za-z0-9._:/-]{1,128}$/.test(value) ? value : null;
}

export function authenticateInternalRequest(
  request: NextRequest,
  audience: InternalAudience,
): InternalPrincipal | null {
  const expected = audience === "agent-worker"
    ? process.env.AGENT_WORKER_TOKEN
    : process.env.CONTROL_PLANE_ADMIN_TOKEN ?? process.env.INTERNAL_ADMIN_TOKEN;
  const token = bearerToken(request);
  const id = principalId(request);
  if (!id || !verifyStaticToken(token, expected)) return null;
  return { id, audience };
}

export function requireIdempotencyKey(request: NextRequest): string | null {
  const value = request.headers.get("idempotency-key")?.trim() ?? "";
  return /^[A-Za-z0-9._:/-]{8,191}$/.test(value) ? value : null;
}
