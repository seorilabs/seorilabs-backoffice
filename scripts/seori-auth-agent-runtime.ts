import { createPrivateKey, randomUUID, type KeyObject } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TLSSocket } from "node:tls";
import { App, Octokit } from "octokit";
import { z } from "zod";

import { GENERIC_WORKER_PRINCIPALS } from "@/lib/control-plane/automation-catalog";
import {
  agentCompletionSchema,
  agentFailureSchema,
  agentHeartbeatSchema,
  agentReadbackRequiredSchema,
  agentReadbackResolutionSchema,
} from "@/lib/control-plane/contracts";
import {
  executeGithubReadyPr,
  recoverGithubReadyPr,
  type GithubIssueState,
  type GithubMutationControlPlane,
  type GithubPullRequestState,
  type GithubReadyPrPort,
  type GithubRepositoryState,
} from "@/lib/control-plane/github-ready-pr-adapter";
import {
  withScopedGithubReadyPrClient,
  type ScopedGithubTokenIssuer,
} from "@/lib/control-plane/github-operation-token";
import { signAgentAdapterAttestation } from "@/lib/control-plane/agent-adapter-attestation";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  createExactMtlsProxyClient,
  exactHostSet,
  readBoundedResponseBody,
} from "@/lib/control-plane/mtls-egress-proxy";
import {
  agentKindForWorkerPrincipal,
  assertPublicAgentResponse,
  parseExactHttpsOrigin,
  readBoundSecretFile,
  seoriAuthPublicRequestSchema,
  serializePublicAgentResponse,
  workerIdentityFromMtlsPeer,
  withBoundSecretText,
  type WorkerPrincipal,
} from "@/lib/control-plane/seori-auth-agent-transport";

const BODY_LIMIT = 6 * 1024 * 1024;
const RESPONSE_LIMIT = 512 * 1024;
const FIXED_ROOT = process.env.SEORI_AUTH_AGENT_RUNTIME_ROOT?.trim() || "/var/run/seori-auth-agent-runtime";
// 동일 OS UID의 모델 프로세스를 native peer attestation 없이 구분할 수 없으므로 runtime은 mTLS만 제공한다.
const transport = z.literal("mtls").parse(process.env.SEORI_AUTH_AGENT_TRANSPORT?.trim());
// durable step ledger 구현과 별개로 실제 GitHub canary 승인이 끝날 때까지 runtime은 fail-closed다.
const READY_PR_RUNTIME_OPERATIONAL = false as const;
const backofficeOrigin = parseExactHttpsOrigin(process.env.SEORI_BACKOFFICE_ORIGIN?.trim() || "");
const adapterPrincipalId = process.env.AGENT_TRUSTED_ADAPTER_PRINCIPAL?.trim() || "";
const adapterRuntimeIdentity = process.env.AGENT_TRUSTED_ADAPTER_RUNTIME_IDENTITY?.trim() || "";
const githubAppId = process.env.SEORI_GITHUB_APP_ID?.trim() || "";
if (!/^[A-Za-z0-9._:/-]{1,128}$/u.test(adapterPrincipalId)) throw new Error("SEORI_ADAPTER_PRINCIPAL_INVALID");
if (!/^[A-Za-z0-9._:/-]{1,191}$/u.test(adapterRuntimeIdentity)) throw new Error("SEORI_ADAPTER_RUNTIME_INVALID");
if (!/^\d{1,30}$/u.test(githubAppId)) throw new Error("SEORI_GITHUB_APP_ID_INVALID");

const authorizeResponseSchema = z.object({
  ok: z.literal(true),
  authorization: z.object({
    executionId: z.string().min(1).max(191),
    action: z.literal("GITHUB_READY_PR_MUTATE"),
    mutationIntentDigest: z.string().regex(/^[0-9a-f]{64}$/i),
    expectedHeadRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]{1,240}$/),
    expectedPullRequestMarker: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/),
    expiresAt: z.coerce.date(),
    commitDate: z.coerce.date(),
    status: z.string().min(1).max(32),
    writeDisposition: z.literal("STEP_LEDGER"),
    duplicate: z.boolean(),
  }).strict(),
}).strict();

const recoveryResponseSchema = z.object({
  ok: z.literal(true),
  recovery: z.object({
    executionId: z.string().min(1).max(191),
    status: z.string().min(1).max(32),
    repoId: z.string().regex(/^[1-9]\d{0,15}$/),
    repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    issueNumber: z.number().int().positive().nullable(),
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/i),
    expectedHeadRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]{1,240}$/),
    expectedPullRequestMarker: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/),
    duplicate: z.boolean(),
  }).strict(),
}).strict();

const stepClaimResponseSchema = z.object({
  ok: z.literal(true),
  step: z.object({
    executionId: z.string().min(1).max(191),
    stepId: z.string().min(1).max(191),
    stepKind: z.enum(["CREATE_COMMIT", "CREATE_REF", "CREATE_PR"]),
    stepStatus: z.string().min(1).max(32),
    generation: z.number().int().nonnegative(),
    attemptId: z.string().min(1).max(191).nullable(),
    expiresAt: z.coerce.date().nullable(),
    expectedTreeSha: z.string().regex(/^[0-9a-f]{40}$/i).nullable(),
    expectedCommitSha: z.string().regex(/^[0-9a-f]{40}$/i).nullable(),
    expectedHeadRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]{1,240}$/),
    expectedPullRequestMarker: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/),
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/i),
    commitDate: z.coerce.date(),
    writeDisposition: z.enum(["EXECUTE_ONCE", "READBACK_THEN_EXECUTE", "READBACK_ONLY", "ALREADY_VERIFIED"]),
    duplicate: z.boolean(),
  }).strict(),
}).strict();

const stepPlanResponseSchema = z.object({
  ok: z.literal(true),
  plan: z.object({
    executionId: z.string().min(1).max(191),
    stepId: z.string().min(1).max(191),
    attemptId: z.string().min(1).max(191),
    generation: z.number().int().positive(),
    status: z.string().min(1).max(32),
    expectedTreeSha: z.string().regex(/^[0-9a-f]{40}$/i),
    expectedCommitSha: z.string().regex(/^[0-9a-f]{40}$/i),
    duplicate: z.boolean(),
  }).strict(),
}).strict();

const stepCompletionResponseSchema = z.object({
  ok: z.literal(true),
  completion: z.object({
    executionId: z.string().min(1).max(191),
    stepId: z.string().min(1).max(191),
    attemptId: z.string().min(1).max(191),
    generation: z.number().int().positive(),
    status: z.enum(["VERIFIED", "NOT_APPLIED", "RESULT_UNKNOWN"]),
    duplicate: z.boolean(),
  }).strict(),
}).strict();

const readbackResponseSchema = z.object({
  ok: z.literal(true),
  executionId: z.string().min(1).max(191),
  status: z.enum(["VERIFIED", "NOT_APPLIED", "RESULT_UNKNOWN"]),
  duplicate: z.boolean(),
}).strict();

const claimBodySchema = z.object({
  leaseSeconds: z.number().int().min(30).max(300).default(300),
}).strict();
const recoveryRequestSchema = z.object({
  sessionId: z.string().regex(/^agent-session:[A-Za-z0-9._:/-]{1,190}$/),
}).strict();

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const copy = Buffer.from(chunk as Buffer);
    bytes += copy.length;
    if (bytes > BODY_LIMIT) {
      copy.fill(0);
      chunks.forEach((entry) => entry.fill(0));
      throw new Error("SEORI_AUTH_REQUEST_BODY_TOO_LARGE");
    }
    chunks.push(copy);
  }
  const encoded = Buffer.concat(chunks);
  try {
    return JSON.parse(encoded.toString("utf8"));
  } finally {
    encoded.fill(0);
    chunks.forEach((entry) => entry.fill(0));
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const serialized = serializePublicAgentResponse(status, body);
  response.writeHead(serialized.statusCode, {
    "content-type": "application/json",
    "content-length": String(serialized.body.length),
    "cache-control": "no-store",
  });
  response.end(serialized.body, () => serialized.body.fill(0));
}

function backofficeRequest(input: {
  path: string;
  body: JsonValue;
  principalId: string;
  bearer: string;
  requestId: string;
  fetchImpl: typeof globalThis.fetch;
  attestation?: string;
  workerRuntimeBindingDigest?: string;
}): Promise<unknown> {
  return (async () => {
    const encoded = Buffer.from(JSON.stringify(input.body), "utf8");
    const signal = AbortSignal.timeout(15_000);
    let response: Response;
    try {
      response = await input.fetchImpl(new URL(input.path, backofficeOrigin), {
        method: "POST",
        body: encoded,
        signal,
        headers: {
          "content-type": "application/json",
          "content-length": String(encoded.length),
          "authorization": `Bearer ${input.bearer}`,
          "x-seori-principal": input.principalId,
          "idempotency-key": input.requestId,
          ...(input.workerRuntimeBindingDigest
            ? { "x-seori-worker-runtime-binding": input.workerRuntimeBindingDigest }
            : {}),
          ...(input.attestation ? { "x-seori-adapter-attestation": input.attestation } : {}),
        },
      });
    } finally {
      encoded.fill(0);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`SEORI_BACKOFFICE_REJECTED_${response.status}`);
    }
    const payload = await readBoundedResponseBody(
      response,
      RESPONSE_LIMIT,
      "SEORI_BACKOFFICE_RESPONSE_TOO_LARGE",
    );
    try {
      return assertPublicAgentResponse(JSON.parse(payload.toString("utf8")));
    } finally {
      payload.fill(0);
    }
  })();
}

class OctokitGithubReadyPrPort implements GithubReadyPrPort {
  constructor(public readonly installationId: string, private readonly octokit: Octokit) {}

  private split(repoFullName: string): { owner: string; repo: string } {
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) throw new Error("SEORI_GITHUB_REPOSITORY_INVALID");
    return { owner, repo };
  }

  async getRepository(repoFullName: string): Promise<GithubRepositoryState> {
    const binding = this.split(repoFullName);
    const repository = await this.octokit.rest.repos.get(binding);
    const defaultBranch = repository.data.default_branch;
    const branch = await this.octokit.rest.repos.getBranch({ ...binding, branch: defaultBranch });
    return {
      id: repository.data.id,
      fullName: repository.data.full_name,
      defaultBranch,
      defaultBranchSha: branch.data.commit.sha,
    };
  }

  async getIssue(repoFullName: string, issueNumber: number): Promise<GithubIssueState> {
    const issue = await this.octokit.rest.issues.get({ ...this.split(repoFullName), issue_number: issueNumber });
    if ("pull_request" in issue.data) throw new Error("SEORI_GITHUB_ISSUE_IS_PULL_REQUEST");
    return {
      number: issue.data.number,
      nodeId: issue.data.node_id,
      state: issue.data.state === "open" ? "OPEN" : "CLOSED",
      labels: issue.data.labels.map((label) => typeof label === "string" ? label : label.name).filter(Boolean) as string[],
      updatedAt: new Date(issue.data.updated_at),
    };
  }

  async listPullRequests(input: {
    repoFullName: string;
    state: "OPEN" | "ALL";
    page: number;
    perPage: number;
  }): Promise<GithubPullRequestState[]> {
    const pulls = await this.octokit.rest.pulls.list({
      ...this.split(input.repoFullName),
      state: input.state === "OPEN" ? "open" : "all",
      sort: "created",
      direction: "asc",
      page: input.page,
      per_page: input.perPage,
    });
    return pulls.data.map((pullRequest) => ({
      number: pullRequest.number,
      nodeId: pullRequest.node_id,
      url: pullRequest.html_url,
      state: pullRequest.merged_at ? "MERGED" : pullRequest.state === "open" ? "OPEN" : "CLOSED",
      draft: pullRequest.draft ?? false,
      headRef: `refs/heads/${pullRequest.head.ref}`,
      headRepoFullName: pullRequest.head.repo?.full_name ?? "",
      headSha: pullRequest.head.sha,
      baseRef: `refs/heads/${pullRequest.base.ref}`,
      baseRepoFullName: pullRequest.base.repo.full_name,
      baseSha: pullRequest.base.sha,
      body: pullRequest.body ?? "",
    }));
  }

  async getRef(repoFullName: string, ref: string): Promise<{ sha: string } | null> {
    const normalized = ref.replace(/^refs\//u, "");
    try {
      const result = await this.octokit.rest.git.getRef({ ...this.split(repoFullName), ref: normalized });
      return { sha: result.data.object.sha };
    } catch (error) {
      if (typeof error === "object" && error && "status" in error && error.status === 404) return null;
      throw error;
    }
  }

  async getCommit(repoFullName: string, sha: string): Promise<{
    sha: string;
    treeSha: string;
    parentSha: string;
  } | null> {
    try {
      const result = await this.octokit.rest.git.getCommit({
        ...this.split(repoFullName),
        commit_sha: sha,
      });
      if (result.data.parents.length !== 1) throw new Error("SEORI_GITHUB_COMMIT_PARENT_INVALID");
      return {
        sha: result.data.sha,
        treeSha: result.data.tree.sha,
        parentSha: result.data.parents[0].sha,
      };
    } catch (error) {
      if (typeof error === "object" && error && "status" in error && error.status === 404) return null;
      throw error;
    }
  }

  async createTree(input: {
    repoFullName: string;
    sourceSha: string;
    files: Array<{ path: string; content: string; mode: "100644" | "100755" }>;
  }): Promise<{ sha: string }> {
    const binding = this.split(input.repoFullName);
    const baseCommit = await this.octokit.rest.git.getCommit({ ...binding, commit_sha: input.sourceSha });
    const tree = await this.octokit.rest.git.createTree({
      ...binding,
      base_tree: baseCommit.data.tree.sha,
      tree: input.files.map((file) => ({
        path: file.path,
        mode: file.mode,
        type: "blob" as const,
        content: file.content,
      })),
    });
    if (tree.data.sha === baseCommit.data.tree.sha) throw new Error("SEORI_GITHUB_NO_CHANGES");
    return { sha: tree.data.sha };
  }

  async createCommit(input: {
    repoFullName: string;
    sourceSha: string;
    treeSha: string;
    message: string;
    date: Date;
  }): Promise<{ sha: string }> {
    const binding = this.split(input.repoFullName);
    const identity = {
      name: "Seorilabs Automation",
      email: "automation@seorilabs.com",
      date: input.date.toISOString(),
    };
    const commit = await this.octokit.rest.git.createCommit({
      ...binding,
      message: input.message,
      tree: input.treeSha,
      parents: [input.sourceSha],
      author: identity,
      committer: identity,
    });
    return { sha: commit.data.sha };
  }

  async createRef(input: { repoFullName: string; ref: string; sha: string }): Promise<void> {
    await this.octokit.rest.git.createRef({
      ...this.split(input.repoFullName),
      ref: input.ref,
      sha: input.sha,
    });
  }

  async createPullRequest(input: {
    repoFullName: string;
    baseBranch: string;
    headRef: string;
    title: string;
    body: string;
  }): Promise<void> {
    await this.octokit.rest.pulls.create({
      ...this.split(input.repoFullName),
      title: input.title,
      body: input.body,
      head: input.headRef.replace(/^refs\/heads\//u, ""),
      base: input.baseBranch,
      draft: false,
    });
  }
}

async function withGithubPort<Result>(input: {
  privateKey: string;
  repoFullName: string;
  repoId: string;
  fetchImpl: typeof globalThis.fetch;
  execute: (github: GithubReadyPrPort) => Promise<Result>;
}): Promise<Result> {
  const { privateKey, repoFullName, repoId } = input;
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error("SEORI_GITHUB_REPOSITORY_INVALID");
  const ProxyOctokit = Octokit.defaults({ request: { fetch: input.fetchImpl } });
  const app = new App({ appId: githubAppId, privateKey, Octokit: ProxyOctokit });
  const installation = await app.octokit.rest.apps.getRepoInstallation({ owner, repo });
  const issuer: ScopedGithubTokenIssuer<Octokit> = {
    createAccessToken: async ({ installationId, repositoryIds, permissions }) => {
      const response = await app.octokit.rest.apps.createInstallationAccessToken({
        installation_id: installationId,
        repository_ids: [...repositoryIds],
        permissions,
      });
      return {
        token: response.data.token,
        permissions: response.data.permissions,
        repositories: response.data.repositories?.map((repository) => ({
          id: repository.id,
          fullName: repository.full_name,
        })),
      };
    },
    createClient: (token) => new ProxyOctokit({ auth: token }),
    getRepository: async (client, fullName) => {
      const [boundOwner, boundRepo] = fullName.split("/");
      if (!boundOwner || !boundRepo) throw new Error("SEORI_GITHUB_REPOSITORY_INVALID");
      const repository = await client.rest.repos.get({ owner: boundOwner, repo: boundRepo });
      return { id: repository.data.id, fullName: repository.data.full_name };
    },
    revokeAccessToken: async (token) => {
      await new ProxyOctokit({ auth: token }).rest.apps.revokeInstallationAccessToken();
    },
  };
  return withScopedGithubReadyPrClient({
    issuer,
    installationId: installation.data.id,
    repoId,
    repoFullName,
    execute: async (octokit) => input.execute(
      new OctokitGithubReadyPrPort(String(installation.data.id), octokit),
    ),
  });
}

function createMutationControlPlane(
  attestationPrivateKey: KeyObject,
  fetchImpl: typeof globalThis.fetch,
): GithubMutationControlPlane {
  const call = async (input: { path: string; requestId: string; body: unknown }) => {
    const body = asJson(input.body);
    const issuedAt = Date.now();
    const attestation = signAgentAdapterAttestation({
      privateKey: attestationPrivateKey,
      runtimeIdentity: adapterRuntimeIdentity,
      route: input.path,
      requestId: input.requestId,
      body,
      issuedAt,
      expiresAt: issuedAt + 30_000,
      nonce: randomUUID(),
    });
    return withBoundSecretText({
      root: FIXED_ROOT,
      relativePath: "backoffice/adapter.bearer",
      allowGroupRead: true,
      maxBytes: 4096,
    }, (bearer) => backofficeRequest({
      path: input.path,
      body,
      principalId: adapterPrincipalId,
      bearer,
      requestId: input.requestId,
      fetchImpl,
      attestation,
    }));
  };
  return {
    recover: async (input) => recoveryResponseSchema.parse(await call({
      path: "/api/internal/agent-adapter/github-mutations/recovery",
      ...input,
    })).recovery,
    authorize: async (input) => authorizeResponseSchema.parse(await call({
      path: "/api/internal/agent-adapter/github-mutations/authorize",
      ...input,
    })).authorization,
    claimStep: async (input) => stepClaimResponseSchema.parse(await call({
      path: "/api/internal/agent-adapter/github-mutations/steps/claim",
      ...input,
    })).step,
    planStep: async (input) => stepPlanResponseSchema.parse(await call({
      path: "/api/internal/agent-adapter/github-mutations/steps/plan",
      ...input,
    })).plan,
    completeStep: async (input) => stepCompletionResponseSchema.parse(await call({
      path: "/api/internal/agent-adapter/github-mutations/steps/complete",
      ...input,
    })).completion,
    readback: async (input) => readbackResponseSchema.parse(await call({
      path: "/api/internal/agent-adapter/github-mutations/readback",
      ...input,
    })),
  };
}

function workerBearerPath(principal: WorkerPrincipal): string {
  return principal === GENERIC_WORKER_PRINCIPALS.CODEX
    ? "backoffice/codex.bearer"
    : "backoffice/claude.bearer";
}

async function proxyQueue(input: {
  principal: WorkerPrincipal;
  workerRuntimeBindingDigest: string;
  operation: "CLAIM" | "HEARTBEAT" | "COMPLETE" | "FAIL" | "READBACK_REQUIRED" | "READBACK_RESOLVE";
  requestId: string;
  rawBody: unknown;
  fetchImpl: typeof globalThis.fetch;
}): Promise<unknown> {
  const routes = {
    CLAIM: "/api/internal/agents/claim",
    HEARTBEAT: "/api/internal/agents/heartbeat",
    COMPLETE: "/api/internal/agents/complete",
    FAIL: "/api/internal/agents/fail",
    READBACK_REQUIRED: "/api/internal/agents/readback-required",
    READBACK_RESOLVE: "/api/internal/agents/readback",
  } as const;
  const body = input.operation === "CLAIM"
    ? {
      ...claimBodySchema.parse(input.rawBody),
      workerId: input.principal,
      agentKind: agentKindForWorkerPrincipal(input.principal),
    }
    : input.operation === "HEARTBEAT"
      ? agentHeartbeatSchema.parse(input.rawBody)
      : input.operation === "COMPLETE"
        ? agentCompletionSchema.parse(input.rawBody)
        : input.operation === "FAIL"
          ? agentFailureSchema.parse(input.rawBody)
          : input.operation === "READBACK_REQUIRED"
            ? agentReadbackRequiredSchema.parse(input.rawBody)
            : agentReadbackResolutionSchema.parse(input.rawBody);
  return withBoundSecretText({
    root: FIXED_ROOT,
    relativePath: workerBearerPath(input.principal),
    allowGroupRead: true,
    maxBytes: 4096,
  }, (bearer) => backofficeRequest({
    path: routes[input.operation],
    body: asJson(body),
    principalId: input.principal,
    bearer,
    requestId: input.requestId,
    fetchImpl: input.fetchImpl,
    workerRuntimeBindingDigest: input.workerRuntimeBindingDigest,
  }));
}

async function main() {
  const backofficeCa = await readBoundSecretFile({
    root: FIXED_ROOT,
    relativePath: "backoffice/ca.pem",
    allowGroupRead: true,
  });
  const proxyBinding = {
    root: FIXED_ROOT,
    proxyOrigin: process.env.SEORI_EGRESS_PROXY_ORIGIN?.trim() || "",
    proxyServerName: process.env.SEORI_EGRESS_PROXY_SERVER_NAME?.trim() || "",
  };
  const backofficeEgress = await createExactMtlsProxyClient({
    ...proxyBinding,
    allowedHosts: exactHostSet("backoffice.vzyx.xyz"),
    targetCa: backofficeCa,
  });
  let githubEgress: Awaited<ReturnType<typeof createExactMtlsProxyClient>>;
  try {
    githubEgress = await createExactMtlsProxyClient({
      ...proxyBinding,
      allowedHosts: exactHostSet("api.github.com"),
    });
  } catch (error) {
    await backofficeEgress.close();
    throw error;
  }
  const attestationKeyBytes = await readBoundSecretFile({
    root: FIXED_ROOT,
    relativePath: "adapter/attestation-private.pem",
    allowGroupRead: true,
  });
  const attestationPrivateKey = createPrivateKey(attestationKeyBytes);
  attestationKeyBytes.fill(0);
  if (attestationPrivateKey.asymmetricKeyType !== "ed25519") throw new Error("SEORI_ADAPTER_ATTESTATION_KEY_INVALID");
  const controlPlane = createMutationControlPlane(
    attestationPrivateKey,
    backofficeEgress.fetch,
  );

  const handle = async (
    principal: WorkerPrincipal,
    workerRuntimeBindingDigest: string,
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/execute" || request.headers["content-type"] !== "application/json") {
        respond(response, 404, { error: { code: "route_not_found" } });
        return;
      }
      const envelope = seoriAuthPublicRequestSchema.parse(await readJson(request));
      if (["GITHUB_READY_PR", "GITHUB_READY_PR_READBACK"].includes(envelope.operation) && !READY_PR_RUNTIME_OPERATIONAL) {
        throw new Error("SEORI_GITHUB_READY_PR_RUNTIME_NOT_OPERATIONAL");
      }
      const result = envelope.operation === "GITHUB_READY_PR_READBACK"
        ? await (async () => {
          const recoveryRequest = recoveryRequestSchema.parse(envelope.body);
          const recovery = await controlPlane.recover({
            requestId: `ghr:${jsonDigest({ requestId: envelope.requestId } as JsonValue)}`,
            body: {
              sessionId: recoveryRequest.sessionId,
              workerPrincipalId: principal,
              workerRuntimeBindingDigest,
            },
          });
          return withBoundSecretText({
            root: FIXED_ROOT,
            relativePath: "github/app-private.pem",
            allowGroupRead: true,
          }, async (privateKey) => withGithubPort({
            privateKey,
            repoId: recovery.repoId,
            repoFullName: recovery.repoFullName,
            fetchImpl: githubEgress.fetch,
            execute: (github) => recoverGithubReadyPr({
              operationId: envelope.requestId,
              sessionId: recoveryRequest.sessionId,
              workerPrincipalId: principal,
              workerRuntimeBindingDigest,
              recovery,
              github,
              controlPlane,
            }),
          }));
        })()
        : envelope.operation === "GITHUB_READY_PR"
        ? await withBoundSecretText({
          root: FIXED_ROOT,
          relativePath: "github/app-private.pem",
          allowGroupRead: true,
        }, async (privateKey) => {
          const binding = z.object({
            repoId: z.string().regex(/^[1-9]\d{0,15}$/),
            repoFullName: z.string(),
          }).passthrough().parse(envelope.body);
          return withGithubPort({
            privateKey,
            repoId: binding.repoId,
            repoFullName: binding.repoFullName,
            fetchImpl: githubEgress.fetch,
            execute: (github) => executeGithubReadyPr({
              operationId: envelope.requestId,
              workerPrincipalId: principal,
              workerRuntimeBindingDigest,
              rawCommand: envelope.body,
              github,
              controlPlane,
            }),
          });
        })
        : await proxyQueue({
          principal,
          workerRuntimeBindingDigest,
          operation: envelope.operation,
          requestId: envelope.requestId,
          rawBody: envelope.body,
          fetchImpl: backofficeEgress.fetch,
        });
      respond(response, 200, { ok: true, result });
    } catch (error) {
      if (error instanceof z.ZodError) respond(response, 400, { error: { code: "invalid_request" } });
      else respond(response, 409, { error: { code: "seori_auth_request_rejected" } });
    }
  };

  const [clientCa, certificate, key] = await Promise.all([
    readBoundSecretFile({ root: FIXED_ROOT, relativePath: "server/client-ca.pem", allowGroupRead: true }),
    readBoundSecretFile({ root: FIXED_ROOT, relativePath: "server/tls.crt", allowGroupRead: true }),
    readBoundSecretFile({ root: FIXED_ROOT, relativePath: "server/tls.key", allowGroupRead: true }),
  ]);
  const codexSpiffePrefix = process.env.SEORI_AUTH_CODEX_SPIFFE_PREFIX?.trim() || "";
  const claudeSpiffePrefix = process.env.SEORI_AUTH_CLAUDE_SPIFFE_PREFIX?.trim() || "";
  const port = Number(process.env.SEORI_AUTH_AGENT_PORT ?? "9443");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("SEORI_AUTH_AGENT_PORT_INVALID");
  const server = createHttpsServer({
    ca: clientCa,
    cert: certificate,
    key,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
  }, (request, response) => {
    try {
      const socket = request.socket as TLSSocket;
      if (!socket.authorized) throw new Error("SEORI_AUTH_WORKER_MTLS_REQUIRED");
      const certificate = socket.getPeerCertificate(true);
      const identity = workerIdentityFromMtlsPeer({
        subjectAltName: certificate.subjectaltname,
        fingerprint256: certificate.fingerprint256,
        serialNumber: certificate.serialNumber,
        codexSpiffePrefix,
        claudeSpiffePrefix,
      });
      void handle(identity.principal, identity.runtimeBindingDigest, request, response);
    } catch {
      respond(response, 401, { error: { code: "worker_identity_rejected" } });
    }
  });
  server.listen(port, "0.0.0.0", () => console.log(`[seori-auth-agent-runtime] ready transport=mtls port=${port}`));
  const shutdown = () => server.close(() => void Promise.all([
    backofficeEgress.close(),
    githubEgress.close(),
  ]).finally(() => {
    backofficeCa.fill(0);
    clientCa.fill(0);
    certificate.fill(0);
    key.fill(0);
  }));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(() => {
  console.error("[seori-auth-agent-runtime] 종료 code=RUNTIME_FATAL");
  process.exitCode = 1;
});
