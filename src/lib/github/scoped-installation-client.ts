const REPOSITORY = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const REPOSITORY_ID = /^[1-9][0-9]{0,31}$/u;

export const FLEET_GITHUB_CAPABILITY_PERMISSIONS = Object.freeze({
  "github.standard-labels.contract.read": Object.freeze({
    contents: "read",
    metadata: "read",
  }),
  "github.standard-labels.read": Object.freeze({
    issues: "read",
    metadata: "read",
  }),
  "github.standard-labels.ensure": Object.freeze({
    issues: "write",
    metadata: "read",
  }),
} as const);

export type FleetGitHubCapability = keyof typeof FLEET_GITHUB_CAPABILITY_PERMISSIONS;
export type FleetGitHubCapabilityPermissions =
  typeof FLEET_GITHUB_CAPABILITY_PERMISSIONS[FleetGitHubCapability];

export interface FleetScopedGithubTokenResponse {
  token: string;
  expiresAt: string;
  permissions: Readonly<Record<string, string | undefined>>;
  repositories: ReadonlyArray<{ id: number; fullName: string }>;
}

export interface FleetScopedGithubTokenIssuer<Client> {
  createAccessToken(input: {
    installationId: number;
    repositoryIds: readonly [number];
    permissions: FleetGitHubCapabilityPermissions;
  }): Promise<FleetScopedGithubTokenResponse>;
  createClient(token: string): Client;
  revokeAccessToken(token: string): Promise<void>;
}

function numericId(value: string, error: string): number {
  if (!REPOSITORY_ID.test(value)) throw new Error(error);
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new Error(error);
  return numeric;
}

function assertExactScope(input: {
  response: FleetScopedGithubTokenResponse;
  repositoryId: number;
  repositoryFullName: string;
  expectedPermissions: FleetGitHubCapabilityPermissions;
  now: Date;
}): void {
  const expiresAt = Date.parse(input.response.expiresAt);
  if (
    typeof input.response.token !== "string"
    || input.response.token.length < 20
    || !Number.isFinite(expiresAt)
    || expiresAt <= input.now.getTime()
    || expiresAt > input.now.getTime() + 60 * 60_000 + 5_000
    || input.response.repositories.length !== 1
    || input.response.repositories[0]?.id !== input.repositoryId
    || input.response.repositories[0]?.fullName.toLowerCase() !== input.repositoryFullName.toLowerCase()
  ) {
    throw new Error("FLEET_GITHUB_TOKEN_SCOPE_MISMATCH");
  }
  const expectedEntries = Object.entries(input.expectedPermissions).sort(([left], [right]) => left.localeCompare(right));
  const actualEntries = Object.entries(input.response.permissions)
    .filter(([, level]) => level !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  if (
    expectedEntries.length !== actualEntries.length
    || expectedEntries.some(([key, level], index) => (
      actualEntries[index]?.[0] !== key || actualEntries[index]?.[1] !== level
    ))
  ) {
    throw new Error("FLEET_GITHUB_TOKEN_PERMISSION_MISMATCH");
  }
}

/**
 * GitHub App installation token은 이 callback 경계 밖으로 반환하지 않는다.
 * capability는 고정 permission map으로만 해석하고 대상 repository 하나로 제한한다.
 */
export async function withFleetScopedGithubClient<Client, Result>(input: {
  issuer: FleetScopedGithubTokenIssuer<Client>;
  installationId: string;
  capability: FleetGitHubCapability;
  repositoryId: string;
  repositoryFullName: string;
  execute: (client: Client) => Promise<Result>;
  now?: () => Date;
}): Promise<Result> {
  if (!REPOSITORY.test(input.repositoryFullName)) {
    throw new Error("FLEET_GITHUB_REPOSITORY_INVALID");
  }
  const installationId = numericId(input.installationId, "FLEET_GITHUB_INSTALLATION_ID_INVALID");
  const repositoryId = numericId(input.repositoryId, "FLEET_GITHUB_REPOSITORY_ID_INVALID");
  const permissions = FLEET_GITHUB_CAPABILITY_PERMISSIONS[input.capability];
  if (!permissions) throw new Error("FLEET_GITHUB_CAPABILITY_UNSUPPORTED");
  const response = await input.issuer.createAccessToken({
    installationId,
    repositoryIds: [repositoryId],
    permissions,
  });
  let operationError: unknown = null;
  try {
    assertExactScope({
      response,
      repositoryId,
      repositoryFullName: input.repositoryFullName,
      expectedPermissions: permissions,
      now: input.now?.() ?? new Date(),
    });
    const client = input.issuer.createClient(response.token);
    return await input.execute(client);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await input.issuer.revokeAccessToken(response.token);
    } catch {
      if (!operationError) throw new Error("FLEET_GITHUB_TOKEN_REVOKE_FAILED");
    }
  }
}
