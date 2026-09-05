import { getFleetScopedGithubTokenIssuer, type Octokit } from "@/lib/github/app";
import { withFleetScopedGithubClient } from "@/lib/github/scoped-installation-client";

/**
 * 저장소의 파일 하나를 읽는다. 없으면 null이다. 읽기 전용이며 저장소를 바꾸지 않는다.
 * 대상 저장소 하나의 contents 읽기 권한만 대여하고 반드시 반환한다.
 */
export async function readRepositoryFile(input: {
  fullName: string;
  repositoryId: string;
  ref: string;
  path: string;
}): Promise<string | null> {
  const [owner, repo] = input.fullName.split("/");
  if (!owner || !repo) throw new Error("REPOSITORY_FULL_NAME_INVALID");
  return withFleetScopedGithubClient({
    ...await getFleetScopedGithubTokenIssuer(),
    capability: "github.caller-reconciliation.read",
    repositoryId: input.repositoryId,
    repositoryFullName: input.fullName,
    execute: async (client: Octokit) => {
      try {
        const response = await client.rest.repos.getContent({
          owner,
          repo,
          path: input.path,
          ref: input.ref,
        });
        const data = response.data as {
          type?: string;
          content?: string;
          encoding?: string;
        };
        if (data.type !== "file" || typeof data.content !== "string") return null;
        return Buffer.from(
          data.content,
          (data.encoding as BufferEncoding | undefined) ?? "base64",
        ).toString("utf8");
      } catch (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    },
  });
}
