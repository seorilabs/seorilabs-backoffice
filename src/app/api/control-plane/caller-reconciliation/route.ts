import { NextRequest, NextResponse } from "next/server";

import {
  planApprovedCallerReconciliation,
} from "@/lib/control-plane/approved-caller-reconciler";
import { controlPlaneErrorResponse } from "@/lib/control-plane/http";
import { authenticateInternalRequest } from "@/lib/control-plane/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPOSITORY_ID = /^[1-9][0-9]{0,31}$/u;

/**
 * 승인 번들이 정한 caller와 저장소의 현재 caller가 맞는지 계획한다. 이 경로는 읽기 전용이며
 * 저장소를 바꾸지 않는다. PR 생성은 신뢰 실행기가 이 계획을 받아 수행한다.
 */
export async function GET(request: NextRequest) {
  const principal = authenticateInternalRequest(request, "control-plane");
  if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const repositoryId = request.nextUrl.searchParams.get("repositoryId");
  if (repositoryId !== null && !REPOSITORY_ID.test(repositoryId)) {
    return NextResponse.json({ error: "invalid repositoryId" }, { status: 400 });
  }
  try {
    // GitHub client는 요청 처리 시점에만 불러온다. 모듈 로드만으로 octokit 전체를 끌어오지
    // 않아 route를 인증·입력 검사 단위로 검사할 수 있다.
    const { readRepositoryFile } = await import("@/lib/github/repository-file");
    const verdicts = await planApprovedCallerReconciliation({
      ...(repositoryId === null ? {} : { repositoryId }),
      signingKey: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "",
      snapshotSignatureKeyId: process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY_ID ?? "",
      snapshotSignaturePolicyRevision:
        process.env.CONTROL_PLANE_SNAPSHOT_SIGNATURE_POLICY_REVISION ?? "",
    }, undefined, {
      trustedApprovalKeysJson:
        process.env.WORKFLOW_BUNDLE_V5_APPROVAL_PUBLIC_KEYS_JSON ?? "",
      readRepositoryCaller: readRepositoryFile,
    });
    return NextResponse.json({
      summary: {
        inSync: verdicts.filter((verdict) => verdict.state === "IN_SYNC").length,
        pullRequestRequired:
          verdicts.filter((verdict) => verdict.state === "PULL_REQUEST_REQUIRED").length,
        skipped: verdicts.filter((verdict) => verdict.state === "SKIPPED").length,
      },
      verdicts,
    });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
