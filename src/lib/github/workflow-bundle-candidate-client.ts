import {
  type GithubCommitState,
  type GithubIssueState,
  type GithubPullRequestState,
  type GithubReadyPrPort,
  type GithubRepositoryState,
  type PreparedGithubFile,
} from "@/lib/control-plane/github-ready-pr-adapter";
import { getFleetScopedGithubTokenIssuer, type Octokit } from "@/lib/github/app";
import { withFleetScopedGithubClient } from "@/lib/github/scoped-installation-client";

class WorkflowBundleCandidateGithubPort implements GithubReadyPrPort {
  constructor(public readonly installationId: string, private readonly client: Octokit) {}

  private repository(fullName: string): { owner: string; repo: string } {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) throw new Error("WORKFLOW_BUNDLE_CANDIDATE_REPOSITORY_INVALID");
    return { owner, repo };
  }

  async getRepository(fullName: string): Promise<GithubRepositoryState> {
    const binding = this.repository(fullName);
    const repository = await this.client.rest.repos.get(binding);
    const branch = await this.client.rest.repos.getBranch({
      ...binding,
      branch: repository.data.default_branch,
    });
    return {
      id: repository.data.id,
      fullName: repository.data.full_name,
      defaultBranch: repository.data.default_branch,
      defaultBranchSha: branch.data.commit.sha,
    };
  }

  async getIssue(fullName: string, issueNumber: number): Promise<GithubIssueState> {
    const issue = await this.client.rest.issues.get({
      ...this.repository(fullName),
      issue_number: issueNumber,
    });
    if ("pull_request" in issue.data) throw new Error("WORKFLOW_BUNDLE_CANDIDATE_ISSUE_IS_PR");
    return {
      number: issue.data.number,
      nodeId: issue.data.node_id,
      state: issue.data.state === "open" ? "OPEN" : "CLOSED",
      labels: issue.data.labels
        .map((label) => typeof label === "string" ? label : label.name)
        .filter((label): label is string => Boolean(label)),
      updatedAt: new Date(issue.data.updated_at),
    };
  }

  async listPullRequests(input: {
    repoFullName: string;
    state: "OPEN" | "ALL";
    page: number;
    perPage: number;
  }): Promise<GithubPullRequestState[]> {
    const response = await this.client.rest.pulls.list({
      ...this.repository(input.repoFullName),
      state: input.state === "OPEN" ? "open" : "all",
      sort: "created",
      direction: "asc",
      page: input.page,
      per_page: input.perPage,
    });
    return response.data.map((pullRequest) => ({
      number: pullRequest.number,
      nodeId: pullRequest.node_id,
      url: pullRequest.html_url,
      state: pullRequest.merged_at ? "MERGED" : pullRequest.state === "open" ? "OPEN" : "CLOSED",
      draft: pullRequest.draft ?? false,
      headRef: `refs/heads/${pullRequest.head.ref}`,
      headRepoFullName: pullRequest.head.repo?.full_name ?? "",
      headSha: pullRequest.head.sha,
      baseRef: `refs/heads/${pullRequest.base.ref}`,
      baseRepoFullName: pullRequest.base.repo.full_name,
      baseSha: pullRequest.base.sha,
      body: pullRequest.body ?? "",
    }));
  }

  async getRef(fullName: string, ref: string): Promise<{ sha: string } | null> {
    try {
      const result = await this.client.rest.git.getRef({
        ...this.repository(fullName),
        ref: ref.replace(/^refs\//u, ""),
      });
      return { sha: result.data.object.sha };
    } catch (error) {
      if (typeof error === "object" && error && "status" in error && error.status === 404) return null;
      throw error;
    }
  }

  async getCommit(fullName: string, sha: string): Promise<GithubCommitState | null> {
    try {
      const result = await this.client.rest.git.getCommit({
        ...this.repository(fullName),
        commit_sha: sha,
      });
      if (result.data.parents.length !== 1) throw new Error("WORKFLOW_BUNDLE_CANDIDATE_COMMIT_PARENT_INVALID");
      return {
        sha: result.data.sha,
        treeSha: result.data.tree.sha,
        parentSha: result.data.parents[0].sha,
      };
    } catch (error) {
      if (typeof error === "object" && error && "status" in error && error.status === 404) return null;
      throw error;
    }
  }

  async createTree(input: {
    repoFullName: string;
    sourceSha: string;
    files: PreparedGithubFile[];
  }): Promise<{ sha: string }> {
    const repository = this.repository(input.repoFullName);
    const base = await this.client.rest.git.getCommit({ ...repository, commit_sha: input.sourceSha });
    const tree = await this.client.rest.git.createTree({
      ...repository,
      base_tree: base.data.tree.sha,
      tree: input.files.map((file) => ({
        path: file.path,
        mode: file.mode,
        type: "blob" as const,
        content: file.content,
      })),
    });
    if (tree.data.sha === base.data.tree.sha) throw new Error("WORKFLOW_BUNDLE_CANDIDATE_NO_CHANGES");
    return { sha: tree.data.sha };
  }

  async createCommit(input: {
    repoFullName: string;
    sourceSha: string;
    treeSha: string;
    message: string;
    date: Date;
  }): Promise<{ sha: string }> {
    const identity = {
      name: "Seorilabs Automation",
      email: "automation@seorilabs.com",
      date: input.date.toISOString(),
    };
    const commit = await this.client.rest.git.createCommit({
      ...this.repository(input.repoFullName),
      message: input.message,
      tree: input.treeSha,
      parents: [input.sourceSha],
      author: identity,
      committer: identity,
    });
    return { sha: commit.data.sha };
  }

  async createRef(input: { repoFullName: string; ref: string; sha: string }): Promise<void> {
    await this.client.rest.git.createRef({
      ...this.repository(input.repoFullName),
      ref: input.ref,
      sha: input.sha,
    });
  }

  async createPullRequest(input: {
    repoFullName: string;
    baseBranch: string;
    headRef: string;
    title: string;
    body: string;
  }): Promise<void> {
    await this.client.rest.pulls.create({
      ...this.repository(input.repoFullName),
      title: input.title,
      body: input.body,
      head: input.headRef.replace(/^refs\/heads\//u, ""),
      base: input.baseBranch,
      draft: false,
    });
  }
}

export async function withWorkflowBundleCandidateGithub<Result>(input: {
  installationId: string;
  repositoryId: string;
  repositoryFullName: string;
  requestFetch?: typeof globalThis.fetch;
  execute: (github: GithubReadyPrPort) => Promise<Result>;
}): Promise<Result> {
  const scoped = await getFleetScopedGithubTokenIssuer({ requestFetch: input.requestFetch });
  if (scoped.installationId !== input.installationId) {
    throw new Error("WORKFLOW_BUNDLE_CANDIDATE_INSTALLATION_ID_MISMATCH");
  }
  return withFleetScopedGithubClient({
    issuer: scoped.issuer,
    installationId: input.installationId,
    capability: "github.workflow-bundle-candidate.ready-pr",
    repositoryId: input.repositoryId,
    repositoryFullName: input.repositoryFullName,
    execute: (client) => input.execute(
      new WorkflowBundleCandidateGithubPort(input.installationId, client),
    ),
  });
}
