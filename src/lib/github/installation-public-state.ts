export interface GitHubInstallationPublicState {
  installationId: string;
  appId: string;
  targetId: string;
  repositorySelection: "all" | "selected";
  targetType: string;
  accountLogin: string;
  permissions: Record<string, "read" | "write" | "admin">;
  events: string[];
  suspended: boolean;
}

const PUBLIC_PERMISSION_KEY = /^[a-z][a-z0-9_]{0,127}$/;
const PUBLIC_EVENT_NAME = /^[a-z][a-z0-9_]{0,127}$/;

function publicNumericId(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null;
}

/** GitHub App JWT 응답에서 secret/token/URL을 버리고 Gate 판단용 공개 필드만 남긴다. */
export function normalizeGitHubInstallationPublicState(data: unknown): GitHubInstallationPublicState {
  const installation = data as {
    id?: unknown;
    app_id?: unknown;
    target_id?: unknown;
    repository_selection?: unknown;
    target_type?: unknown;
    account?: { id?: unknown; login?: unknown } | null;
    permissions?: unknown;
    events?: unknown;
    suspended_at?: unknown;
  } | null;
  const installationId = publicNumericId(installation?.id);
  const appId = publicNumericId(installation?.app_id);
  const targetId = publicNumericId(installation?.target_id);
  const accountId = publicNumericId(installation?.account?.id);
  const repositorySelection = installation?.repository_selection;
  const accountLogin = installation?.account?.login;
  if (
    !installationId
    || !appId
    || !targetId
    || accountId !== targetId
    || (repositorySelection !== "all" && repositorySelection !== "selected")
    || installation?.target_type !== "Organization"
    || typeof accountLogin !== "string"
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(accountLogin)
    || !installation.permissions
    || Array.isArray(installation.permissions)
    || typeof installation.permissions !== "object"
    || !Array.isArray(installation.events)
  ) {
    throw new Error("GITHUB_INSTALLATION_PUBLIC_STATE_INVALID");
  }
  const permissions: Record<string, "read" | "write" | "admin"> = {};
  for (const [key, value] of Object.entries(installation.permissions)) {
    if (!PUBLIC_PERMISSION_KEY.test(key) || (value !== "read" && value !== "write" && value !== "admin")) {
      throw new Error("GITHUB_INSTALLATION_PUBLIC_STATE_INVALID");
    }
    permissions[key] = value;
  }
  const events = installation.events.map((event) => {
    if (typeof event !== "string" || !PUBLIC_EVENT_NAME.test(event)) {
      throw new Error("GITHUB_INSTALLATION_PUBLIC_STATE_INVALID");
    }
    return event;
  });
  return {
    installationId,
    appId,
    targetId,
    repositorySelection,
    targetType: installation.target_type,
    accountLogin,
    permissions: Object.fromEntries(Object.entries(permissions).sort(([left], [right]) => left.localeCompare(right))),
    events: [...new Set(events)].sort(),
    suspended: installation.suspended_at !== null && installation.suspended_at !== undefined,
  };
}

