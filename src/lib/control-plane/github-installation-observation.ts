import { z } from "zod";

import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { recordProviderObservation } from "@/lib/control-plane/service";
import type { GitHubInstallationPublicState } from "@/lib/github/installation-public-state";
import { prisma } from "@/lib/prisma";

export const GITHUB_INSTALLATION_OBSERVATION_VERSION =
  "github-installation-readback/v1" as const;

const CAPABILITY_REQUIREMENTS = {
  repositoryDiscovery: {
    permissions: { metadata: "read", contents: "read" },
    events: ["push", "repository"],
  },
  callerBootstrapPullRequest: {
    permissions: { contents: "write", pull_requests: "write", workflows: "write" },
    events: ["pull_request"],
  },
  issueFanout: {
    permissions: { issues: "write" },
    events: ["issues", "issue_comment"],
  },
  requiredChecks: {
    permissions: { checks: "write" },
    events: ["pull_request"],
  },
  workflowDispatch: {
    permissions: { actions: "write" },
    events: ["workflow_run"],
  },
  repositoryEnvironments: {
    permissions: { environments: "write" },
    events: [],
  },
  organizationVariables: {
    permissions: { organization_actions_variables: "write" },
    events: [],
  },
  organizationSecrets: {
    permissions: { organization_secrets: "write" },
    events: [],
  },
  organizationCustomProperties: {
    permissions: { organization_custom_properties: "admin" },
    events: [],
  },
  organizationRulesets: {
    permissions: { organization_administration: "write" },
    events: [],
  },
} as const;

export type GitHubInstallationCapabilityKey = keyof typeof CAPABILITY_REQUIREMENTS;
type PermissionLevel = "read" | "write" | "admin";
type CapabilityState = "GRANTED" | "MISSING_REQUIREMENT";

const permissionLevelSchema = z.enum(["read", "write", "admin"]);
const capabilityStateSchema = z.enum(["GRANTED", "MISSING_REQUIREMENT"]);
const capabilitySchema = z.object({
  state: capabilityStateSchema,
  missing: z.array(z.string().regex(/^(?:installation:[a-z-]+|permission:[a-z0-9_]+:(?:read|write|admin)|event:[a-z0-9_]+)$/)).max(32),
}).strict();

export const githubInstallationProviderPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  visibility: z.literal("VISIBLE"),
  state: z.literal("PRESENT"),
  publicIdentity: z.string().regex(/^github-organization:[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
  attributes: z.object({
    contractVersion: z.literal(GITHUB_INSTALLATION_OBSERVATION_VERSION),
    installationId: z.string().regex(/^\d{1,30}$/),
    appId: z.string().regex(/^\d{1,30}$/),
    targetId: z.string().regex(/^\d{1,30}$/),
    accountLogin: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
    targetType: z.literal("Organization"),
    repositorySelection: z.enum(["all", "selected"]),
    suspended: z.boolean(),
    permissions: z.record(permissionLevelSchema),
    events: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,127}$/)).max(200),
    capabilities: z.object(Object.fromEntries(
      Object.keys(CAPABILITY_REQUIREMENTS).map((key) => [key, capabilitySchema]),
    ) as Record<GitHubInstallationCapabilityKey, typeof capabilitySchema>).strict(),
  }).strict(),
}).strict();

export type GitHubInstallationProviderPayload = z.infer<typeof githubInstallationProviderPayloadSchema>;

const PERMISSION_RANK: Record<PermissionLevel, number> = { read: 1, write: 2, admin: 3 };

function permissionGranted(
  permissions: GitHubInstallationPublicState["permissions"],
  permission: string,
  required: PermissionLevel,
): boolean {
  const actual = permissions[permission];
  return actual !== undefined && PERMISSION_RANK[actual] >= PERMISSION_RANK[required];
}

function installationRequirements(
  state: GitHubInstallationPublicState,
  organization: string,
): string[] {
  const missing: string[] = [];
  if (state.repositorySelection !== "all") missing.push("installation:all-repositories");
  if (state.targetType !== "Organization") missing.push("installation:organization-target");
  if (state.accountLogin.toLowerCase() !== organization.toLowerCase()) missing.push("installation:account-mismatch");
  if (state.suspended) missing.push("installation:suspended");
  return missing;
}

export function evaluateGitHubInstallationCapabilities(
  state: GitHubInstallationPublicState,
  organization: string,
): Record<GitHubInstallationCapabilityKey, { state: CapabilityState; missing: string[] }> {
  const common = installationRequirements(state, organization);
  return Object.fromEntries(Object.entries(CAPABILITY_REQUIREMENTS).map(([key, requirement]) => {
    const missing = [...common];
    for (const [permission, level] of Object.entries(requirement.permissions)) {
      if (!permissionGranted(state.permissions, permission, level as PermissionLevel)) {
        missing.push(`permission:${permission}:${level}`);
      }
    }
    for (const event of requirement.events) {
      if (!state.events.includes(event)) missing.push(`event:${event}`);
    }
    return [key, {
      state: missing.length === 0 ? "GRANTED" : "MISSING_REQUIREMENT",
      missing: missing.sort(),
    }];
  })) as Record<GitHubInstallationCapabilityKey, { state: CapabilityState; missing: string[] }>;
}

export function githubInstallationProviderPayload(
  state: GitHubInstallationPublicState,
  organization: string,
): GitHubInstallationProviderPayload {
  return githubInstallationProviderPayloadSchema.parse({
    schemaVersion: 1,
    visibility: "VISIBLE",
    state: "PRESENT",
    publicIdentity: `github-organization:${state.accountLogin}`,
    attributes: {
      contractVersion: GITHUB_INSTALLATION_OBSERVATION_VERSION,
      installationId: state.installationId,
      appId: state.appId,
      targetId: state.targetId,
      accountLogin: state.accountLogin,
      targetType: state.targetType,
      repositorySelection: state.repositorySelection,
      suspended: state.suspended,
      permissions: state.permissions,
      events: state.events,
      capabilities: evaluateGitHubInstallationCapabilities(state, organization),
    },
  });
}

type ManagedApp = { id: string; repoId: bigint; repoFullName: string };

export interface GitHubInstallationObservationResult {
  observed: number;
  duplicate: number;
  failed: number;
  state: "completed" | "partial";
  gate: "READY" | "BLOCKED";
}

export interface GitHubInstallationObservationDependencies {
  getPublicState: () => Promise<GitHubInstallationPublicState>;
  listApps: (organization: string) => Promise<ManagedApp[]>;
  record: typeof recordProviderObservation;
  now: () => Date;
}

const defaultDependencies: GitHubInstallationObservationDependencies = {
  getPublicState: async () => {
    const { getInstallationContext } = await import("@/lib/github/app");
    return (await getInstallationContext()).publicState;
  },
  listApps: async (organization) => {
    const apps = await prisma.app.findMany({
      where: { status: "ACTIVE", repoId: { not: null } },
      orderBy: [{ repoId: "asc" }, { id: "asc" }],
      select: { id: true, repoId: true, repoFullName: true },
    });
    return apps.flatMap((app) => (
      app.repoId !== null && app.repoFullName.toLowerCase().startsWith(`${organization.toLowerCase()}/`)
        ? [{ ...app, repoId: app.repoId }]
        : []
    ));
  },
  record: recordProviderObservation,
  now: () => new Date(),
};

/**
 * App-JWT installation의 공개 grant만 앱별 ProviderObservation/ExternalBinding에 투영한다.
 * GitHub에는 GET만 수행하며 설정, 변수, ruleset, Issue, PR을 쓰지 않는다.
 */
export async function recordGitHubInstallationObservations(
  input: { organization: string; occurrenceId: string },
  dependencies: GitHubInstallationObservationDependencies = defaultDependencies,
): Promise<GitHubInstallationObservationResult> {
  let state: GitHubInstallationPublicState;
  try {
    state = await dependencies.getPublicState();
  } catch {
    return { observed: 0, duplicate: 0, failed: 1, state: "partial", gate: "BLOCKED" };
  }
  const payload = githubInstallationProviderPayload(state, input.organization);
  const capabilities = payload.attributes.capabilities;
  const gate = Object.values(capabilities).every((capability) => capability.state === "GRANTED")
    ? "READY"
    : "BLOCKED";
  const observedAt = dependencies.now();
  let apps: ManagedApp[];
  try {
    apps = await dependencies.listApps(input.organization);
  } catch {
    return { observed: 0, duplicate: 0, failed: 1, state: "partial", gate };
  }
  let observed = 0;
  let duplicate = 0;
  let failed = 0;
  for (const app of apps) {
    try {
      const result = await dependencies.record({
        repoId: app.repoId,
        provider: "github",
        resourceType: "github-app-installation",
        resourceId: state.installationId,
        observedAt,
        observedBy: "scheduler:repository-discovery-backfill",
        idempotencyKey: `github-installation:${input.occurrenceId}:${app.repoId.toString()}`,
        payload,
        externalBinding: {
          bindingType: "github-app-installation-repository",
          externalId: `${state.installationId}:${app.repoId.toString()}`,
          publicIdentity: payload.publicIdentity,
          metadata: {
            contractVersion: GITHUB_INSTALLATION_OBSERVATION_VERSION,
            repoId: app.repoId.toString(),
            repoFullName: app.repoFullName,
            installationDigest: jsonDigest(payload as JsonValue),
          },
        },
      });
      if (result.duplicate) duplicate += 1;
      else observed += 1;
    } catch {
      failed += 1;
    }
  }
  return {
    observed,
    duplicate,
    failed,
    state: failed === 0 ? "completed" : "partial",
    gate,
  };
}
