import type { Octokit } from "@/lib/github/app";
import { withFleetScopedGithubClient, type FleetScopedGithubTokenIssuer } from "@/lib/github/scoped-installation-client";
import { WORKFLOW_BUNDLE_CANDIDATE_SOURCE } from "@/lib/control-plane/workflow-bundle-candidate-source";

type IssuerProvider = () => Promise<{ installationId: string; issuer: FleetScopedGithubTokenIssuer<Octokit> }>;
const loadIssuer: IssuerProvider = async () => {
  const { getFleetScopedGithubTokenIssuer } = await import("@/lib/github/app");
  return getFleetScopedGithubTokenIssuer();
};

/** 중앙 후보 조회에는 대상 저장소 하나의 Actions 읽기 권한만 대여하고 반드시 반환한다. */
export async function withWorkflowBundleRegistryReadClient<Result>(
  execute: (client: Octokit) => Promise<Result>,
  getIssuer: IssuerProvider = loadIssuer,
): Promise<Result> {
  try {
    return await withFleetScopedGithubClient({
      ...await getIssuer(),
      capability: "github.workflow-bundle-candidate.read",
      repositoryId: WORKFLOW_BUNDLE_CANDIDATE_SOURCE.repositoryId,
      repositoryFullName: WORKFLOW_BUNDLE_CANDIDATE_SOURCE.repository,
      execute,
    });
  } catch (error) {
    // REST 오류와 revoke 실패의 cause에는 Authorization/signed URL이 있을 수 있다.
    const message = error instanceof Error ? error.message : "";
    throw new Error(/^(?:FLEET_GITHUB|WORKFLOW_BUNDLE)_[A-Z0-9_]{1,120}$/.test(message)
      ? message
      : "WORKFLOW_BUNDLE_CANDIDATE_GITHUB_READ_FAILED");
  }
}
