import { getInstallationOctokit } from "@/lib/github/app";

function splitRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

// 백오피스 → GitHub 최소 write 3종 (installation token). 모두 webhook 으로 미러에 재수렴.

export async function createIssue(opts: {
  repoFullName: string;
  title: string;
  body: string;
  labels?: string[];
}) {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(opts.repoFullName);
  const res = await octokit.rest.issues.create({
    owner,
    repo,
    title: opts.title,
    body: opts.body,
    labels: opts.labels,
  });
  return res.data;
}

export async function toggleIssueLabel(opts: {
  repoFullName: string;
  issueNumber: number;
  label: string;
  on: boolean;
}): Promise<void> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(opts.repoFullName);
  if (opts.on) {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: opts.issueNumber,
      labels: [opts.label],
    });
  } else {
    try {
      await octokit.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: opts.issueNumber,
        name: opts.label,
      });
    } catch {
      // 라벨이 없으면 무시.
    }
  }
}

export async function addIssueComment(opts: {
  repoFullName: string;
  issueNumber: number;
  body: string;
}): Promise<void> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(opts.repoFullName);
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: opts.issueNumber,
    body: opts.body,
  });
}

// ── 릴리즈/배포 write (GitHub App 권한 필요: contents:write, actions:write) ──
// 결과는 tag push / workflow_run webhook 으로 미러(ReleaseNote/ReleaseRecord)에 재수렴한다.

/** ref(브랜치/태그/SHA) → 커밋 SHA. */
export async function resolveRefSha(repoFullName: string, ref: string): Promise<string> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);
  const res = await octokit.rest.repos.getCommit({ owner, repo, ref });
  return res.data.sha;
}

/** lightweight 태그 생성. 이미 존재하면 동일 SHA→idempotent, 다른 SHA→throw. */
export async function createTag(opts: {
  repoFullName: string;
  tag: string;
  sha: string;
}): Promise<{ created: boolean }> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(opts.repoFullName);
  try {
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/tags/${opts.tag}`, sha: opts.sha });
    return { created: true };
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 422) {
      const existing = await octokit.rest.git
        .getRef({ owner, repo, ref: `tags/${opts.tag}` })
        .catch(() => null);
      const existingSha = existing?.data.object.sha;
      if (existingSha && existingSha !== opts.sha) {
        throw new Error(
          `태그 ${opts.tag} 가 다른 커밋(${existingSha.slice(0, 7)})에 이미 존재합니다.`,
        );
      }
      return { created: false };
    }
    throw e;
  }
}

/** 태그에 GitHub Release 생성 또는 갱신(본문=출시노트). */
export async function createOrUpdateRelease(opts: {
  repoFullName: string;
  tag: string;
  name?: string;
  body: string;
  prerelease?: boolean;
}): Promise<{ url: string; id: number }> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(opts.repoFullName);
  const existing = await octokit.rest.repos
    .getReleaseByTag({ owner, repo, tag: opts.tag })
    .catch(() => null);
  if (existing) {
    const res = await octokit.rest.repos.updateRelease({
      owner,
      repo,
      release_id: existing.data.id,
      name: opts.name ?? opts.tag,
      body: opts.body,
      ...(opts.prerelease != null ? { prerelease: opts.prerelease } : {}),
    });
    return { url: res.data.html_url, id: res.data.id };
  }
  const res = await octokit.rest.repos.createRelease({
    owner,
    repo,
    tag_name: opts.tag,
    name: opts.name ?? opts.tag,
    body: opts.body,
    prerelease: opts.prerelease ?? false,
  });
  return { url: res.data.html_url, id: res.data.id };
}

/** Release 에 에셋 업로드. 동일 이름 에셋이 있으면 교체(GitHub 는 중복 이름을 거부).
 *  upload-first: 먼저 올리고 422(이름 충돌)일 때만 기존 삭제 후 재업로드.
 *  delete-first 패턴은 삭제~업로드 사이에 에셋이 없는 구간이 생겨 동시 실행 배포가 폴백된다. */
export async function upsertReleaseAsset(opts: {
  repoFullName: string;
  releaseId: number;
  name: string;
  contentType: string;
  data: string;
}): Promise<{ url: string }> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(opts.repoFullName);

  const doUpload = () =>
    octokit.rest.repos.uploadReleaseAsset({
      owner,
      repo,
      release_id: opts.releaseId,
      name: opts.name,
      // octokit 타입은 data:string 을 요구. JSON 문자열을 원문 바디로 전송.
      data: opts.data,
      headers: { "content-type": opts.contentType },
    });

  try {
    const res = await doUpload();
    return { url: res.data.browser_download_url };
  } catch (err: unknown) {
    // 422 = 이름 충돌 → 기존 에셋 삭제 후 재업로드
    if ((err as { status?: number }).status !== 422) throw err;
    const existing = await octokit.rest.repos.listReleaseAssets({
      owner,
      repo,
      release_id: opts.releaseId,
      per_page: 100,
    });
    for (const a of existing.data.filter((a) => a.name === opts.name)) {
      await octokit.rest.repos.deleteReleaseAsset({ owner, repo, asset_id: a.id });
    }
    const res = await doUpload();
    return { url: res.data.browser_download_url };
  }
}

/** workflow_dispatch 트리거(배포 워크플로우). inputs 값은 문자열. */
export async function dispatchWorkflow(opts: {
  repoFullName: string;
  workflowFile: string; // "deploy-apps-in-toss.yml"
  ref: string; // 태그 또는 브랜치
  inputs?: Record<string, string>;
}): Promise<void> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(opts.repoFullName);
  await octokit.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: opts.workflowFile,
    ref: opts.ref,
    ...(opts.inputs ? { inputs: opts.inputs } : {}),
  });
}
