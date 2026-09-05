import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { contractCanonicalJson, type JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";
import {
  ControlPlaneError,
  resolveStaticRuntimeManifestForRepository,
} from "@/lib/control-plane/service";
import {
  readWorkflowBundleRegistryRecords,
  verifyApprovedBundle,
} from "@/lib/control-plane/workflow-bundle-v5-registry";

const CALLER_PATH = ".github/workflows/org-contract.yml";

/**
 * 승인 번들 caller는 중앙 계약 구현이 만든다. 여기서 같은 규칙을 다시 쓰면 계약과 조용히
 * 갈라진다. 계약 구현은 설치된 패키지 루트에서 자기 스키마를 읽으므로 그 경로를 넘긴다.
 */
export function contractRepoRoot(): string {
  const require = createRequire(import.meta.url);
  // exports 맵이 package.json을 노출하지 않으므로 열린 모듈에서 위로 올라가며 계약 루트를
  // 찾는다. 계약 루트는 스키마가 있는 디렉터리다.
  let current = dirname(require.resolve("seorilabs-org-contracts/repo-contract/workflow-bundle-v5"));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, "contracts/workflow-bundle-v5.schema.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new ControlPlaneError(
    "설치된 org contracts에서 계약 루트를 찾지 못했습니다.",
    500,
    "CONTRACT_ROOT_NOT_FOUND",
  );
}

export type CallerReconciliationVerdict = {
  repositoryId: string;
  fullName: string;
  state: "IN_SYNC" | "PULL_REQUEST_REQUIRED" | "SKIPPED";
  reasonCode: string | null;
  callerPath: string;
  desiredCaller: string | null;
};

type ReconcilerClient = Pick<
  typeof prisma,
  "app" | "configRevision" | "discoveryObservation" | "repositoryRegistration"
  | "workflowBundleRegistryRecord" | "$transaction"
>;

/**
 * 중앙 계약 구현. 기본값은 설치된 패키지를 늦게 불러온다. 이 모듈은 top-level await를 쓰는
 * ESM이라 CJS로 변환하는 테스트 러너가 읽지 못하므로, 주입 지점을 두어 계약 규칙을 복제하지
 * 않고도 계획 로직만 따로 검사할 수 있게 한다.
 */
export type WorkflowBundleContract = {
  loadApprovedWorkflowBundleV5: (
    bundle: unknown,
    options: { trustedApprovalVerifier: (request: unknown) => Promise<unknown> },
  ) => Promise<object>;
  loadResolvedWorkflowBindingV5: (
    repositoryContext: { repositoryId: string; fullName: string; sourceSha: string },
    options: {
      trustedResolvedManifestReadback: (context: unknown) => Promise<unknown>;
      repoRoot: string;
    },
  ) => Promise<object>;
  generateStaticCallerV5: (options: {
    approvedBundleBinding: object;
    resolvedBinding: object;
  }) => string;
};

export async function installedWorkflowBundleContract(): Promise<WorkflowBundleContract> {
  return import("seorilabs-org-contracts/repo-contract/workflow-bundle-v5");
}

export type ApprovedCallerReconcilerDependencies = {
  trustedApprovalKeysJson: string;
  contract?: WorkflowBundleContract;
  /** 기본값은 registry의 서명 검증이다. 테스트만 대체한다. */
  verifyApprovedBundle?: typeof verifyApprovedBundle;
  /** 계약 스키마가 있는 설치 경로. 기본값은 설치된 org contracts에서 찾는다. */
  contractRepoRoot?: string;
  /** 기본값은 서명된 runtime manifest 구성이다. 테스트만 대체한다. */
  resolveManifest?: typeof resolveStaticRuntimeManifestForRepository;
  /** 저장소의 현재 caller 내용. 파일이 없으면 null. */
  readRepositoryCaller: (input: {
    fullName: string;
    ref: string;
    path: string;
  }) => Promise<string | null>;
};

async function approvedBundleBinding(
  contract: WorkflowBundleContract,
  verify: typeof verifyApprovedBundle,
  bundle: unknown,
  trustedKeysJson: string,
) {
  let verified: ReturnType<typeof verifyApprovedBundle>;
  try {
    verified = verify(bundle, trustedKeysJson);
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw new ControlPlaneError(
      "승인된 WorkflowBundle을 신뢰할 수 없습니다.",
      409,
      "APPROVED_WORKFLOW_BUNDLE_UNTRUSTED",
    );
  }
  return contract.loadApprovedWorkflowBundleV5(bundle, {
    trustedApprovalVerifier: async () => ({
      state: "VERIFIED" as const,
      candidateDigest: verified.envelope.candidateDigest,
      payloadDigest: verified.approved.integrity.payloadDigest,
      sourceSha: verified.approved.source.sha,
      workflowExecutionSha: verified.approved.source.workflowExecutionSha,
      keyId: verified.approved.approval.signature.keyId,
      policyRevision: verified.approved.approval.signature.policyRevision,
      contractDigestsDigest: verified.envelope.contractDigestsDigest,
      runtimeAssetDigestsDigest: verified.envelope.runtimeAssetDigestsDigest,
      evidenceDigest: verified.envelope.evidenceDigest,
      approvalPayloadDigest: verified.approvalPayloadDigest,
    }),
  });
}

/**
 * Backoffice가 만든 readback을 중앙 계약이 받는 envelope으로 옮긴다. 계약은 서명 provenance를
 * 최상위에서 다시 대조하므로 manifest 안의 값을 그대로 끌어올린다.
 */
function resolvedManifestEnvelope(readback: {
  state: string;
  repositoryId: string;
  fullName: string;
  bindingSourceSha: string;
  manifestDigest: string;
  manifest: Record<string, unknown>;
}) {
  const manifest = readback.manifest as {
    configRevisionId: string;
    configRevision: number;
    configRevisionDigest: string;
    signedSnapshotDigest: string;
    snapshotSignature: { keyId: string; policyRevision: string; digest: string };
  };
  return {
    state: readback.state,
    repositoryId: readback.repositoryId,
    fullName: readback.fullName,
    sourceSha: readback.bindingSourceSha,
    manifestDigest: readback.manifestDigest,
    configRevisionId: manifest.configRevisionId,
    configRevision: manifest.configRevision,
    configRevisionDigest: manifest.configRevisionDigest,
    signedSnapshotDigest: manifest.signedSnapshotDigest,
    snapshotSignatureKeyId: manifest.snapshotSignature.keyId,
    snapshotSignaturePolicyRevision: manifest.snapshotSignature.policyRevision,
    snapshotSignatureDigest: manifest.snapshotSignature.digest,
    manifest: readback.manifest,
  };
}

function skipped(
  repositoryId: string,
  fullName: string,
  reasonCode: string,
): CallerReconciliationVerdict {
  return {
    repositoryId,
    fullName,
    state: "SKIPPED",
    reasonCode,
    callerPath: CALLER_PATH,
    desiredCaller: null,
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
): Promise<CallerReconciliationVerdict[]> {
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
  const contract = dependencies.contract ?? await installedWorkflowBundleContract();
  const bundleBinding = await approvedBundleBinding(
    contract,
    dependencies.verifyApprovedBundle ?? verifyApprovedBundle,
    record.bundle,
    dependencies.trustedApprovalKeysJson,
  );
  const repoRoot = dependencies.contractRepoRoot ?? contractRepoRoot();
  const resolveManifest = dependencies.resolveManifest ?? resolveStaticRuntimeManifestForRepository;

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
    const expectedSourceRef = `refs/heads/${registration.defaultBranch}`;
    const discovery = await client.discoveryObservation.findFirst({
      where: { appId: app.id, sourceRef: expectedSourceRef },
      orderBy: { createdAt: "desc" },
      select: { sourceSha: true },
    });
    if (!discovery?.sourceSha) {
      verdicts.push(skipped(repositoryId, app.repoFullName, "NO_DEFAULT_BRANCH_DISCOVERY"));
      continue;
    }

    let desiredCaller: string;
    try {
      const readback = await resolveManifest({
        selector: {
          repositoryId,
          bindingSourceSha: discovery.sourceSha,
          applicationSourceSha: discovery.sourceSha,
          workflowBundleSha: record.sourceSha,
        },
        app: {
          id: app.id,
          repoFullName: app.repoFullName,
          status: app.status,
        },
        expectedSourceRef,
        signingKey: input.signingKey,
        snapshotSignatureKeyId: input.snapshotSignatureKeyId,
        snapshotSignaturePolicyRevision: input.snapshotSignaturePolicyRevision,
        now: input.now,
      }, client);
      const envelope = resolvedManifestEnvelope(readback);
      const resolvedBinding = await contract.loadResolvedWorkflowBindingV5({
        repositoryId,
        fullName: app.repoFullName,
        sourceSha: discovery.sourceSha,
      }, {
        trustedResolvedManifestReadback: async () => envelope,
        repoRoot,
      });
      desiredCaller = contract.generateStaticCallerV5({
        approvedBundleBinding: bundleBinding,
        resolvedBinding,
      });
    } catch (error) {
      verdicts.push(skipped(
        repositoryId,
        app.repoFullName,
        error instanceof ControlPlaneError ? error.code : "CALLER_GENERATION_FAILED",
      ));
      continue;
    }

    const current = await dependencies.readRepositoryCaller({
      fullName: app.repoFullName,
      ref: expectedSourceRef,
      path: CALLER_PATH,
    });
    verdicts.push({
      repositoryId,
      fullName: app.repoFullName,
      state: current === desiredCaller ? "IN_SYNC" : "PULL_REQUEST_REQUIRED",
      reasonCode: null,
      callerPath: CALLER_PATH,
      desiredCaller,
    });
  }
  return verdicts;
}

export function callerReconciliationDigest(
  verdicts: CallerReconciliationVerdict[],
): string {
  return contractCanonicalJson(verdicts as unknown as JsonValue);
}
