import { createHash } from "node:crypto";

const REPOSITORY = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const REPOSITORY_ID = /^[1-9][0-9]{0,31}$/u;
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export const FLEET_GITHUB_CAPABILITY_PERMISSIONS = Object.freeze({
  "github.workflow-bundle-candidate.read": Object.freeze({ actions: "read", metadata: "read" }),
  "github.bootstrap.properties-read": Object.freeze({ metadata: "read" }),
  "github.bootstrap.owner-read": Object.freeze({ metadata: "read", members: "read" }),
  "github.bootstrap.properties-write": Object.freeze({ metadata: "read", repository_custom_properties: "write" }),
  "github.bootstrap.schema-write": Object.freeze({ metadata: "read", organization_custom_properties: "admin" }),
  "github.fleet-p7.organization-read": Object.freeze({ metadata: "read", organization_administration: "read" }),
  "github.fleet-p7.properties-read": Object.freeze({ metadata: "read", organization_custom_properties: "read" }),
  "github.fleet-p7.protection-read": Object.freeze({ metadata: "read", administration: "read" }),
  "github.standard-labels.contract.read": Object.freeze({
    contents: "read",
    metadata: "read",
  }),
  "github.standard-labels.read": Object.freeze({
    issues: "read",
    metadata: "read",
  }),
  "github.fleet-migration.shadow-read": Object.freeze({
    contents: "read",
    metadata: "read",
  }),
  "github.fleet-cleanup.ready-pr": Object.freeze({
    contents: "write",
    issues: "read",
    metadata: "read",
    pull_requests: "write",
    workflows: "write",
  }),
  "github.fleet-cleanup.executor-identity.read": Object.freeze({
    contents: "read",
    metadata: "read",
  }),
  "github.standard-labels.ensure": Object.freeze({
    issues: "write",
    metadata: "read",
  }),
  "github.workflow-bundle-candidate.ready-pr": Object.freeze({
    contents: "write",
    issues: "read",
    metadata: "read",
    pull_requests: "write",
    workflows: "write",
  }),
  // caller 반증은 Issue를 읽지도 닫지도 않는다. 후보 canary보다 issues 권한만큼 좁다.
  "github.approved-caller-reconciliation.ready-pr": Object.freeze({
    contents: "write",
    metadata: "read",
    pull_requests: "write",
    workflows: "write",
  }),
  "github.release.write": Object.freeze({
    contents: "write",
    metadata: "read",
  }),
  "github.workflow-dispatch.write": Object.freeze({
    actions: "write",
    contents: "read",
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
    repositoryIds: readonly [number, ...number[]];
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

interface ExactRepositoryScope {
  id: number;
  fullName: string;
}

function exactRepositories(repositories: readonly ExactRepositoryScope[]): readonly [ExactRepositoryScope, ...ExactRepositoryScope[]] {
  if (repositories.length < 1 || repositories.length > 500) {
    throw new Error("FLEET_GITHUB_TOKEN_SCOPE_MISMATCH");
  }
  const normalized = repositories.map((repository) => {
    if (
      !Number.isSafeInteger(repository.id)
      || repository.id <= 0
      || !REPOSITORY.test(repository.fullName)
    ) throw new Error("FLEET_GITHUB_TOKEN_SCOPE_MISMATCH");
    return { id: repository.id, fullName: repository.fullName };
  }).sort((left, right) => left.id - right.id || left.fullName.localeCompare(right.fullName));
  if (
    new Set(normalized.map(({ id }) => id)).size !== normalized.length
    || new Set(normalized.map(({ fullName }) => fullName.toLowerCase())).size !== normalized.length
  ) throw new Error("FLEET_GITHUB_TOKEN_SCOPE_MISMATCH");
  return normalized as [ExactRepositoryScope, ...ExactRepositoryScope[]];
}

function assertExactScope(input: {
  response: FleetScopedGithubTokenResponse;
  repositories: readonly [ExactRepositoryScope, ...ExactRepositoryScope[]];
  expectedPermissions: FleetGitHubCapabilityPermissions;
  now: Date;
}): void {
  const expiresAt = Date.parse(input.response.expiresAt);
  const actualRepositories = exactRepositories(input.response.repositories);
  if (
    typeof input.response.token !== "string"
    || input.response.token.length < 20
    || input.response.token.length > 1024
    || /[\s\u0000-\u001f\u007f]/u.test(input.response.token)
    || !Number.isFinite(expiresAt)
    || expiresAt <= input.now.getTime()
    || expiresAt > input.now.getTime() + 60 * 60_000 + 5_000
    || actualRepositories.length !== input.repositories.length
    || input.repositories.some((repository, index) => (
      actualRepositories[index]?.id !== repository.id
      || actualRepositories[index]?.fullName.toLowerCase() !== repository.fullName.toLowerCase()
    ))
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface FleetMigrationGithubCapabilityReceipt {
  executionId: string;
  tokenSha256: string;
  tokenExpiresAt: string;
  permissions: typeof FLEET_GITHUB_CAPABILITY_PERMISSIONS["github.fleet-migration.shadow-read"];
  repositories: ReadonlyArray<{ id: string; fullName: string }>;
}

/**
 * trusted runtime issuer가 exact cohort read token을 broker sink에 직접 넘기는 경계다.
 * raw token은 반환하지 않는다. sink 수락 전 오류에서는 즉시 revoke하고, 수락 뒤에는
 * SHADOW_RUNTIME attestation에 receipt를 결합한 worker가 terminal에서 revoke한다.
 */
export async function issueFleetMigrationGithubCapabilityToSink<Client>(input: {
  issuer: FleetScopedGithubTokenIssuer<Client>;
  installationId: string;
  executionId: string;
  repositories: readonly [{ id: string; fullName: string }, ...Array<{ id: string; fullName: string }>];
  deliver: (delivery: {
    token: string;
    receipt: FleetMigrationGithubCapabilityReceipt;
  }) => Promise<void>;
  now?: () => Date;
}): Promise<FleetMigrationGithubCapabilityReceipt> {
  if (!EXECUTION_ID.test(input.executionId)) {
    throw new Error("FLEET_GITHUB_EXECUTION_ID_INVALID");
  }
  const installationId = numericId(input.installationId, "FLEET_GITHUB_INSTALLATION_ID_INVALID");
  const repositories = exactRepositories(input.repositories.map((repository) => ({
    id: numericId(repository.id, "FLEET_GITHUB_REPOSITORY_ID_INVALID"),
    fullName: repository.fullName,
  })));
  const permissions = FLEET_GITHUB_CAPABILITY_PERMISSIONS["github.fleet-migration.shadow-read"];
  const response = await input.issuer.createAccessToken({
    installationId,
    repositoryIds: repositories.map(({ id }) => id) as [number, ...number[]],
    permissions,
  });
  try {
    assertExactScope({
      response,
      repositories,
      expectedPermissions: permissions,
      now: input.now?.() ?? new Date(),
    });
    const receipt = Object.freeze({
      executionId: input.executionId,
      tokenSha256: sha256(response.token),
      tokenExpiresAt: new Date(Date.parse(response.expiresAt)).toISOString(),
      permissions,
      repositories: Object.freeze(repositories.map((repository) => Object.freeze({
        id: String(repository.id),
        fullName: repository.fullName,
      }))),
    });
    await input.deliver({ token: response.token, receipt });
    return receipt;
  } catch (error) {
    try {
      await input.issuer.revokeAccessToken(response.token);
    } catch (revokeError) {
      throw new Error("FLEET_GITHUB_TOKEN_REVOKE_FAILED", {
        cause: new AggregateError([error, revokeError]),
      });
    }
    throw error;
  }
}

/**
 * GitHub App installation token은 이 callback 경계 밖으로 반환하지 않는다.
 * capability는 고정 permission map으로만 해석하고 대상 repository 하나로 제한한다.
 */
async function withFleetScopedAccessToken<Client, Result>(input: {
  issuer: FleetScopedGithubTokenIssuer<Client>;
  installationId: string;
  capability: FleetGitHubCapability;
  repositoryId: string;
  repositoryFullName: string;
  now?: () => Date;
}, consume: (token: string, issuer: FleetScopedGithubTokenIssuer<Client>) => Promise<Result>): Promise<Result> {
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
  let operationError: unknown;
  let result: Result | undefined;
  try {
    assertExactScope({
      response,
      repositories: [{ id: repositoryId, fullName: input.repositoryFullName }],
      expectedPermissions: permissions,
      now: input.now?.() ?? new Date(),
    });
    result = await consume(response.token, input.issuer);
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await input.issuer.revokeAccessToken(response.token);
    } catch (revokeError) {
      throw new Error("FLEET_GITHUB_TOKEN_REVOKE_FAILED", {
        cause: operationError
          ? new AggregateError([operationError, revokeError])
          : revokeError,
      });
    }
  }
  if (operationError) throw operationError;
  return result as Result;
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
  return withFleetScopedAccessToken<Client, Result>(
    input,
    (token, issuer) => input.execute(issuer.createClient(token)),
  );
}

/**
 * git 같은 외부 프로세스는 Octokit client를 쓸 수 없어 raw token이 필요하다. 경계와
 * revoke는 client 경로와 같고, token은 이 callback 밖으로 나가지 않는다.
 */
export async function withFleetScopedGithubToken<Client, Result>(input: {
  issuer: FleetScopedGithubTokenIssuer<Client>;
  installationId: string;
  capability: FleetGitHubCapability;
  repositoryId: string;
  repositoryFullName: string;
  execute: (token: string) => Promise<Result>;
  now?: () => Date;
}): Promise<Result> {
  return withFleetScopedAccessToken<Client, Result>(input, (token) => input.execute(token));
}
