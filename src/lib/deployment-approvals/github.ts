import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Octokit } from "octokit";
import { unzipSync } from "fflate";
import { getInstallationOctokit } from "@/lib/github/app";
import { validateTarget, ApprovalCredentialError } from "./policy";
export const repo = { owner: "seorilabs", repo: "platform" };
export { getInstallationOctokit };
export async function approverClient(githubId: bigint) {
  const directory = process.env.PLATFORM_APPROVER_TOKEN_DIRECTORY;
  if (!directory) throw new ApprovalCredentialError("승인자 자격증명 실행 복제본 미등록");
  // 운영자가 catalog에서 검증한 개인별 read-only 파일만 mount. 웹에는 mount하지 않는다.
  const token = await readFile(join(directory, `${githubId}.token`), "utf8").then(value => value.trim()).catch(() => { throw new ApprovalCredentialError("승인자 토큰 실행 복제본을 읽을 수 없음"); });
  if (!token.startsWith("github_pat_")) throw new ApprovalCredentialError("fine-grained 개인 토큰 필요");
  const client = new Octokit({ auth: token, retry: { enabled: false }, throttle: { enabled: false }, request: { timeout: 15_000 } });
  const { data } = await client.rest.users.getAuthenticated();
  if (String(data.id) !== String(githubId)) throw new ApprovalCredentialError("등록된 GitHub 사용자와 토큰 identity 불일치");
  return client;
}
export async function readRun(client: Octokit, runId: number) {
  return (await client.rest.actions.getWorkflowRun({ ...repo, run_id: runId })).data;
}
export async function pending(client: Octokit, runId: number) {
  return (await client.rest.actions.getPendingDeploymentsForRun({ ...repo, run_id: runId })).data;
}
export async function readTarget(client: Octokit, run: Awaited<ReturnType<typeof readRun>>, environment: string) {
  const artifacts = await client.paginate(client.rest.actions.listWorkflowRunArtifacts, { ...repo, run_id: run.id, per_page: 100 });
  const selected = artifacts.filter(a => a.name === `deployment-target-${run.run_attempt}-${environment}` && !a.expired);
  if (selected.length !== 1 || selected[0].size_in_bytes > 64_000) throw new Error("배포 대상 artifact 없음 또는 크기·개수 불일치");
  const download = await client.rest.actions.downloadArtifact({ ...repo, artifact_id: selected[0].id, archive_format: "zip" });
  const files = unzipSync(new Uint8Array(download.data as ArrayBuffer), { filter: file => file.name === "deployment-target.json" && file.originalSize <= 32_000 });
  if (!files["deployment-target.json"]) throw new Error("배포 대상 파일 없음");
  return validateTarget(JSON.parse(new TextDecoder().decode(files["deployment-target.json"])), run, environment);
}
