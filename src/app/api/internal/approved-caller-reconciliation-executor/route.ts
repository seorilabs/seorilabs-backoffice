import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import {
  authenticateTrustedExecutorRequest,
  requireIdempotencyKey,
  verifyAndConsumeAgentAdapterAttestation,
} from "@/lib/control-plane/security";
import { APPROVED_CALLER_RECONCILIATION_EXECUTOR_ATTESTATION_ROUTE } from "@/lib/control-plane/trusted-executor-bindings";
import {
  trustedBundleVerifyOperationSchema,
  trustedMutationExecutorOperationSchemas,
} from "@/lib/control-plane/trusted-mutation-executor-contract";
import {
  approvedCallerReconciliationRuntimeBindingDigest,
  authorizeApprovedCallerMutation,
  claimApprovedCallerExecutor,
  claimApprovedCallerMutationStep,
  completeApprovedCallerMutationStep,
  heartbeatApprovedCallerExecutor,
  planApprovedCallerCommitStep,
  readbackApprovedCallerMutation,
  recoverApprovedCallerMutation,
  settleApprovedCallerExecutor,
  verifyApprovedCallerBundleForSession,
} from "@/lib/control-plane/approved-caller-reconciliation-executor-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ROUTE = APPROVED_CALLER_RECONCILIATION_EXECUTOR_ATTESTATION_ROUTE;

const requestSchema = z.discriminatedUnion("operation", [
  ...trustedMutationExecutorOperationSchemas,
  trustedBundleVerifyOperationSchema,
]);

export async function POST(request: NextRequest) {
  const principal = authenticateTrustedExecutorRequest(request, "approved-caller-reconciliation");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) {
    return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  }
  try {
    const rawBody = await request.json();
    const body = requestSchema.parse(rawBody);
    const attestation = await verifyAndConsumeAgentAdapterAttestation({
      request,
      route: ROUTE,
      idempotencyKey,
      body: rawBody,
      deploymentGate: "approved-caller-reconciliation",
    });
    if (!attestation) {
      return NextResponse.json(
        { error: "trusted approved caller executor attestation required" },
        { status: 401 },
      );
    }
    const identity = {
      adapterPrincipalId: principal.id,
      adapterRuntimeIdentity: attestation.runtimeIdentity,
      runtimeBindingDigest: approvedCallerReconciliationRuntimeBindingDigest({
        adapterPrincipalId: principal.id,
        adapterRuntimeIdentity: attestation.runtimeIdentity,
      }),
      idempotencyKey,
    };
    switch (body.operation) {
      case "CLAIM":
        return NextResponse.json({ ok: true, claim: await claimApprovedCallerExecutor(identity) });
      case "HEARTBEAT":
        return NextResponse.json({
          ok: true,
          heartbeat: await heartbeatApprovedCallerExecutor({ ...identity, ...body }),
        });
      case "BUNDLE_VERIFY":
        return NextResponse.json({
          ok: true,
          verification: await verifyApprovedCallerBundleForSession({ ...identity, ...body }),
        });
      case "AUTHORIZE":
        return NextResponse.json({
          ok: true,
          authorization: await authorizeApprovedCallerMutation({ ...identity, ...body }),
        });
      case "RECOVERY":
        return NextResponse.json({
          ok: true,
          recovery: await recoverApprovedCallerMutation({ ...identity, sessionId: body.sessionId }),
        });
      case "STEP_CLAIM":
        return NextResponse.json({
          ok: true,
          step: await claimApprovedCallerMutationStep({ ...identity, ...body }),
        });
      case "STEP_PLAN":
        return NextResponse.json({
          ok: true,
          plan: await planApprovedCallerCommitStep({ ...identity, ...body }),
        });
      case "STEP_COMPLETE":
        return NextResponse.json({
          ok: true,
          completion: await completeApprovedCallerMutationStep({ ...identity, ...body }),
        });
      case "READBACK":
        return NextResponse.json({
          ok: true,
          readback: await readbackApprovedCallerMutation({ ...identity, ...body }),
        });
      case "SETTLE":
        return NextResponse.json({
          ok: true,
          settlement: await settleApprovedCallerExecutor({ ...identity, ...body }),
        });
    }
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
