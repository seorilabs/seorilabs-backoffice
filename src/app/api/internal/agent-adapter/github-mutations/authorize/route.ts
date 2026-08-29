import { NextRequest, NextResponse } from "next/server";

import { agentGithubMutationAuthorizeSchema } from "@/lib/control-plane/contracts";
import { authorizeGithubReadyPrMutation } from "@/lib/control-plane/agent-mutation-service";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import {
  authenticateInternalRequest,
  requireIdempotencyKey,
  verifyAndConsumeAgentAdapterAttestation,
} from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/internal/agent-adapter/github-mutations/authorize";

export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "agent-adapter");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  try {
    const rawBody = await request.json();
    const body = agentGithubMutationAuthorizeSchema.parse(rawBody);
    const attestation = await verifyAndConsumeAgentAdapterAttestation({
      request,
      route: ROUTE,
      idempotencyKey,
      body: rawBody,
    });
    if (!attestation) return NextResponse.json({ error: "trusted adapter attestation required" }, { status: 401 });
    const authorization = await authorizeGithubReadyPrMutation({
      ...body,
      adapterPrincipalId: principal.id,
      adapterRuntimeIdentity: attestation.runtimeIdentity,
      idempotencyKey,
    });
    return NextResponse.json({ ok: true, authorization });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
