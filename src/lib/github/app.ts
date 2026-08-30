import { readFileSync } from "node:fs";
import { App, Octokit } from "octokit";
import {
  normalizeGitHubInstallationPublicState,
  type GitHubInstallationPublicState,
} from "@/lib/github/installation-public-state";

// GitHub App (seorilabs-backoffice) 인증.
// - App JWT → installation token 교환은 Octokit 이 내부적으로 자동 갱신.
// - 서버사이드 모든 GitHub 작업(미러/backfill/이슈 write)에 installation octokit 사용.

let appInstance: App | null = null;

function normalizePrivateKey(raw: string): string {
  // env 에 \n 으로 escape 되어 들어온 경우 실제 개행으로 복원.
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function getApp(): App {
  if (appInstance) return appInstance;
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_FILE?.trim();
  const privateKeyRaw = process.env.GITHUB_PRIVATE_KEY
    ?? (privateKeyPath ? readFileSync(privateKeyPath, "utf8") : undefined);
  if (!appId || !privateKeyRaw) {
    throw new Error("GITHUB_APP_ID / GITHUB_PRIVATE_KEY 가 설정되지 않았습니다.");
  }
  appInstance = new App({ appId, privateKey: normalizePrivateKey(privateKeyRaw) });
  return appInstance;
}

export interface InstallationContext {
  octokit: Octokit;
  repositorySelection: "all" | "selected";
  targetType: string;
  accountLogin: string | null;
  publicState: GitHubInstallationPublicState;
}

let cached: { context: InstallationContext; at: number } | null = null;
const TTL_MS = 30 * 60 * 1000;

export async function getInstallationContext(
  options: { forceRefresh?: boolean } = {},
): Promise<InstallationContext> {
  if (!options.forceRefresh && cached && Date.now() - cached.at < TTL_MS) return cached.context;
  const app = getApp();
  const org = process.env.GITHUB_ORG ?? "seorilabs";
  const { data } = await app.octokit.rest.apps.getOrgInstallation({ org });
  const publicState = normalizeGitHubInstallationPublicState(data);
  const octokit = await app.getInstallationOctokit(data.id);
  const context: InstallationContext = {
    octokit,
    repositorySelection: publicState.repositorySelection,
    targetType: publicState.targetType,
    accountLogin: publicState.accountLogin,
    publicState,
  };
  cached = { context, at: Date.now() };
  return context;
}

export async function getInstallationOctokit(): Promise<Octokit> {
  return (await getInstallationContext()).octokit;
}

export type { Octokit };
