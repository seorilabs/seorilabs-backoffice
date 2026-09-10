import { z } from "zod";

import { repositoryAutomationEligible } from "@/lib/control-plane/repository-registration";
import { ControlPlaneError, resolveWorkflowBindingForRepository } from "@/lib/control-plane/service";
import {
  publicWorkflowBundleRegistryRecord,
  verifyWorkflowBundleRegistryReadback,
} from "@/lib/control-plane/workflow-bundle-v5-registry";
import { prisma } from "@/lib/prisma";

const STATIC_CANDIDATES = {
  "1335099739": { fullName: "seorilabs/saju-reader", profile: "capacitor" },
  "1250442131": { fullName: "seorilabs/happy-farm", profile: "react-native" },
  "1265192029": { fullName: "seorilabs/lizard-tycoon", profile: "godot" },
} as const;

export const candidateStaticBindingQuerySchema = z.object({
  repositoryId: z.enum(["1335099739", "1250442131", "1265192029"]),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/u),
  workflowBundleRecordId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/u),
  workflowBundleSha: z.string().regex(/^[0-9a-f]{40}$/u),
  workflowBundleDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
}).strict();

export type CandidateStaticBindingQuery = z.infer<typeof candidateStaticBindingQuerySchema>;

type Client = Pick<typeof prisma,
  "app" | "repositoryRegistration" | "workflowBundleRegistryRecord"
  | "configRevision" | "discoveryObservation">;

/**
 * 허용된 세 앱의 static 후보 caller 생성에 필요한 서버 검증 envelope만 반환한다.
 * ACTIVE 변경, 실행 대기열, Android canary 권한을 만들지 않는다.
 */
export async function readCandidateStaticBinding(
  query: CandidateStaticBindingQuery,
  options: {
    signingKey: string;
    snapshotSignatureKeyId: string;
    snapshotSignaturePolicyRevision: string;
    now?: Date;
  },
  client: Client = prisma,
) {
  const input = candidateStaticBindingQuerySchema.parse(query);
  const repoId = BigInt(input.repositoryId);
  const allowed = STATIC_CANDIDATES[input.repositoryId];
  const [app, registration, record] = await Promise.all([
    client.app.findUnique({ where: { repoId } }),
    client.repositoryRegistration.findUnique({ where: { repoId } }),
    client.workflowBundleRegistryRecord.findUnique({ where: { id: input.workflowBundleRecordId } }),
  ]);
  if (!app || !registration || !record) {
    throw new ControlPlaneError("후보 caller에 필요한 앱·저장소·번들 기록이 없습니다.", 404, "CANDIDATE_STATIC_BINDING_NOT_FOUND");
  }
  if (app.repoId !== repoId || app.repoFullName !== allowed.fullName || app.status !== "ACTIVE"
    || registration.repoId !== repoId || registration.repoFullName !== allowed.fullName
    || registration.classification !== "PRODUCT_APP" || !repositoryAutomationEligible(registration)
    || registration.defaultBranch !== "main" || registration.lastDefaultPushSha !== input.sourceSha) {
    throw new ControlPlaneError("현재 main 관측과 ACTIVE 앱이 일치해야 합니다.", 409, "CANDIDATE_STATIC_REPOSITORY_MISMATCH");
  }
  if (record.approvalState !== "CANDIDATE" || record.sourceSha !== input.workflowBundleSha
    || record.workflowExecutionSha !== input.workflowBundleSha || record.payloadDigest !== input.workflowBundleDigest) {
    throw new ControlPlaneError("요청한 후보 번들 기록과 SHA·digest가 일치하지 않습니다.", 409, "CANDIDATE_STATIC_BUNDLE_MISMATCH");
  }
  // CANDIDATE 분기는 승인 키 없이도 기존 import의 artifact·request·본문 integrity를 재검증한다.
  const candidate = verifyWorkflowBundleRegistryReadback(record, "");
  if (!candidate.promotionScope.staticProfiles.includes(allowed.profile)
    || candidate.staticProfiles[allowed.profile]?.runtime !== allowed.profile
    || candidate.staticProfiles[allowed.profile].path !== (allowed.profile === "godot" ? ".github/workflows/godot-checks-v3.yml" : ".github/workflows/js-static-checks-v1.yml")) {
    throw new ControlPlaneError("후보 번들에 대상 앱의 static 실행이 없습니다.", 409, "CANDIDATE_STATIC_PROFILE_MISMATCH");
  }
  // 이 서비스가 서명 검증·exact source discovery·감사 예외 만료와 hash를 기존 실행 규칙으로 확인한다.
  const binding = await resolveWorkflowBindingForRepository({
    selector: {
      repositoryId: input.repositoryId,
      bindingSourceSha: input.sourceSha,
      applicationSourceSha: input.sourceSha,
      workflowBundleSha: input.workflowBundleSha,
    },
    app: { id: app.id, repoFullName: app.repoFullName, status: app.status },
    expectedSourceRef: "refs/heads/main",
    ...options,
  }, client);
  if (binding.manifest.staticBinding.profile !== allowed.profile
    || binding.manifest.workflowBundleBinding.sourceSha !== input.workflowBundleSha
    || binding.manifest.workflowBundleBinding.payloadDigest !== input.workflowBundleDigest) {
    throw new ControlPlaneError("ACTIVE 설정의 프로필·번들 결합이 후보와 일치하지 않습니다.", 409, "CANDIDATE_STATIC_ACTIVE_BINDING_MISMATCH");
  }
  return {
    scope: "STATIC_CHECK" as const,
    callerPath: ".github/workflows/org-contract.yml" as const,
    candidate: {
      ...publicWorkflowBundleRegistryRecord(record),
      artifactRunAttempt: record.artifactRunAttempt,
    },
    binding,
    mutationAttempted: false as const,
  };
}
