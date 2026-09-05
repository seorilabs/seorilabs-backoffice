import { APPROVED_CALLER_PATH } from "@/lib/control-plane/approved-caller-reconciliation-contract";
import { contractCanonicalJson, type JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";
import {
  ControlPlaneError,
  resolveWorkflowBindingForRepository,
} from "@/lib/control-plane/service";
import {
  readWorkflowBundleRegistryRecords,
  verifyApprovedBundle,
} from "@/lib/control-plane/workflow-bundle-v5-registry";


/**
 * caller 내용은 중앙 계약 구현이 만든다. 그 구현은 top-level await를 쓰는 ESM이라 Next
 * 서버 번들에 들어가지 못하고, 여기서 규칙을 복제하면 계약과 조용히 갈라진다. 그래서 이
 * 경로는 계약이 필요로 하는 입력만 만들고, caller 생성과 비교는 신뢰 실행기가 한다.
 */
export type CallerReconciliationTarget = {
  repositoryId: string;
  fullName: string;
  defaultBranch: string;
  sourceRef: string;
  sourceSha: string;
  callerPath: string;
  resolvedManifest: unknown;
};

export type CallerReconciliationVerdict =
  | ({ state: "ELIGIBLE"; reasonCode: null } & CallerReconciliationTarget)
  | {
      state: "SKIPPED";
      reasonCode: string;
      repositoryId: string;
      fullName: string;
      callerPath: string;
    };

export type ApprovedCallerReconciliationPlan = {
  approvedBundle: {
    registryRecordId: string;
    sourceSha: string;
    payloadDigest: string;
    approvalKeyId: string;
    bundle: Record<string, unknown>;
  };
  callerPath: string;
  verdicts: CallerReconciliationVerdict[];
};

type ReconcilerClient = Pick<
  typeof prisma,
  "app" | "configRevision" | "discoveryObservation" | "repositoryRegistration"
  | "workflowBundleRegistryRecord" | "$transaction"
>;

export type ApprovedCallerReconcilerDependencies = {
  trustedApprovalKeysJson: string;
  /** 기본값은 registry의 서명 검증이다. 테스트만 대체한다. */
  verifyApprovedBundle?: typeof verifyApprovedBundle;
  /** 기본값은 계약이 받는 resolved binding 구성이다. 테스트만 대체한다. */
  resolveManifest?: typeof resolveWorkflowBindingForRepository;
};

/** registry의 번들은 JSON 객체다. 다른 형태면 caller 입력으로 쓸 수 없으므로 막는다. */
function workflowBundleObject(bundle: unknown): Record<string, unknown> {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new ControlPlaneError(
      "승인된 WorkflowBundle 본문이 객체가 아닙니다.",
      409,
      "APPROVED_WORKFLOW_BUNDLE_SHAPE_INVALID",
    );
  }
  return bundle as Record<string, unknown>;
}

function skipped(
  repositoryId: string,
  fullName: string,
  reasonCode: string,
): CallerReconciliationVerdict {
  return {
    state: "SKIPPED",
    reasonCode,
    repositoryId,
    fullName,
    callerPath: APPROVED_CALLER_PATH,
  };
}

export async function planApprovedCallerReconciliation(input: {
  repositoryId?: string;
  signingKey: string;
  snapshotSignatureKeyId: string;
  snapshotSignaturePolicyRevision: string;
  now?: Date;
}, client: ReconcilerClient = prisma,
  dependencies: ApprovedCallerReconcilerDependencies,
): Promise<ApprovedCallerReconciliationPlan> {
  const approvedRecords = (await readWorkflowBundleRegistryRecords(null, client))
    .filter((record) => record.approvalState === "APPROVED");
  if (approvedRecords.length === 0) {
    throw new ControlPlaneError(
      "승인된 WorkflowBundle이 없습니다.",
      409,
      "NO_APPROVED_WORKFLOW_BUNDLE",
    );
  }
  if (approvedRecords.length > 1) {
    throw new ControlPlaneError(
      "승인된 WorkflowBundle이 하나가 아닙니다.",
      409,
      "AMBIGUOUS_APPROVED_WORKFLOW_BUNDLE",
    );
  }
  const record = approvedRecords[0]!;
  const verify = dependencies.verifyApprovedBundle ?? verifyApprovedBundle;
  try {
    verify(record.bundle, dependencies.trustedApprovalKeysJson);
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw new ControlPlaneError(
      "승인된 WorkflowBundle을 신뢰할 수 없습니다.",
      409,
      "APPROVED_WORKFLOW_BUNDLE_UNTRUSTED",
    );
  }
  const resolveManifest =
    dependencies.resolveManifest ?? resolveWorkflowBindingForRepository;

  const apps = await client.app.findMany({
    where: {
      ...(input.repositoryId === undefined
        ? {}
        : { repoId: BigInt(input.repositoryId) }),
    },
    select: { id: true, repoId: true, repoFullName: true, status: true },
  });

  const verdicts: CallerReconciliationVerdict[] = [];
  for (const app of apps) {
    // repoId가 없는 App은 GitHub 저장소에 결합되지 않아 caller 대상이 아니다.
    if (app.repoId === null) continue;
    const repoId = app.repoId;
    const repositoryId = repoId.toString();
    const registration = await client.repositoryRegistration.findUnique({
      where: { repoId },
      select: { defaultBranch: true, archived: true, classification: true },
    });
    if (!registration || registration.archived) {
      verdicts.push(skipped(repositoryId, app.repoFullName, "REPOSITORY_NOT_REGISTERED"));
      continue;
    }
    if (registration.classification !== "PRODUCT_APP") {
      verdicts.push(skipped(repositoryId, app.repoFullName, "REPOSITORY_NOT_PRODUCT_APP"));
      continue;
    }
    if (app.status !== "ACTIVE") {
      verdicts.push(skipped(repositoryId, app.repoFullName, "APP_NOT_ACTIVE"));
      continue;
    }
    const sourceRef = `refs/heads/${registration.defaultBranch}`;
    const discovery = await client.discoveryObservation.findFirst({
      where: { appId: app.id, sourceRef },
      orderBy: { createdAt: "desc" },
      select: { sourceSha: true },
    });
    const sourceSha = discovery?.sourceSha;
    if (!sourceSha) {
      verdicts.push(skipped(repositoryId, app.repoFullName, "NO_DEFAULT_BRANCH_DISCOVERY"));
      continue;
    }

    try {
      const readback = await resolveManifest({
        selector: {
          repositoryId,
          bindingSourceSha: sourceSha,
          applicationSourceSha: sourceSha,
          workflowBundleSha: record.sourceSha,
        },
        app: { id: app.id, repoFullName: app.repoFullName, status: app.status },
        expectedSourceRef: sourceRef,
        signingKey: input.signingKey,
        snapshotSignatureKeyId: input.snapshotSignatureKeyId,
        snapshotSignaturePolicyRevision: input.snapshotSignaturePolicyRevision,
        now: input.now,
      }, client);
      verdicts.push({
        state: "ELIGIBLE",
        reasonCode: null,
        repositoryId,
        fullName: app.repoFullName,
        defaultBranch: registration.defaultBranch ?? "",
        sourceRef,
        sourceSha,
        callerPath: APPROVED_CALLER_PATH,
        resolvedManifest: readback,
      });
    } catch (error) {
      verdicts.push(skipped(
        repositoryId,
        app.repoFullName,
        error instanceof ControlPlaneError ? error.code : "MANIFEST_RESOLUTION_FAILED",
      ));
    }
  }
  return {
    approvedBundle: {
      registryRecordId: record.id,
      sourceSha: record.sourceSha,
      payloadDigest: record.payloadDigest,
      approvalKeyId: record.approvalKeyId ?? "",
      bundle: workflowBundleObject(record.bundle),
    },
    callerPath: APPROVED_CALLER_PATH,
    verdicts,
  };
}

export function callerReconciliationDigest(
  plan: ApprovedCallerReconciliationPlan,
): string {
  return contractCanonicalJson(plan.verdicts as unknown as JsonValue);
}
