import { getInstallationOctokit } from "@/lib/github/app";
import {
  isReleaseMarkerMessage,
  releaseMarkerMessage,
} from "@/lib/core/release-marker";

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

/** 태그 존재 여부. 재실행 시 마커 커밋을 중복으로 쌓지 않기 위한 선행 확인. */
export async function tagExists(repoFullName: string, tag: string): Promise<boolean> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(repoFullName);
  const res = await octokit.rest.git
    .getRef({ owner, repo, ref: `tags/${tag}` })
    .catch(() => null);
  return res != null;
}

/**
 * 릴리즈 태그를 달 커밋을 확정한다.
 *
 * ref 가 브랜치 헤드이면 트리가 부모와 동일한 빈 마커 커밋을 push 하고 그 SHA 를 돌려준다.
 * GitHub /commits 화면이 태그를 표시하지 않아 커밋 목록만으로 릴리즈 경계를 알 수 없는 문제를
 * 해결하는 유일한 방법이다(파일 변경 0 이라 코드에는 영향 없음).
 *
 * 아래 경우에는 마커 없이 원래 SHA 를 그대로 돌려준다.
 * - ref 가 브랜치가 아님(태그/SHA 직접 지정) 또는 그 사이 브랜치가 움직임
 * - HEAD 가 이미 마커 커밋(직전 릴리즈 이후 새 커밋 없음) → 마커 연쇄 방지
 * - 보호 브랜치·권한 부족으로 push 거절 → 태그 생성 자체는 계속 진행
 */
export async function pushReleaseMarkerCommit(opts: {
  repoFullName: string;
  ref: string;
  sha: string;
  tag: string;
}): Promise<{ sha: string; marked: boolean }> {
  const octokit = await getInstallationOctokit();
  const { owner, repo } = splitRepo(opts.repoFullName);

  const branch = await octokit.rest.git
    .getRef({ owner, repo, ref: `heads/${opts.ref}` })
    .catch(() => null);
  if (!branch || branch.data.object.sha !== opts.sha) return { sha: opts.sha, marked: false };

  const parent = await octokit.rest.git.getCommit({ owner, repo, commit_sha: opts.sha });
  if (isReleaseMarkerMessage(parent.data.message)) return { sha: opts.sha, marked: false };

  try {
    const commit = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: releaseMarkerMessage(opts.tag),
      tree: parent.data.tree.sha,
      parents: [opts.sha],
    });
    // force 없음 = fast-forward 만 허용. 그 사이 브랜치가 움직였으면 실패 → 폴백.
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${opts.ref}`,
      sha: commit.data.sha,
    });
    return { sha: commit.data.sha, marked: true };
  } catch {
    return { sha: opts.sha, marked: false };
  }
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

/** workflow_dispatch 트리거. inputs 값은 문자열. */
export async function dispatchWorkflow(opts: {
  repoFullName: string;
  workflowFile: string;
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
