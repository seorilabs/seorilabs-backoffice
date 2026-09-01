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

function createApp(requestFetch?: typeof globalThis.fetch): App {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_FILE?.trim();
  const privateKeyRaw = process.env.GITHUB_PRIVATE_KEY
    ?? (privateKeyPath ? readFileSync(privateKeyPath, "utf8") : undefined);
  if (!appId || !privateKeyRaw) {
    throw new Error("GITHUB_APP_ID / GITHUB_PRIVATE_KEY 가 설정되지 않았습니다.");
  }
  const BoundOctokit = requestFetch
    ? Octokit.defaults({ request: { fetch: requestFetch } })
    : Octokit;
  return new App({
    appId,
    privateKey: normalizePrivateKey(privateKeyRaw),
    Octokit: BoundOctokit,
  });
}

function getApp(): App {
  if (appInstance) return appInstance;
  appInstance = createApp();
  return appInstance;
}

export interface InstallationContext {
  octokit: Octokit;
  repositorySelection: "all" | "selected";
  targetType: string;
  accountLogin: string | null;
  publicState: GitHubInstallationPublicState;
}

export interface FleetGitHubAppPublicSource {
  observedAt: string;
  app: {
    id: string;
    slug: string;
    ownerId: string;
    ownerLogin: string;
    active: boolean;
    webhookActive: boolean;
    webhookUrl: string;
    permissions: Record<string, "read" | "write" | "admin">;
    events: string[];
  };
  installation: GitHubInstallationPublicState & {
    updatedAt: string;
    suspendedAt: string | null;
  };
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

function publicId(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null;
}

function exactPublicPermissions(value: unknown): Record<string, "read" | "write" | "admin"> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("GITHUB_APP_PUBLIC_STATE_INVALID");
  }
  const entries = Object.entries(value).map(([name, access]) => {
    if (
      !/^[a-z][a-z0-9_]{0,127}$/u.test(name)
      || (access !== "read" && access !== "write" && access !== "admin")
    ) throw new Error("GITHUB_APP_PUBLIC_STATE_INVALID");
    return [name, access] as const;
  }).sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function exactPublicEvents(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("GITHUB_APP_PUBLIC_STATE_INVALID");
  const events = value.map((event) => {
    if (typeof event !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(event)) {
      throw new Error("GITHUB_APP_PUBLIC_STATE_INVALID");
    }
    return event;
  }).sort();
  if (new Set(events).size !== events.length) throw new Error("GITHUB_APP_PUBLIC_STATE_INVALID");
  return events;
}

/**
 * Fleet collector capability용 live public readback이다. App JWT와 installation
 * token은 반환하지 않고 provider가 공개한 identity/permission/event만 남긴다.
 */
export async function readFleetGitHubAppPublicSource(): Promise<FleetGitHubAppPublicSource> {
  const app = getApp();
  const org = process.env.GITHUB_ORG ?? "seorilabs";
  const [appResponse, installationResponse] = await Promise.all([
    app.octokit.request("GET /app"),
    app.octokit.rest.apps.getOrgInstallation({ org }),
  ]);
  const appData = appResponse.data as {
    id?: unknown;
    slug?: unknown;
    owner?: { id?: unknown; login?: unknown } | null;
    permissions?: unknown;
    events?: unknown;
    hook_config?: { active?: unknown; url?: unknown } | null;
    suspended_at?: unknown;
  };
  const installationData = installationResponse.data as unknown as {
    updated_at?: unknown;
    suspended_at?: unknown;
  };
  const installation = normalizeGitHubInstallationPublicState(installationResponse.data);
  const id = publicId(appData.id);
  const ownerId = publicId(appData.owner?.id);
  const updatedAt = installationData.updated_at;
  const suspendedAt = installationData.suspended_at;
  if (
    !id
    || !ownerId
    || typeof appData.slug !== "string"
    || typeof appData.owner?.login !== "string"
    || typeof appData.hook_config?.active !== "boolean"
    || typeof appData.hook_config.url !== "string"
    || typeof updatedAt !== "string"
    || !Number.isFinite(Date.parse(updatedAt))
    || (suspendedAt !== null && (typeof suspendedAt !== "string" || !Number.isFinite(Date.parse(suspendedAt))))
  ) throw new Error("GITHUB_APP_PUBLIC_STATE_INVALID");
  return {
    observedAt: new Date().toISOString(),
    app: {
      id,
      slug: appData.slug,
      ownerId,
      ownerLogin: appData.owner.login,
      active: appData.suspended_at === null || appData.suspended_at === undefined,
      webhookActive: appData.hook_config.active,
      webhookUrl: appData.hook_config.url,
      permissions: exactPublicPermissions(appData.permissions),
      events: exactPublicEvents(appData.events),
    },
    installation: {
      ...installation,
      updatedAt: new Date(Date.parse(updatedAt)).toISOString(),
      suspendedAt: suspendedAt === null ? null : new Date(Date.parse(suspendedAt as string)).toISOString(),
    },
  };
}

/**
 * Fleet trusted transport 공용 issuer다. App JWT로 capability에 지정된 exact repository
 * cohort와 permission의 installation token만 만든다. 일반 operation token은 callback
 * 경계에서 즉시 폐기하고 migration handoff token은 signed 실행에 결합되어 terminal에서 폐기된다.
 */
export async function getFleetScopedGithubTokenIssuer(options: {
  requestFetch?: typeof globalThis.fetch;
} = {}): Promise<{
  installationId: string;
  issuer: FleetScopedGithubTokenIssuer<Octokit>;
}> {
  const app = options.requestFetch ? createApp(options.requestFetch) : getApp();
  const org = process.env.GITHUB_ORG ?? "seorilabs";
  const publicState = options.requestFetch
    ? normalizeGitHubInstallationPublicState(
      (await app.octokit.rest.apps.getOrgInstallation({ org })).data,
    )
    : await getInstallationPublicState();
  const BoundOctokit = options.requestFetch
    ? Octokit.defaults({ request: { fetch: options.requestFetch } })
    : Octokit;
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
        return new BoundOctokit({ auth: token });
      },
      async revokeAccessToken(token) {
        const client = new BoundOctokit({ auth: token });
        await client.request("DELETE /installation/token");
      },
    },
  };
}

export type { Octokit };
