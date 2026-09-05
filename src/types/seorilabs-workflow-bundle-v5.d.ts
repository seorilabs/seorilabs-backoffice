declare module "seorilabs-org-contracts/repo-contract/workflow-bundle-v5" {
  export function loadApprovedWorkflowBundleV5(
    bundle: unknown,
    options: { trustedApprovalVerifier: (request: unknown) => Promise<unknown> },
  ): Promise<object>;
  export function loadResolvedWorkflowBindingV5(
    repositoryContext: { repositoryId: string; fullName: string; sourceSha: string },
    options: {
      trustedResolvedManifestReadback: (context: unknown) => Promise<unknown>;
      repoRoot: string;
    },
  ): Promise<object>;
  export function generateStaticCallerV5(options: {
    approvedBundleBinding: object;
    resolvedBinding: object;
  }): string;
}
