import { NextRequest, NextResponse } from "next/server";

import { planApprovedCallerReconciliation } from "@/lib/control-plane/approved-caller-reconciler";
import { approvedCallerReconciliationExecutionRequestSchema } from "@/lib/control-plane/approved-caller-reconciliation-contract";
import {
  enqueueApprovedCallerReconciliation,
  planApprovedCallerReconciliationExecution,
} from "@/lib/control-plane/approved-caller-reconciliation-service";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest, requireIdempotencyKey } from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPOSITORY_ID = /^[1-9][0-9]{0,31}$/u;

/**
 * 승인 번들 caller를 만들기 위한 입력과 대상 적격 여부를 계획한다. 읽기 전용이며 저장소를
 * 바꾸지 않는다. caller 생성과 PR은 이 계획을 받는 신뢰 실행기가 수행한다.
 */
export async function GET(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const repositoryId = request.nextUrl.searchParams.get("repositoryId");
  if (repositoryId !== null && !REPOSITORY_ID.test(repositoryId)) {
    return NextResponse.json({ error: "invalid repositoryId" }, { status: 400 });
  }
  try {
    const plan = await planApprovedCallerReconciliation({
      ...(repositoryId === null ? {} : { repositoryId }),
      signingKey: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "",
      snapshotSignatureKeyId: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY_ID ?? "",
      snapshotSignaturePolicyRevision:
        process.env.CONTROL_PLANE_SNAPSHOT_SIGNATURE_POLICY_REVISION ?? "",
    }, undefined, {
      trustedApprovalKeysJson:
        process.env.WORKFLOW_BUNDLE_V5_APPROVAL_PUBLIC_KEYS_JSON ?? "",
    });
    return NextResponse.json({
      approvedBundle: {
        registryRecordId: plan.approvedBundle.registryRecordId,
        sourceSha: plan.approvedBundle.sourceSha,
        payloadDigest: plan.approvedBundle.payloadDigest,
        approvalKeyId: plan.approvedBundle.approvalKeyId,
        bundle: plan.approvedBundle.bundle,
      },
      callerPath: plan.callerPath,
      summary: {
        eligible: plan.verdicts.filter((verdict) => verdict.state === "ELIGIBLE").length,
        skipped: plan.verdicts.filter((verdict) => verdict.state === "SKIPPED").length,
      },
      verdicts: plan.verdicts,
    });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}

/**
 * 계획을 실행 큐에 올린다. caller 생성과 PR은 여기서 하지 않고 신뢰 실행기가 계약을 불러
 * 수행한다. ENQUEUE는 이 시점의 적격 판정과 GitHub App capability를 함께 고정한다.
 */
export async function POST(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const idempotencyKey = requireIdempotencyKey(request);
  if (!idempotencyKey) {
    return NextResponse.json({ error: "valid Idempotency-Key required" }, { status: 400 });
  }
  try {
    const body = approvedCallerReconciliationExecutionRequestSchema.parse(await request.json());
    if (body.mode === "PLAN") {
      return NextResponse.json({
        ok: true,
        ...await planApprovedCallerReconciliationExecution(body.repositoryId),
      });
    }
    const enqueued = await enqueueApprovedCallerReconciliation({
      repositoryId: body.repositoryId,
      actor: principal.id,
      idempotencyKey,
    });
    return NextResponse.json({ ok: true, ...(enqueued as Record<string, unknown>) });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
