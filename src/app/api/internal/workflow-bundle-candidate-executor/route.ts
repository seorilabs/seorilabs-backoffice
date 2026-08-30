import { NextRequest, NextResponse } from "next/server";

import { WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_ATTESTATION_ROUTE } from "@/lib/control-plane/agent-adapter-attestation";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import {
  authenticateWorkflowBundleCandidateExecutorRequest,
  requireIdempotencyKey,
  verifyAndConsumeAgentAdapterAttestation,
} from "@/lib/control-plane/security";
import { workflowBundleCandidateExecutorRequestSchema } from "@/lib/control-plane/workflow-bundle-candidate-contract";
import {
  authorizeCandidateMutation,
  claimCandidateExecutor,
  claimCandidateMutationStep,
  completeCandidateMutationStep,
  heartbeatCandidateExecutor,
  planCandidateCommitStep,
  readbackCandidateMutation,
  recoverCandidateMutation,
  settleCandidateExecutor,
  workflowBundleCandidateRuntimeBindingDigest,
} from "@/lib/control-plane/workflow-bundle-candidate-executor-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ROUTE = WORKFLOW_BUNDLE_CANDIDATE_EXECUTOR_ATTESTATION_ROUTE;

export async function POST(request: NextRequest) {
  const principal = authenticateWorkflowBundleCandidateExecutorRequest(request);
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) {
    return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  }
  try {
    const rawBody = await request.json();
    const body = workflowBundleCandidateExecutorRequestSchema.parse(rawBody);
    const attestation = await verifyAndConsumeAgentAdapterAttestation({
      request,
      route: ROUTE,
      idempotencyKey,
      body: rawBody,
      deploymentGate: "workflow-bundle-candidate",
    });
    if (!attestation) {
      return NextResponse.json({ error: "trusted candidate executor attestation required" }, { status: 401 });
    }
    const identity = {
      adapterPrincipalId: principal.id,
      adapterRuntimeIdentity: attestation.runtimeIdentity,
      runtimeBindingDigest: workflowBundleCandidateRuntimeBindingDigest({
        adapterPrincipalId: principal.id,
        adapterRuntimeIdentity: attestation.runtimeIdentity,
      }),
      idempotencyKey,
    };
    switch (body.operation) {
      case "CLAIM":
        return NextResponse.json({ ok: true, claim: await claimCandidateExecutor(identity) });
      case "HEARTBEAT":
        return NextResponse.json({
          ok: true,
          heartbeat: await heartbeatCandidateExecutor({ ...identity, ...body }),
        });
      case "AUTHORIZE":
        return NextResponse.json({
          ok: true,
          authorization: await authorizeCandidateMutation({ ...identity, ...body }),
        });
      case "RECOVERY":
        return NextResponse.json({
          ok: true,
          recovery: await recoverCandidateMutation({ ...identity, sessionId: body.sessionId }),
        });
      case "STEP_CLAIM":
        return NextResponse.json({
          ok: true,
          step: await claimCandidateMutationStep({ ...identity, ...body }),
        });
      case "STEP_PLAN":
        return NextResponse.json({
          ok: true,
          plan: await planCandidateCommitStep({ ...identity, ...body }),
        });
      case "STEP_COMPLETE":
        return NextResponse.json({
          ok: true,
          completion: await completeCandidateMutationStep({ ...identity, ...body }),
        });
      case "READBACK":
        return NextResponse.json({
          ok: true,
          readback: await readbackCandidateMutation({ ...identity, ...body }),
        });
      case "SETTLE":
        return NextResponse.json({
          ok: true,
          settlement: await settleCandidateExecutor({ ...identity, ...body }),
        });
    }
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
