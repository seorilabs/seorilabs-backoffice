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

// 기획 에이전트용: 실제 레포의 README + 파일 트리(요약)를 가져와 기획을 코드베이스에 정합시킨다.
// 실패해도 throw 안 함(컨텍스트는 옵셔널). 크기 제한으로 프롬프트 폭주 방지.
const TREE_IGNORE =
  /(^|\/)(node_modules|\.git|\.next|\.godot|\.import|dist|build|coverage|Pods|vendor)(\/|$)/i;
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|svg|ico|ttf|otf|woff2?|mp3|wav|ogg|mp4|webm|pdf|zip|lock|wasm|res|import)$/i;

export async function getRepoContext(repoFullName: string): Promise<string> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);

  let readme = "";
  try {
    const r = await octokit.rest.repos.getReadme({ owner, repo });
    readme = Buffer.from(r.data.content, "base64").toString("utf8");
  } catch {
    // README 없음
  }

  let treeText = "";
  try {
    const info = await octokit.rest.repos.get({ owner, repo });
    const branch = info.data.default_branch;
    const ref = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    const tree = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: ref.data.object.sha,
      recursive: "1",
    });
    const paths = tree.data.tree
      .filter((t) => t.type === "blob" && t.path)
      .map((t) => t.path as string)
      .filter((p) => !TREE_IGNORE.test(p) && !BINARY_EXT.test(p))
      .slice(0, 180);
    treeText = paths.join("\n");
  } catch {
    // 트리 조회 실패
  }

  const parts: string[] = [];
  if (readme) parts.push("### README\n" + readme.slice(0, 5000));
  if (treeText) parts.push("### 파일 트리(일부)\n" + treeText.slice(0, 3000));
  return parts.join("\n\n");
}
