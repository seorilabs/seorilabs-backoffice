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
