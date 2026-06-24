import { getInstallationOctokit } from "@/lib/github/app";

function splitRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

// 분해 에이전트용: 이슈 본문을 GitHub 에서 직접 읽는다(미러에 body 컬럼 없음).
export async function getIssue(
  repoFullName: string,
  issueNumber: number,
): Promise<{ title: string; body: string; htmlUrl: string }> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);
  const res = await octokit.rest.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });
  return {
    title: res.data.title,
    body: res.data.body ?? "",
    htmlUrl: res.data.html_url,
  };
}
