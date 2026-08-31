import {
  getFleetScopedGithubTokenIssuer,
  getInstallationOctokit,
  type Octokit,
} from "@/lib/github/app";
import {
  createOrUpdateReleaseWithExactLookup,
  createTagWithExactReadback,
  dispatchWorkflowWithExactTagBinding,
  upsertReleaseAssetWithExactBinding,
} from "@/lib/github/release-write-operations";
import {
  withFleetScopedGithubClient,
  type FleetGitHubCapability,
} from "@/lib/github/scoped-installation-client";

const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const STABLE_TAG = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

function splitRepo(repoFullName: string): { owner: string; repo: string } {
  if (!/^seorilabs\/[A-Za-z0-9._-]+$/u.test(repoFullName)) {
    throw new Error("GITHUB_REPOSITORY_INVALID");
  }
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

async function withRepositoryMutationClient<Result>(input: {
  repoFullName: string;
  capability: FleetGitHubCapability;
  execute: (client: Octokit, identity: { owner: string; repo: string }) => Promise<Result>;
}): Promise<Result> {
  const identity = splitRepo(input.repoFullName);
  const installationClient = await getInstallationOctokit();
  const repository = await installationClient.rest.repos.get(identity);
  if (
    !Number.isSafeInteger(repository.data.id)
    || repository.data.id <= 0
    || repository.data.full_name.toLowerCase() !== input.repoFullName.toLowerCase()
  ) throw new Error("GITHUB_REPOSITORY_IDENTITY_MISMATCH");

  const scoped = await getFleetScopedGithubTokenIssuer();
  return withFleetScopedGithubClient({
    issuer: scoped.issuer,
    installationId: scoped.installationId,
    capability: input.capability,
    repositoryId: String(repository.data.id),
    repositoryFullName: repository.data.full_name,
    execute: (client) => input.execute(client, identity),
  });
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

/** exact repository-scoped token으로 태그를 생성하고 peeled commit을 재검증한다. */
export async function createTag(opts: {
  repoFullName: string;
  tag: string;
  sha: string;
}): Promise<{ created: boolean }> {
  return withRepositoryMutationClient({
    repoFullName: opts.repoFullName,
    capability: "github.release.write",
    execute: (client, identity) => createTagWithExactReadback(client, { ...identity, ...opts }),
  });
}

/** 태그에 GitHub Release 생성 또는 갱신(본문=출시노트). */
export async function createOrUpdateRelease(opts: {
  repoFullName: string;
  tag: string;
  expectedSha: string;
  name?: string;
  body: string;
  prerelease?: boolean;
}): Promise<{ url: string; id: number }> {
  return withRepositoryMutationClient({
    repoFullName: opts.repoFullName,
    capability: "github.release.write",
    execute: (client, identity) => createOrUpdateReleaseWithExactLookup(client, {
      ...identity,
      tag: opts.tag,
      expectedSha: opts.expectedSha,
      name: opts.name,
      body: opts.body,
      prerelease: opts.prerelease,
    }),
  });
}

/** Release 에 에셋 업로드. 동일 이름 에셋이 있으면 교체(GitHub 는 중복 이름을 거부).
 *  upload-first: 먼저 올리고 422(이름 충돌)일 때만 기존 삭제 후 재업로드.
 *  delete-first 패턴은 삭제~업로드 사이에 에셋이 없는 구간이 생겨 동시 실행 배포가 폴백된다. */
export async function upsertReleaseAsset(opts: {
  repoFullName: string;
  releaseId: number;
  tag: string;
  expectedSha: string;
  name: string;
  contentType: string;
  data: string;
}): Promise<{ url: string }> {
  return withRepositoryMutationClient({
    repoFullName: opts.repoFullName,
    capability: "github.release.write",
    execute: (client, identity) => upsertReleaseAssetWithExactBinding(client, {
      ...identity,
      releaseId: opts.releaseId,
      tag: opts.tag,
      expectedSha: opts.expectedSha,
      name: opts.name,
      contentType: opts.contentType,
      data: opts.data,
    }),
  });
}

/** workflow_dispatch 트리거. inputs 값은 문자열. */
export async function dispatchWorkflow(opts: {
  repoFullName: string;
  workflowFile: string;
  ref: string; // 태그 또는 브랜치
  inputs?: Record<string, string>;
  expectedTag?: { tag: string; sha: string };
}): Promise<void> {
  const releaseTag = opts.inputs?.release_tag;
  if (
    releaseTag !== undefined
    && (opts.expectedTag?.tag !== releaseTag || !opts.expectedTag.sha)
  ) {
    throw new Error("GITHUB_WORKFLOW_RELEASE_TAG_BINDING_REQUIRED");
  }
  if (
    opts.expectedTag
    && (
      !COMMIT_SHA.test(opts.expectedTag.sha.toLowerCase())
      || (STABLE_TAG.test(opts.ref) && opts.expectedTag.tag !== opts.ref)
    )
  ) {
    throw new Error("GITHUB_WORKFLOW_RELEASE_TAG_BINDING_MISMATCH");
  }
  await withRepositoryMutationClient({
    repoFullName: opts.repoFullName,
    capability: "github.workflow-dispatch.write",
    execute: async (client, { owner, repo }) => {
      if (opts.expectedTag) {
        await dispatchWorkflowWithExactTagBinding(client, {
          owner,
          repo,
          workflowFile: opts.workflowFile,
          ref: opts.ref,
          inputs: opts.inputs ?? {},
          expectedTag: opts.expectedTag.tag,
          expectedSha: opts.expectedTag.sha,
        });
        return;
      }
      await client.rest.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: opts.workflowFile,
        ref: opts.ref,
        ...(opts.inputs ? { inputs: opts.inputs } : {}),
      });
    },
  });
}
