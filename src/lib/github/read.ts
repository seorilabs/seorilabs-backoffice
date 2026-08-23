import { getInstallationOctokit } from "@/lib/github/app";
import { env } from "@/lib/env";
import {
  BUILD_TARGET_DEFINITIONS,
  BUILD_TARGETS,
  type BuildTarget,
} from "@/lib/core/build-targets";
import {
  parseWorkflowDispatchContract,
  type WorkflowDispatchContract,
} from "@/lib/github/workflow-dispatch";

export { parseWorkflowDispatchContract } from "@/lib/github/workflow-dispatch";
export type { WorkflowDispatchContract } from "@/lib/github/workflow-dispatch";

function splitRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

/** 지정 ref(미지정 시 기본 브랜치)의 repo-local JSON. 파일 없음은 null, 다른 오류는 throw. */
export async function getRepoJsonFile(
  repoFullName: string,
  path: string,
  ref?: string,
): Promise<unknown | null> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);
  try {
    const res = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ...(ref ? { ref } : {}),
    });
    const data = res.data as { content?: string; encoding?: string };
    if (!data.content) return null;
    const text = Buffer.from(
      data.content,
      data.encoding === "base64" ? "base64" : "utf8",
    ).toString("utf8");
    return JSON.parse(text) as unknown;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

/** 조직 저장소의 실제 default branch를 한 번의 paginated 조회로 가져온다. */
export async function getOrgDefaultBranches(): Promise<Map<string, string>> {
  const octokit = await getInstallationOctokit();
  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org: env.githubOrg(),
    per_page: 100,
    type: "all",
  });
  return new Map(
    repos
      .filter((repo) => Boolean(repo.default_branch))
      .map((repo) => [repo.full_name, repo.default_branch as string]),
  );
}

/** 단일 저장소의 실제 default branch. workflow_dispatch ref 선택에 사용한다. */
export async function getRepoDefaultBranch(repoFullName: string): Promise<string> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);
  const result = await octokit.rest.repos.get({ owner, repo });
  if (!result.data.default_branch) {
    throw new Error(`기본 브랜치를 확인할 수 없습니다: ${repoFullName}`);
  }
  return result.data.default_branch;
}

/** 기본 브랜치에 build-only caller가 실제 존재하는 대상만 반환한다. */
export async function getAvailableBuildTargets(
  repoFullName: string,
): Promise<BuildTarget[]> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);
  const info = await octokit.rest.repos.get({ owner, repo });
  const ref = info.data.default_branch;
  if (!ref) throw new Error(`기본 브랜치를 확인할 수 없습니다: ${repoFullName}`);

  const availability = await Promise.all(
    BUILD_TARGETS.map(async (target) => {
      const workflowFile = BUILD_TARGET_DEFINITIONS[target].workflowFile;
      try {
        await octokit.rest.repos.getContent({
          owner,
          repo,
          path: `.github/workflows/${workflowFile}`,
          ref,
        });
        return target;
      } catch (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    }),
  );
  return availability.filter((target): target is BuildTarget => target !== null);
}

/**
 * 워크플로 파일에 선언된 workflow_dispatch 입력 이름 집합.
 *
 * GitHub 은 workflow_dispatch 로 넘긴 입력을 "dispatch 한 ref(브랜치/태그)의 워크플로 정의"
 * 기준으로 검증하고, 선언되지 않은 입력을 넘기면 422 로 거부한다. 따라서 검사도 실제 dispatch 할
 * ref 로 조회해야 검증 대상이 일치한다(예: 구버전 태그로 배포하면 그 태그의 정의로 검증되므로,
 * 기본 브랜치에만 있는 입력은 통과해도 dispatch 에서 422 가 난다). ref 미지정 시 기본 브랜치 조회.
 *
 * yaml 파서는 YAML 1.2 라 `on:` 을 문자열 키 "on" 으로 파싱한다(js-yaml 의 on→true 함정 회피).
 */
export async function getWorkflowDispatchInputNames(
  repoFullName: string,
  workflowFile: string,
  ref?: string,
): Promise<Set<string>> {
  return (await getWorkflowDispatchContract(repoFullName, workflowFile, ref)).inputNames;
}

/** 실제 dispatch ref의 workflow_dispatch 존재 여부와 선언 입력을 함께 읽는다. */
export async function getWorkflowDispatchContract(
  repoFullName: string,
  workflowFile: string,
  ref?: string,
): Promise<WorkflowDispatchContract> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);
  const res = await octokit.rest.repos.getContent({
    owner,
    repo,
    path: `.github/workflows/${workflowFile}`,
    ...(ref ? { ref } : {}),
  });
  const data = res.data as { content?: string; encoding?: string };
  if (!data.content) {
    throw new Error(`워크플로 파일 내용을 읽을 수 없음: ${repoFullName} ${workflowFile}`);
  }
  const text = Buffer.from(
    data.content,
    data.encoding === "base64" ? "base64" : "utf8",
  ).toString("utf8");
  return parseWorkflowDispatchContract(text);
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
