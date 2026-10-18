import { getInstallationOctokit, getFleetScopedGithubTokenIssuer, type Octokit } from "@/lib/github/app";
import { withFleetScopedGithubClient } from "@/lib/github/scoped-installation-client";
import type { Candidate } from "./contracts";
import { IssuePostRejected, isRejectedStatus } from "./post-outcome";

export interface IssueReadback { number: number; title: string; body: string; state: string; stateReason?: string | null; url: string; labels: string[] }
export interface PullReadback { number: number; title: string; body: string; mergedAt: string | null; closing: number[] }
export interface RepositoryReadback { sha: string; private: boolean; archived?: boolean; issues: IssueReadback[]; pulls: PullReadback[]; openAutopilot: number }
/** 등록 대상 하나의 최소 권한 토큰. POST는 Octokit의 retry/throttle 재전송도 끈다. */
export async function withRegistrationGithub<T>(repository: string, execute: (port: RegistrationGithub) => Promise<T>) {
  if (!/^seorilabs\/[A-Za-z0-9._-]+$/.test(repository)) throw new Error("REPOSITORY_INVALID");
  const [owner, repo] = repository.split("/"), client = await getInstallationOctokit();
  const target = (await client.rest.repos.get({ owner, repo })).data;
  if (target.full_name.toLowerCase() !== repository.toLowerCase()) throw new Error("REPOSITORY_IDENTITY_MISMATCH");
  const scoped = await getFleetScopedGithubTokenIssuer({ disableAutomaticRetries: true });
  return withFleetScopedGithubClient({ ...scoped, capability: "github.metric-issue-registration", repositoryId: String(target.id), repositoryFullName: target.full_name, execute: (client) => execute(new RegistrationGithub(client, owner, repo)) });
}
export class RegistrationGithub {
  constructor(private client: Octokit, private owner: string, private repo: string) {}
  async readback(now: Date, inventoryLimit = Infinity): Promise<RepositoryReadback> {
    const args = { owner: this.owner, repo: this.repo }, since = new Date(now.getTime() - 90 * 86400_000).toISOString();
    const repository = (await this.client.rest.repos.get(args)).data;
    if (repository.full_name.toLowerCase() !== `${this.owner}/${this.repo}`.toLowerCase()) throw new Error("REPOSITORY_IDENTITY_MISMATCH");
    const sha = (await this.client.rest.repos.getCommit({ ...args, ref: repository.default_branch })).data.sha;
    if (repository.archived || repository.disabled) return { sha, private: repository.private, archived: true, issues: [], pulls: [], openAutopilot: 0 };
    const open = await this.client.paginate(this.client.rest.issues.listForRepo, { ...args, state: "open", per_page: 100 });
    const openAutopilot = open.filter((row) => !row.pull_request && row.labels.some((label) => (typeof label === "string" ? label : label.name) === "autopilot")).length;
    if (openAutopilot >= inventoryLimit) return { sha, private: repository.private, issues: [], pulls: [], openAutopilot };
    const [closed, openPulls, recentPulls] = await Promise.all([
      this.client.paginate(this.client.rest.issues.listForRepo, { ...args, state: "closed", since, per_page: 100 }),
      this.client.paginate(this.client.rest.pulls.list, { ...args, state: "open", per_page: 100 }),
      this.recentPulls(since),
    ]);
    const issues: IssueReadback[] = [...new Map([...open, ...closed].filter((row) => !row.pull_request).map((row) => [row.number, row])).values()].map((row) => ({ number: row.number, title: row.title, body: row.body ?? "", state: row.state, stateReason: row.state_reason, url: row.html_url, labels: row.labels.map((label) => typeof label === "string" ? label : label.name ?? "") }));
    const pulls: PullReadback[] = [];
    for (const row of [...new Map([...openPulls, ...recentPulls].map((row) => [row.number, row])).values()]) {
      const result = await this.client.graphql<{ repository: { pullRequest: { closingIssuesReferences: { nodes: Array<{ number: number; repository: { nameWithOwner: string } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } } }>(`query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){closingIssuesReferences(first:100){nodes{number repository{nameWithOwner}}pageInfo{hasNextPage endCursor}}}}}`, { owner: this.owner, repo: this.repo, number: row.number });
      if (result.repository.pullRequest.closingIssuesReferences.pageInfo.hasNextPage) throw new Error("CLOSING_REFERENCES_INCOMPLETE");
      pulls.push({ number: row.number, title: row.title, body: row.body ?? "", mergedAt: row.merged_at, closing: result.repository.pullRequest.closingIssuesReferences.nodes.filter((one) => one.repository.nameWithOwner.toLowerCase() === `${this.owner}/${this.repo}`.toLowerCase()).map((one) => one.number) });
    }
    for (const number of new Set(pulls.flatMap((row) => row.closing))) if (!issues.some((row) => row.number === number)) issues.push(await this.issue(number));
    return { sha, private: repository.private, issues, pulls, openAutopilot: issues.filter((row) => row.state === "open" && row.labels.includes("autopilot")).length };
  }
  private async recentPulls(since: string) {
    const output = [];
    for (let page = 1; ; page++) {
      const rows = (await this.client.rest.pulls.list({ owner: this.owner, repo: this.repo, state: "closed", sort: "updated", direction: "desc", per_page: 100, page })).data;
      output.push(...rows.filter((row) => row.updated_at >= since));
      if (rows.length < 100 || rows.at(-1)!.updated_at < since) return output;
      if (page >= 100) throw new Error("PULL_HISTORY_INCOMPLETE");
    }
  }
  async files(sha: string): Promise<Record<string, string>> {
    const tree = (await this.client.rest.git.getTree({ owner: this.owner, repo: this.repo, tree_sha: sha, recursive: "true" })).data;
    if (tree.truncated) throw new Error("REPOSITORY_TREE_INCOMPLETE");
    const paths = [...new Set(["AGENTS.md", "README.md", ...tree.tree.filter((row) => row.type === "blob" && (row.size ?? 0) <= 16000 && /analytics|telemetry|tracking|events|instrumentation/i.test(row.path ?? "") && /\.(ts|tsx|js|gd|json|md)$/.test(row.path ?? "") && !/lock|node_modules|vendor|\.env/.test(row.path ?? "")).map((row) => row.path!).sort().slice(0, 12)])];
    const files: Record<string, string> = {};
    for (const path of paths) { const text = await this.file(path, sha); if (text && Object.values(files).join("").length + text.length <= 64000) files[path] = text; }
    return files;
  }
  async file(path: string, sha: string) {
    let response;
    try { response = (await this.client.rest.repos.getContent({ owner: this.owner, repo: this.repo, path, ref: sha })).data; }
    catch (error) { if ((error as { status?: number }).status === 404) return null; throw error; }
    if (Array.isArray(response) || !("content" in response) || response.size > 64000) return null;
    return Buffer.from(response.content, "base64").toString("utf8");
  }
  async relatedFix(candidate: Candidate, pulls: PullReadback[], now: Date) {
    for (const pull of pulls.filter((row) => row.mergedAt && now.getTime() - new Date(row.mergedAt).getTime() < 7 * 86400_000)) {
      const files = await this.client.paginate(this.client.rest.pulls.listFiles, { owner: this.owner, repo: this.repo, pull_number: pull.number, per_page: 100 });
      if (files.length >= 3000) throw new Error("PULL_FILES_INCOMPLETE");
      if (files.some((file) => candidate.scope.includes(file.filename))) return new Date(pull.mergedAt!);
    }
    return null;
  }
  async labelsExist(labels: string[]) {
    try { for (const name of labels) await this.client.rest.issues.getLabel({ owner: this.owner, repo: this.repo, name }); return true; }
    catch (error) { if ((error as { status?: number }).status === 404) return false; throw error; }
  }
  async create(title: string, body: string, labels: string[]) {
    let row;
    try { row = (await this.client.rest.issues.create({ owner: this.owner, repo: this.repo, title, body, labels, request: { retries: 0, signal: AbortSignal.timeout(30_000) } })).data; }
    catch (error) { const status = (error as { status?: unknown }).status; if (isRejectedStatus(status)) throw new IssuePostRejected(status); throw error; }
    return this.issue(row.number);
  }
  async findIssueForRecovery(marker: string, now: Date) {
    // 보관된 저장소도 읽는다. 등록 분석용 default branch·PR 조회와 분리한다.
    const rows = await this.client.paginate(this.client.rest.issues.listForRepo, { owner: this.owner, repo: this.repo, state: "all", since: new Date(now.getTime() - 90 * 86400_000).toISOString(), per_page: 100 });
    const matched = rows.filter((row) => !row.pull_request && row.body?.includes(marker));
    return matched.length === 1 ? this.issue(matched[0].number) : undefined;
  }
  async issue(number: number): Promise<IssueReadback> {
    const row = (await this.client.rest.issues.get({ owner: this.owner, repo: this.repo, issue_number: number })).data;
    return { number, title: row.title, body: row.body ?? "", state: row.state, stateReason: row.state_reason, url: row.html_url, labels: row.labels.map((label) => typeof label === "string" ? label : label.name ?? "") };
  }
}
