"use server";

import { requirePlatformReadAccess } from "@/lib/platform/access";
import { applyGitHubBootstrap, latestGitHubBootstrap, planGitHubBootstrap, reconcileGitHubBootstrap, type GitHubBootstrapView } from "@/lib/control-plane/github-bootstrap-service";

type Result = { ok: true; value: GitHubBootstrapView | null } | { ok: false; error: string };
async function humanAdmin(): Promise<string> {
  const actor = await requirePlatformReadAccess();
  if (actor.role !== "ADMIN") throw new Error("GITHUB_BOOTSTRAP_HUMAN_ADMIN_REQUIRED");
  return actor.login;
}
function failure(error: unknown): Result {
  const message = error instanceof Error ? error.message : "";
  const code = /^GITHUB_BOOTSTRAP_[A-Z_]{1,100}$/u.test(message) ? message : "GITHUB_BOOTSTRAP_REQUEST_FAILED";
  return { ok: false, error: `공통 관리 설정 요청을 처리하지 못했습니다. 기존 실행과 GitHub 상태를 다시 확인해 주세요. (${code})` };
}
export async function readGitHubBootstrapAction(): Promise<Result> {
  try { await humanAdmin(); return { ok: true, value: await latestGitHubBootstrap() }; }
  catch (error) { return failure(error); }
}
export async function planGitHubBootstrapAction(input: { requestId: string }): Promise<Result> {
  try { return { ok: true, value: await planGitHubBootstrap({ actor: await humanAdmin(), requestId: input.requestId }) }; }
  catch (error) { return failure(error); }
}
export async function applyGitHubBootstrapAction(input: { runId: string; planDigest: string; expectedGeneration: number; requestId: string }): Promise<Result> {
  try { return { ok: true, value: await applyGitHubBootstrap({ ...input, actor: await humanAdmin() }) }; }
  catch (error) { return failure(error); }
}
export async function reconcileGitHubBootstrapAction(input: { runId: string; planDigest: string; expectedGeneration: number; requestId: string }): Promise<Result> {
  try { return { ok: true, value: await reconcileGitHubBootstrap({ ...input, actor: await humanAdmin() }) }; }
  catch (error) { return failure(error); }
}
