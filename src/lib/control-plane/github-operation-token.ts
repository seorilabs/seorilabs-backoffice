const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REPOSITORY_ID = /^[1-9]\d{0,15}$/u;

export const GITHUB_READY_PR_TOKEN_PERMISSIONS = Object.freeze({
  contents: "write",
  issues: "read",
  pull_requests: "write",
} as const);

export interface ScopedGithubTokenResponse {
  token: string;
  permissions?: Readonly<Record<string, string | undefined>>;
  repositories?: ReadonlyArray<{ id: number; fullName: string }>;
}

export interface ScopedGithubTokenIssuer<Client> {
  createAccessToken(input: {
    installationId: number;
    repositoryIds: readonly [number];
    permissions: typeof GITHUB_READY_PR_TOKEN_PERMISSIONS;
  }): Promise<ScopedGithubTokenResponse>;
  createClient(token: string): Client;
  getRepository(client: Client, repoFullName: string): Promise<{ id: number; fullName: string }>;
  revokeAccessToken(token: string): Promise<void>;
}

function numericRepositoryId(repoId: string): number {
  if (!REPOSITORY_ID.test(repoId)) throw new Error("SEORI_GITHUB_REPOSITORY_ID_INVALID");
  const value = Number(repoId);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("SEORI_GITHUB_REPOSITORY_ID_INVALID");
  return value;
}

function assertExactTokenScope(input: {
  response: ScopedGithubTokenResponse;
  repositoryId: number;
  repoFullName: string;
}): void {
  const repositories = input.response.repositories;
  if (
    !repositories
    || repositories.length !== 1
    || repositories[0].id !== input.repositoryId
    || repositories[0].fullName.toLowerCase() !== input.repoFullName.toLowerCase()
  ) throw new Error("SEORI_GITHUB_TOKEN_REPOSITORY_SCOPE_MISMATCH");

  const permissions = input.response.permissions ?? {};
  for (const [permission, level] of Object.entries(GITHUB_READY_PR_TOKEN_PERMISSIONS)) {
    if (permissions[permission] !== level) throw new Error("SEORI_GITHUB_TOKEN_PERMISSION_SCOPE_MISMATCH");
  }
  for (const [permission, level] of Object.entries(permissions)) {
    if (permission === "metadata" && level === "read") continue;
    if (GITHUB_READY_PR_TOKEN_PERMISSIONS[permission as keyof typeof GITHUB_READY_PR_TOKEN_PERMISSIONS] !== level) {
      throw new Error("SEORI_GITHUB_TOKEN_PERMISSION_SCOPE_MISMATCH");
    }
  }
}

/**
 * Operation-scoped installation token을 callback 안에서만 보유하고 항상 폐기한다.
 * callback에는 credential이 아닌 exact repository 전용 client만 전달한다.
 */
export async function withScopedGithubReadyPrClient<Client, Result>(input: {
  issuer: ScopedGithubTokenIssuer<Client>;
  installationId: number;
  repoId: string;
  repoFullName: string;
  execute: (client: Client) => Promise<Result>;
}): Promise<Result> {
  if (!Number.isSafeInteger(input.installationId) || input.installationId <= 0) {
    throw new Error("SEORI_GITHUB_INSTALLATION_ID_INVALID");
  }
  if (!REPOSITORY.test(input.repoFullName)) throw new Error("SEORI_GITHUB_REPOSITORY_INVALID");
  const repositoryId = numericRepositoryId(input.repoId);
  const response = await input.issuer.createAccessToken({
    installationId: input.installationId,
    repositoryIds: [repositoryId],
    permissions: GITHUB_READY_PR_TOKEN_PERMISSIONS,
  });
  try {
    const client = input.issuer.createClient(response.token);
    assertExactTokenScope({ response, repositoryId, repoFullName: input.repoFullName });
    const repository = await input.issuer.getRepository(client, input.repoFullName);
    if (
      repository.id !== repositoryId
      || repository.fullName.toLowerCase() !== input.repoFullName.toLowerCase()
    ) throw new Error("SEORI_GITHUB_REPOSITORY_READBACK_MISMATCH");
    return await input.execute(client);
  } finally {
    await input.issuer.revokeAccessToken(response.token);
  }
}
