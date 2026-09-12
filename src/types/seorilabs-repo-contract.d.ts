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
