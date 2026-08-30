import { readFileSync } from "node:fs";
import { App, Octokit } from "octokit";
import {
  normalizeGitHubInstallationPublicState,
  type GitHubInstallationPublicState,
} from "@/lib/github/installation-public-state";
import type {
  FleetScopedGithubTokenIssuer,
} from "@/lib/github/scoped-installation-client";

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
let publicStateCache: { state: GitHubInstallationPublicState; at: number } | null = null;
const TTL_MS = 30 * 60 * 1000;

async function getInstallationPublicState(): Promise<GitHubInstallationPublicState> {
  if (publicStateCache && Date.now() - publicStateCache.at < TTL_MS) return publicStateCache.state;
  const app = getApp();
  const org = process.env.GITHUB_ORG ?? "seorilabs";
  const { data } = await app.octokit.rest.apps.getOrgInstallation({ org });
  const state = normalizeGitHubInstallationPublicState(data);
  publicStateCache = { state, at: Date.now() };
  return state;
}

export async function getInstallationContext(
  options: { forceRefresh?: boolean } = {},
): Promise<InstallationContext> {
  if (!options.forceRefresh && cached && Date.now() - cached.at < TTL_MS) return cached.context;
  const app = getApp();
  const org = process.env.GITHUB_ORG ?? "seorilabs";
  const { data } = await app.octokit.rest.apps.getOrgInstallation({ org });
  const publicState = normalizeGitHubInstallationPublicState(data);
  publicStateCache = { state: publicState, at: Date.now() };
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

/**
 * Fleet trusted transport 공용 issuer다. App JWT로 repository 하나와 capability별
 * exact permission의 installation token만 만들고, token은 callback 경계 안에서 폐기한다.
 */
export async function getFleetScopedGithubTokenIssuer(): Promise<{
  installationId: string;
  issuer: FleetScopedGithubTokenIssuer<Octokit>;
}> {
  const app = getApp();
  const publicState = await getInstallationPublicState();
  const org = process.env.GITHUB_ORG ?? "seorilabs";
  if (
    org !== "seorilabs"
    || publicState.accountLogin !== org
    || publicState.targetType !== "Organization"
    || publicState.repositorySelection !== "all"
    || publicState.suspended
  ) {
    throw new Error("FLEET_GITHUB_INSTALLATION_IDENTITY_INVALID");
  }
  return {
    installationId: publicState.installationId,
    issuer: {
      async createAccessToken(input) {
        const response = await app.octokit.rest.apps.createInstallationAccessToken({
          installation_id: input.installationId,
          repository_ids: [...input.repositoryIds],
          permissions: { ...input.permissions },
        });
        return {
          token: response.data.token,
          expiresAt: response.data.expires_at,
          permissions: response.data.permissions ?? {},
          repositories: (response.data.repositories ?? []).map((repository) => ({
            id: repository.id,
            fullName: repository.full_name,
          })),
        };
      },
      createClient(token) {
        return new Octokit({ auth: token });
      },
      async revokeAccessToken(token) {
        const client = new Octokit({ auth: token });
        await client.request("DELETE /installation/token");
      },
    },
  };
}

export type { Octokit };
