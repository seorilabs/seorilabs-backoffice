declare module "seorilabs-org-contracts/repo-contract/github-settings-readback" {
  export function githubProtectionPlanReadback(actual: unknown, identity: {
    organization: string; organizationId: string;
  }): Record<string, unknown>;
  export function githubProtectionReadback(
    desired: { branch: string; requiredStatusCheck: string },
    binding: { repositoryId: string; fullName: string; sourceSha?: string },
    actual: { repository: Record<string, unknown>; branchProtection: unknown; activeRules: unknown },
    observedAt: string,
  ): Record<string, unknown>;
}

declare module "seorilabs-org-contracts/repo-contract/workflow-bundle-v5" {
  /** 승인 서명 검증은 호출자가 주입한다. Backoffice registry의 공개 trust root가 정본이다. */
  export function loadApprovedWorkflowBundleV5(
    bundle: unknown,
    options: {
      trustedApprovalVerifier: (input: {
        source: Record<string, unknown>;
        candidateDigest: string;
        payloadDigest: string;
        signature: Record<string, unknown>;
        evidence: unknown[];
        contractDigests: Record<string, unknown>;
        runtimeAssetDigests: Record<string, unknown>;
        approvalPayload: Buffer;
        approvalPayloadDigest: string;
      }) => Promise<Record<string, unknown>> | Record<string, unknown>;
    },
  ): Promise<object>;

  /** repoRoot는 대상 저장소의 exact source 체크아웃이어야 한다. */
  export function loadResolvedWorkflowBindingV5(
    repositoryContext: { repositoryId: string; fullName: string; sourceSha: string },
    options: {
      trustedResolvedManifestReadback: (
        context: { repositoryId: string; fullName: string; sourceSha: string },
      ) => Promise<unknown> | unknown;
      repoRoot: string;
    },
  ): Promise<object>;

  export function generateStaticCallerV5(options: {
    approvedBundleBinding: object;
    resolvedBinding: object;
  }): string;

  export function validateStaticCallerV5(
    caller: string,
    options: { approvedBundleBinding: object; resolvedBinding: object },
  ): { ok: boolean; diagnostics: readonly string[] };
}
