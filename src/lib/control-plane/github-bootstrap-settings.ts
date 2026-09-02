import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";

import { createFleetP7RequestFetch, createFleetP7ScopedReadClient } from "./fleet-p7-scoped-read-client";
import { canonicalJson, jsonDigest, type JsonValue } from "./json";
import type { FleetGitHubAppPublicSource } from "@/lib/github/app";
import { withFleetScopedGithubClient, type FleetScopedGithubTokenIssuer } from "@/lib/github/scoped-installation-client";
import type { FleetP7ReadClient, FleetP7RepositoryTarget } from "./fleet-p7-github-readback";

const CENTRAL = { repositoryId: "1241442018", fullName: "seorilabs/.github" };
const ORGANIZATION_ID = "283115031";
const APP_ID = "4124446";
const INSTALLATION_ID = "142120077";
const CREDENTIAL_ID = "shared/github/backoffice-app-private-key";
const CONTRACT_PATH = "contracts/fleet-p3-runtime.yaml";
const API_VERSION = "2026-03-10";
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const names = z.enum(["fleet-managed", "fleet-profile", "fleet-ruleset", "fleet-state"]);
const propertySchema = z.object({
  property_name: names, value_type: z.literal("single_select"), required: z.literal(false),
  description: z.string().min(1).max(200), allowed_values: z.array(z.string().min(1).max(64)).min(1).max(20),
  values_editable_by: z.literal("org_actors"), require_explicit_values: z.literal(true),
}).strict();
const targetSchema = z.object({ repositoryId: z.string().regex(/^[1-9][0-9]{0,15}$/u), fullName: z.string().regex(/^seorilabs\/[A-Za-z0-9._-]+$/u) }).strict();
const operationSchema = z.object({
  kind: z.enum(["SCHEMA", "VALUES"]), target: targetSchema,
  desired: z.record(z.unknown()), beforeDigest: digest,
}).strict();

export const githubBootstrapPlanSchema = z.object({
  version: z.literal(1), sourceSha: sha, contractDigest: digest,
  credentialId: z.literal(CREDENTIAL_ID), appId: z.literal(APP_ID), installationId: z.literal(INSTALLATION_ID),
  organizationId: z.literal(ORGANIZATION_ID), operations: z.array(operationSchema).length(6),
}).strict();
export type GitHubBootstrapPlan = z.infer<typeof githubBootstrapPlanSchema>;
export type GitHubBootstrapOperation = GitHubBootstrapPlan["operations"][number];

function fail(code: string): never { throw new Error(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") fail("GITHUB_BOOTSTRAP_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
export function githubSettingsDigest(value: unknown): string {
  return jsonDigest(value as JsonValue);
}
function equal(left: unknown, right: unknown): boolean { return githubSettingsDigest(left) === githubSettingsDigest(right); }

/** Only the four centrally owned metadata definitions and two SHADOW pilot values are executable. */
export function githubBootstrapDesiredOperations(document: unknown): Array<Omit<GitHubBootstrapOperation, "beforeDigest">> {
  const root = object(document);
  const github = object(root.github);
  const trusted = object(github.trustedExecution);
  const protection = object(github.protection);
  const app = object(github.app);
  if (root.schemaVersion !== 4 || github.organization !== "seorilabs" || github.apiVersion !== API_VERSION
    || trusted.appPrivateKeyCredentialId !== CREDENTIAL_ID || trusted.appId !== Number(APP_ID)
    || trusted.installationId !== Number(INSTALLATION_ID) || trusted.ambientPersonalTokenAllowed !== false
    || app.appId !== Number(APP_ID) || app.installationId !== Number(INSTALLATION_ID)
    || app.reuseExisting !== true || app.repositorySelection !== "all"
    || protection.rolloutMode !== "SHADOW" || protection.observationMode !== "READ_ONLY"
    || protection.providerMode !== "REPO_BRANCH_PROTECTION" || protection.preserveExisting !== true
    || protection.activationRequiresApproval !== true) fail("GITHUB_BOOTSTRAP_CONTRACT_INVALID");
  const properties = z.array(propertySchema).length(4).parse(github.customProperties);
  if (new Set(properties.map((property) => property.property_name)).size !== 4
    || properties.some((property) => new Set(property.allowed_values).size !== property.allowed_values.length)) {
    fail("GITHUB_BOOTSTRAP_CONTRACT_INVALID");
  }
  const pilots = z.array(z.object({ repository: z.enum(["happy-farm", "lizard-tycoon"]), values: z.record(z.string()) }).strict()).length(2).parse(github.pilotValues);
  if (new Set(pilots.map(({ repository }) => repository)).size !== 2) fail("GITHUB_BOOTSTRAP_CONTRACT_INVALID");
  const bindings = z.array(z.object({ repositoryId: z.string(), fullName: z.string() }).passthrough()).parse(object(object(root.cloudBuild).githubActions).repositoryBindings);
  const operations: Array<Omit<GitHubBootstrapOperation, "beforeDigest">> = properties.map((property) => ({
    kind: "SCHEMA", target: CENTRAL, desired: property,
  }));
  for (const pilot of pilots) {
    const matches = bindings.filter(({ fullName }) => fullName === `seorilabs/${pilot.repository}`);
    if (matches.length !== 1 || !equal(Object.keys(pilot.values).sort(), properties.map(({ property_name }) => property_name).sort())
      || pilot.values["fleet-managed"] !== "true" || pilot.values["fleet-ruleset"] !== "shadow" || pilot.values["fleet-state"] !== "active"
      || pilot.values["fleet-profile"] !== (pilot.repository === "happy-farm" ? "react-native" : "godot")
      || properties.some(({ property_name, allowed_values }) => !allowed_values.includes(pilot.values[property_name]))) {
      fail("GITHUB_BOOTSTRAP_CONTRACT_INVALID");
    }
    operations.push({ kind: "VALUES", target: targetSchema.parse({ repositoryId: matches[0].repositoryId, fullName: matches[0].fullName }), desired: pilot.values });
  }
  if (new Set(operations.filter(({ kind }) => kind === "VALUES").map(({ target }) => target.repositoryId)).size !== 2) {
    fail("GITHUB_BOOTSTRAP_CONTRACT_INVALID");
  }
  return operations;
}

function assertApp(source: FleetGitHubAppPublicSource, now: Date): void {
  const { app, installation } = source;
  const age = now.getTime() - Date.parse(source.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 60_000
    || app.id !== APP_ID || app.slug !== "seorilabs-backoffice" || app.ownerId !== ORGANIZATION_ID
    || app.ownerLogin !== "seorilabs" || !app.active || !app.webhookActive
    || app.webhookUrl !== "https://backoffice.vzyx.xyz/api/webhooks"
    || installation.installationId !== INSTALLATION_ID || installation.appId !== APP_ID
    || installation.targetId !== ORGANIZATION_ID || installation.accountLogin !== "seorilabs"
    || installation.targetType !== "Organization" || installation.repositorySelection !== "all" || installation.suspended
    || installation.permissions.organization_custom_properties !== "admin"
    || installation.permissions.repository_custom_properties !== "write"
    || !installation.events.includes("repository") || !installation.events.includes("push")) {
    fail("GITHUB_BOOTSTRAP_APP_APPROVAL_REQUIRED");
  }
}

export interface GitHubBootstrapAdapter {
  assertOwner(login: string, githubId: string): Promise<void>;
  plan(): Promise<GitHubBootstrapPlan>;
  verify(plan: GitHubBootstrapPlan): Promise<void>;
  read(operation: GitHubBootstrapOperation): Promise<unknown>;
  apply(operation: GitHubBootstrapOperation): Promise<void>;
}

export function createGitHubBootstrapAdapter(input: {
  issuer: FleetScopedGithubTokenIssuer<FleetP7ReadClient>;
  installationId: string;
  readApp: () => Promise<FleetGitHubAppPublicSource>;
  now?: () => Date;
}): GitHubBootstrapAdapter {
  if (input.installationId !== INSTALLATION_ID) fail("GITHUB_BOOTSTRAP_INSTALLATION_MISMATCH");
  const now = input.now ?? (() => new Date());
  const readClient = createFleetP7ScopedReadClient(input);
  let verifiedOperations = new Set<string>();
  const parameters = (target: FleetP7RepositoryTarget) => ({ owner: "seorilabs", repo: target.fullName.split("/")[1] });
  async function identity(target: FleetP7RepositoryTarget): Promise<void> {
    const actual = object((await readClient.request("GET /repositories/{repository_id}", { repository_id: Number(target.repositoryId) }, target)).data);
    if (String(actual.id) !== target.repositoryId || actual.full_name !== target.fullName || actual.default_branch !== "main"
      || actual.archived !== false || String(object(actual.owner).id) !== ORGANIZATION_ID
      || target.fullName !== CENTRAL.fullName && (actual.private !== true || actual.fork !== false)) fail("GITHUB_BOOTSTRAP_REPOSITORY_DRIFT");
  }
  async function source() {
    assertApp(await input.readApp(), now());
    await identity(CENTRAL);
    const head = object((await readClient.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { ...parameters(CENTRAL), ref: "heads/main" }, CENTRAL)).data);
    const sourceSha = sha.parse(object(head.object).sha);
    const file = object((await readClient.request("GET /repos/{owner}/{repo}/contents/{path}", { ...parameters(CENTRAL), path: CONTRACT_PATH, ref: sourceSha }, CENTRAL)).data);
    if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string"
      || typeof file.size !== "number" || file.size < 1 || file.size > 1024 * 1024 || file.content.length > 2 * 1024 * 1024) fail("GITHUB_BOOTSTRAP_SOURCE_INVALID");
    const bytes = Buffer.from(file.content.replace(/\s/gu, ""), "base64");
    if (bytes.length !== file.size || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== file.sha) fail("GITHUB_BOOTSTRAP_SOURCE_INVALID");
    return { sourceSha, contractDigest: createHash("sha256").update(bytes).digest("hex"), operations: githubBootstrapDesiredOperations(parse(bytes.toString("utf8"))) };
  }
  async function read(operation: GitHubBootstrapOperation): Promise<unknown> {
    await identity(operation.target);
    if (operation.kind === "SCHEMA") {
      const response = await readClient.request("GET /orgs/{org}/properties/schema", { org: "seorilabs" }, CENTRAL);
      const entries = z.array(z.record(z.unknown())).parse(response.data);
      const matches = entries.filter((entry) => entry.property_name === operation.desired.property_name);
      if (matches.length > 1) fail("GITHUB_BOOTSTRAP_RESPONSE_INVALID");
      if (!matches[0]) return null;
      // Preserve/compare optional semantics too; never silently erase an unexpected default.
      const entry = { ...matches[0] };
      const sourceType = entry.source_type;
      delete entry.url;
      delete entry.source_type;
      if (sourceType !== "organization") fail("GITHUB_BOOTSTRAP_SCHEMA_OWNERSHIP_MISMATCH");
      if (entry.default_value === null) delete entry.default_value;
      return entry;
    }
    return withFleetScopedGithubClient({ ...input, capability: "github.bootstrap.properties-read",
      repositoryId: operation.target.repositoryId, repositoryFullName: operation.target.fullName,
      execute: async (client) => {
        const response = await client.request("GET /repos/{owner}/{repo}/properties/values", { ...parameters(operation.target), baseUrl: "https://api.github.com", headers: { "X-GitHub-Api-Version": API_VERSION } });
        const entries = z.array(z.object({ property_name: z.string(), value: z.union([z.string(), z.array(z.string()), z.null()]) }).strict()).parse(response.data);
        if (new Set(entries.map(({ property_name }) => property_name)).size !== entries.length) fail("GITHUB_BOOTSTRAP_RESPONSE_INVALID");
        return Object.fromEntries(Object.keys(operation.desired).sort().map((name) => [name, entries.find(({ property_name }) => property_name === name)?.value ?? null]));
      },
    });
  }
  return {
    async assertOwner(login, githubId) {
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(login) || !/^[1-9][0-9]{0,31}$/u.test(githubId)) fail("GITHUB_BOOTSTRAP_ORGANIZATION_OWNER_REQUIRED");
      await withFleetScopedGithubClient({ ...input, capability: "github.bootstrap.owner-read", repositoryId: CENTRAL.repositoryId, repositoryFullName: CENTRAL.fullName,
        execute: async (client) => {
          const membership = object((await client.request("GET /orgs/{org}/memberships/{username}", { org: "seorilabs", username: login,
            baseUrl: "https://api.github.com", headers: { "X-GitHub-Api-Version": API_VERSION } })).data);
          const organization = object(membership.organization);
          const user = object(membership.user);
          if (membership.role !== "admin" || membership.state !== "active" || organization.login !== "seorilabs"
            || String(organization.id) !== ORGANIZATION_ID || String(user.id) !== githubId || user.login !== login
            || user.type !== "User") fail("GITHUB_BOOTSTRAP_ORGANIZATION_OWNER_REQUIRED");
        },
      });
    },
    async plan() {
      const current = await source();
      const operations = [];
      for (const operation of current.operations) {
        const bound = { ...operation, beforeDigest: "0".repeat(64) };
        operations.push({ ...operation, beforeDigest: githubSettingsDigest(await read(bound)) });
      }
      return githubBootstrapPlanSchema.parse({ ...current, version: 1, credentialId: CREDENTIAL_ID,
        appId: APP_ID, installationId: INSTALLATION_ID, organizationId: ORGANIZATION_ID, operations });
    },
    async verify(plan) {
      verifiedOperations = new Set();
      const parsed = githubBootstrapPlanSchema.parse(plan);
      const current = await source();
      if (parsed.sourceSha !== current.sourceSha || parsed.contractDigest !== current.contractDigest
        || !equal(parsed.operations.map(({ kind, target, desired }) => ({ kind, target, desired })), current.operations)) fail("GITHUB_BOOTSTRAP_PLAN_STALE");
      for (const operation of parsed.operations) await identity(operation.target);
      verifiedOperations = new Set(parsed.operations.map(githubSettingsDigest));
    },
    read,
    async apply(operation) {
      if (!verifiedOperations.has(githubSettingsDigest(operation))) fail("GITHUB_BOOTSTRAP_OPERATION_NOT_VERIFIED");
      // The service additionally requires a human approval and a live database CAS lease.
      await identity(operation.target);
      const schema = operation.kind === "SCHEMA";
      if (schema && !equal(operation.target, CENTRAL)) fail("GITHUB_BOOTSTRAP_OPERATION_INVALID");
      if (schema) propertySchema.parse(operation.desired);
      else if (!equal(Object.keys(operation.desired).sort(), [...names.options].sort()) || Object.values(operation.desired).some((value) => typeof value !== "string")) fail("GITHUB_BOOTSTRAP_OPERATION_INVALID");
      await withFleetScopedGithubClient({ ...input,
        capability: schema ? "github.bootstrap.schema-write" : "github.bootstrap.properties-write",
        repositoryId: operation.target.repositoryId, repositoryFullName: operation.target.fullName,
        execute: async (client) => {
          const { property_name: name, ...body } = operation.desired;
          await client.request(schema ? "PUT /orgs/{org}/properties/schema/{custom_property_name}" : "PATCH /repos/{owner}/{repo}/properties/values", {
            ...(schema ? { org: "seorilabs", custom_property_name: name, ...body } : { ...parameters(operation.target), properties: Object.entries(operation.desired).map(([property_name, value]) => ({ property_name, value })) }),
            baseUrl: "https://api.github.com", headers: { "X-GitHub-Api-Version": API_VERSION },
          });
        },
      });
    },
  };
}

export async function productionGitHubBootstrapAdapter(): Promise<GitHubBootstrapAdapter> {
  const { getFleetScopedGithubTokenIssuer, readFleetGitHubAppPublicSource } = await import("@/lib/github/app");
  const requestFetch = createFleetP7RequestFetch();
  return createGitHubBootstrapAdapter({ ...await getFleetScopedGithubTokenIssuer({ requestFetch }),
    readApp: () => readFleetGitHubAppPublicSource({ requestFetch }) });
}

/** Stable public request binding, including the observed pre-change state. */
export function githubBootstrapPlanDigest(plan: GitHubBootstrapPlan): string {
  return createHash("sha256").update(canonicalJson(githubBootstrapPlanSchema.parse(plan) as JsonValue)).digest("hex");
}
