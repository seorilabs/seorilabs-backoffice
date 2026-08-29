const DEFAULT_BRANCH_MAX_LENGTH = 255;

/** GitHub provider readback의 exact default branch만 source ref로 승격한다. */
export function repositoryDefaultBranchRef(defaultBranch: string | null): string | null {
  if (
    !defaultBranch
    || defaultBranch.length > DEFAULT_BRANCH_MAX_LENGTH
    || /[\u0000-\u001f\u007f]/.test(defaultBranch)
    || defaultBranch.startsWith("refs/")
  ) return null;
  return `refs/heads/${defaultBranch}`;
}
