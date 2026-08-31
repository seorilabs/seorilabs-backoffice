import type { GitHubInstallationPublicState } from "@/lib/github/installation-public-state";

type PermissionLevel = "read" | "write" | "admin";

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

export type FleetProjectPermissionDisposition =
  | { kind: "GRANTED"; permissionLevel: "write" | "admin" }
  | {
    kind: "HUMAN_PERMISSION_REQUIRED";
    permissionLevel: PermissionLevel | null;
    missingRequirements: string[];
    errorCode: string;
    message: string;
  };

/**
 * GitHub App installation의 공개 권한 readback만으로 조직 Project write 가능 여부를 판정한다.
 * 권한이 없거나 설치 owner가 다르면 Project 부재 조회를 시도하지 않고 사람 승인 gate로 닫는다.
 */
export function fleetProjectPermissionDisposition(
  state: GitHubInstallationPublicState,
  expectedOrganization: string,
): FleetProjectPermissionDisposition {
  const permission = state.permissions.organization_projects ?? null;
  const missing: string[] = [];
  if (state.repositorySelection !== "all") missing.push("installation:all-repositories");
  if (state.targetType !== "Organization") missing.push("installation:organization-target");
  if (state.accountLogin.toLowerCase() !== expectedOrganization.toLowerCase()) {
    missing.push("installation:account-mismatch");
  }
  if (state.suspended) missing.push("installation:suspended");
  if (!permission || PERMISSION_RANK[permission] < PERMISSION_RANK.write) {
    missing.push("permission:organization_projects:write");
  }
  if (missing.length > 0) {
    return {
      kind: "HUMAN_PERMISSION_REQUIRED",
      permissionLevel: permission,
      missingRequirements: [...new Set(missing)].sort(),
      errorCode: "GITHUB_ORG_PROJECTS_WRITE_PERMISSION_REQUIRED",
      message: "GitHub App installation의 all repositories 및 organization Projects read/write 승인이 필요합니다.",
    };
  }
  return { kind: "GRANTED", permissionLevel: permission as "write" | "admin" };
}
