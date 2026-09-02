import { createHash } from "node:crypto";
import { parse } from "yaml";
import {
  githubProtectionPlanReadback,
  githubProtectionReadback,
} from "seorilabs-org-contracts/repo-contract/github-settings-readback";

import type { FleetGitHubAppPublicSource } from "@/lib/github/app";

const ORGANIZATION = "seorilabs";
const ORGANIZATION_ID = "283115031";
const CENTRAL_REPOSITORY_ID = "1241442018";
const CENTRAL_FULL_NAME = "seorilabs/.github";
const CENTRAL_CONTRACT_PATH = "contracts/fleet-p3-runtime.yaml";
const ORG_CONTRACT_CALLER_PATH = ".github/workflows/org-contract.yml";
const API_VERSION = "2026-03-10";
const SHA = /^[0-9a-f]{40}$/u;
const NUMERIC_ID = /^[1-9][0-9]{0,15}$/u;
const REPOSITORY = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const MAX_CONTRACT_BYTES = 1024 * 1024;

export interface FleetP7ReadClient {
  request(route: string, parameters?: Record<string, unknown>, scope?: FleetP7RepositoryTarget): Promise<{ data: unknown }>;
}
type ReadClient = FleetP7ReadClient;

interface InventoryRepository {
  repository: { id: string; fullName: string; sourceSha: string; private: boolean; classification: string };
}

export interface FleetP7RepositoryTarget { repositoryId: string; fullName: string }
type Target = FleetP7RepositoryTarget;
const CENTRAL_TARGET = { repositoryId: CENTRAL_REPOSITORY_ID, fullName: CENTRAL_FULL_NAME };
interface CentralConfiguration {
  targets: Target[];
  protection: { branch: "main"; requiredStatusCheck: string };
}

export interface FleetP7GitHubPublicReadback {
  currentCentralSourceSha: string;
  centralContract: { sourceSha: string; schemaVersion: 4; contentDigest: string };
  installation: Record<string, unknown> | null;
  organizationCustomProperties: Array<Record<string, unknown>> | null;
  protection: {
    providerMode: "REPO_BRANCH_PROTECTION";
    rolloutMode: "SHADOW";
    observationMode: "READ_ONLY";
    existingProtectionChanged: false;
    activationAllowed: false;
    repositories: Array<Record<string, unknown>>;
    ready: boolean;
  } | null;
  defaultBranchOrgContractCallers: Array<{ fullName: string }> | null;
}

function fail(code: string): never { throw new Error(code); }

function unavailableObservation(error: unknown): null {
  const code = error instanceof Error ? error.message : "";
  if (/^FLEET_GITHUB_TOKEN_|^FLEET_P7_READ_SCOPE_/u.test(code)) fail("FLEET_P7_CREDENTIAL_BOUNDARY_FAILED");
  return null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") fail("FLEET_P7_GITHUB_READBACK_INVALID");
  return value as Record<string, unknown>;
}

function repositoryId(value: unknown): string {
  const id = String(value ?? "");
  if (!NUMERIC_ID.test(id) || !Number.isSafeInteger(Number(id))) fail("FLEET_P7_REPOSITORY_ID_INVALID");
  return id;
}

function inventoryRepositories(inventory: Record<string, unknown>): InventoryRepository[] {
  if (!Array.isArray(inventory.repositories)) fail("FLEET_P7_GITHUB_INVENTORY_INVALID");
  const repositories = inventory.repositories.map((item) => {
    const repository = record(record(item).repository);
    repositoryId(repository.id);
    if (!REPOSITORY.test(String(repository.fullName ?? "")) || !SHA.test(String(repository.sourceSha ?? ""))
      || typeof repository.private !== "boolean" || typeof repository.classification !== "string") {
      fail("FLEET_P7_GITHUB_INVENTORY_INVALID");
    }
    return { repository } as unknown as InventoryRepository;
  });
  if (new Set(repositories.map(({ repository }) => repository.id)).size !== repositories.length
    || new Set(repositories.map(({ repository }) => repository.fullName)).size !== repositories.length) {
    fail("FLEET_P7_GITHUB_INVENTORY_INVALID");
  }
  return repositories;
}

function centralConfiguration(bytes: Buffer): CentralConfiguration {
  const root = record(parse(bytes.toString("utf8")));
  const github = record(root.github);
  const protection = record(github.protection);
  if (root.schemaVersion !== 4 || github.organization !== ORGANIZATION || github.apiVersion !== API_VERSION
    || protection.accountPlan !== "TEAM" || protection.providerMode !== "REPO_BRANCH_PROTECTION"
    || protection.rolloutMode !== "SHADOW" || protection.observationMode !== "READ_ONLY"
    || protection.branch !== "main" || protection.preserveExisting !== true || protection.activationRequiresApproval !== true
    || typeof protection.requiredStatusCheck !== "string" || !/^[^\u0000-\u001f]{1,256}$/u.test(protection.requiredStatusCheck)
    || !Array.isArray(protection.repositories) || protection.repositories.length < 1 || protection.repositories.length > 100) {
    fail("FLEET_P7_CENTRAL_CONTRACT_INVALID");
  }
  const bindings = record(record(root.cloudBuild).githubActions).repositoryBindings;
  if (!Array.isArray(bindings)) fail("FLEET_P7_CENTRAL_CONTRACT_INVALID");
  const targets = protection.repositories.map((name) => {
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/u.test(name)) fail("FLEET_P7_CENTRAL_CONTRACT_INVALID");
    const fullName = ORGANIZATION + "/" + name;
    const matches = bindings.map(record).filter((binding) => binding.fullName === fullName);
    if (matches.length !== 1) fail("FLEET_P7_CENTRAL_CONTRACT_INVALID");
    return { repositoryId: repositoryId(matches[0].repositoryId), fullName };
  }).sort((left, right) => left.fullName.localeCompare(right.fullName));
  if (new Set(targets.map((target) => target.repositoryId)).size !== targets.length
    || new Set(targets.map((target) => target.fullName)).size !== targets.length) {
    fail("FLEET_P7_CENTRAL_CONTRACT_INVALID");
  }
  return { targets, protection: { branch: "main", requiredStatusCheck: protection.requiredStatusCheck } };
}

async function readContent(client: ReadClient, target: Target, path: string, ref: string): Promise<Buffer> {
  const { fullName } = target;
  const [owner, repo] = fullName.split("/");
  const data = record((await client.request("GET /repos/{owner}/{repo}/contents/{path}", { owner, repo, path, ref }, target)).data);
  if (data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string"
    || typeof data.size !== "number" || !Number.isSafeInteger(data.size) || data.size < 1 || data.size > MAX_CONTRACT_BYTES
    || typeof data.sha !== "string" || !SHA.test(data.sha)) fail("FLEET_P7_GITHUB_CONTENT_INVALID");
  const bytes = Buffer.from(data.content.replace(/\s/gu, ""), "base64");
  const blobSha = createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
  if (bytes.length !== data.size || blobSha !== data.sha) {
    bytes.fill(0);
    fail("FLEET_P7_GITHUB_CONTENT_INVALID");
  }
  return bytes;
}

async function readRepository(client: ReadClient, target: Target): Promise<Record<string, unknown>> {
  const data = record((await client.request("GET /repositories/{repository_id}", { repository_id: Number(target.repositoryId) }, target)).data);
  if (repositoryId(data.id) !== target.repositoryId || data.full_name !== target.fullName
    || record(data.owner).id !== Number(ORGANIZATION_ID) || data.default_branch !== "main" || data.archived !== false) {
    fail("FLEET_P7_REPOSITORY_IDENTITY_DRIFT");
  }
  return data;
}

async function readHead(client: ReadClient, target: Target): Promise<string> {
  const { fullName } = target;
  const [owner, repo] = fullName.split("/");
  const data = record((await client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo, ref: "heads/main" }, target)).data);
  const sha = record(data.object).sha;
  if (typeof sha !== "string" || !SHA.test(sha)) fail("FLEET_P7_SOURCE_READBACK_INVALID");
  return sha;
}

function installationReadback(source: FleetGitHubAppPublicSource): Record<string, unknown> {
  return {
    app_id: Number(source.app.id), app_slug: source.app.slug, id: Number(source.installation.installationId),
    repository_selection: source.installation.repositorySelection, suspended_at: source.installation.suspendedAt,
    permissions: structuredClone(source.installation.permissions), events: [...source.installation.events],
  };
}

async function readCustomProperties(client: ReadClient): Promise<Array<Record<string, unknown>>> {
  const response = await client.request("GET /orgs/{org}/properties/schema", { org: ORGANIZATION }, CENTRAL_TARGET);
  if (!Array.isArray(response.data)) fail("FLEET_P7_CUSTOM_PROPERTIES_INVALID");
  return response.data.map((item) => {
    const property = record(item);
    return {
      property_name: property.property_name, value_type: property.value_type, required: property.required,
      description: property.description, allowed_values: property.allowed_values,
      values_editable_by: property.values_editable_by, require_explicit_values: property.require_explicit_values,
    };
  });
}

async function readProtection(client: ReadClient, configuration: CentralConfiguration,
  repositories: Array<Target & { sourceSha: string; actual: Record<string, unknown> }>,
  now: () => Date): Promise<NonNullable<FleetP7GitHubPublicReadback["protection"]>> {
  const org = (await client.request("GET /orgs/{org}", { org: ORGANIZATION }, CENTRAL_TARGET)).data;
  if (githubProtectionPlanReadback(org, { organization: ORGANIZATION, organizationId: ORGANIZATION_ID }).protection !== "SUPPORTED") {
    fail("FLEET_P7_PROTECTION_CAPABILITY_UNVERIFIED");
  }
  const observations = await Promise.all(repositories.map(async ({ actual, ...binding }) => {
    const [owner, repo] = binding.fullName.split("/");
    const parameters = { owner, repo, branch: configuration.protection.branch };
    let branchProtection: unknown;
    try {
      branchProtection = (await client.request("GET /repos/{owner}/{repo}/branches/{branch}/protection", parameters, binding)).data;
    } catch (error) {
      const provider = error as { status?: unknown; response?: { data?: { message?: unknown } } };
      if (provider.status !== 404 || provider.response?.data?.message !== "Branch not protected") throw error;
      branchProtection = null;
    }
    const activeRules = (await client.request("GET /repos/{owner}/{repo}/rules/branches/{branch}", parameters, binding)).data;
    return githubProtectionReadback(configuration.protection, binding,
      { repository: actual, branchProtection, activeRules }, now().toISOString());
  }));
  return {
    providerMode: "REPO_BRANCH_PROTECTION", rolloutMode: "SHADOW", observationMode: "READ_ONLY",
    existingProtectionChanged: false, activationAllowed: false, repositories: observations,
    ready: observations.every((row) => row.state === "OBSERVED"),
  };
}

async function readOrgContractCallers(client: ReadClient, repositories: Array<Target & { sourceSha: string }>) {
  const callers = [];
  for (const repository of repositories) {
    // An opaque 404 may be a visibility failure. Do not turn it into proven absence.
    const content = await readContent(client, repository, ORG_CONTRACT_CALLER_PATH, repository.sourceSha);
    content.fill(0);
    callers.push({ fullName: repository.fullName });
  }
  return callers;
}

export function createFleetP7GitHubReadbackAdapter(input: {
  client: FleetP7ReadClient;
  readAppSource: () => Promise<FleetGitHubAppPublicSource>;
  now?: () => Date;
}) {
  const client: ReadClient = {
    request: (route, parameters, scope) => {
      if (!route.startsWith("GET /")) fail("FLEET_P7_GITHUB_MUTATION_FORBIDDEN");
      return input.client.request(route, {
        ...parameters, baseUrl: "https://api.github.com",
        headers: { "X-GitHub-Api-Version": API_VERSION },
        request: { redirect: "error", signal: AbortSignal.timeout(15_000) },
      }, scope);
    },
  };
  async function observe(inventory?: InventoryRepository[]): Promise<FleetP7GitHubPublicReadback> {
    try {
      await readRepository(client, CENTRAL_TARGET);
      const currentCentralSourceSha = await readHead(client, CENTRAL_TARGET);
      const bytes = await readContent(client, CENTRAL_TARGET, CENTRAL_CONTRACT_PATH, currentCentralSourceSha);
      let configuration: CentralConfiguration;
      let contentDigest: string;
      try {
        contentDigest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
        configuration = centralConfiguration(bytes);
      } finally { bytes.fill(0); }
      const repositories = await Promise.all(configuration.targets.map(async (target) => {
        const expected = inventory?.find(({ repository }) => repository.fullName === target.fullName)?.repository;
        if (inventory && (!expected || expected.id !== target.repositoryId)) fail("FLEET_P7_TARGET_INVENTORY_INCOMPLETE");
        const actual = await readRepository(client, target);
        const sourceSha = await readHead(client, target);
        if (expected && expected.sourceSha !== sourceSha) fail("FLEET_P7_TARGET_SOURCE_DRIFT");
        return { ...target, sourceSha, actual };
      }));
      const [installation, organizationCustomProperties, protection, callers] = await Promise.all([
        input.readAppSource().then(installationReadback).catch(unavailableObservation),
        readCustomProperties(client).catch(unavailableObservation),
        readProtection(client, configuration, repositories, input.now ?? (() => new Date())).catch(unavailableObservation),
        readOrgContractCallers(client, repositories).catch(unavailableObservation),
      ]);
      const subjects = [{ ...CENTRAL_TARGET, sourceSha: currentCentralSourceSha }, ...repositories];
      await Promise.all(subjects.map(async (subject) => {
        if (await readHead(client, subject) !== subject.sourceSha) fail("FLEET_P7_SOURCE_CHANGED_DURING_READBACK");
      }));
      return {
        currentCentralSourceSha, centralContract: { sourceSha: currentCentralSourceSha, schemaVersion: 4, contentDigest },
        installation, organizationCustomProperties, protection, defaultBranchOrgContractCallers: callers,
      };
    } catch (error) {
      const code = error instanceof Error && /^FLEET_P7_[A-Z0-9_]+$/u.test(error.message)
        ? error.message : "FLEET_P7_GITHUB_READBACK_FAILED";
      throw new Error(code);
    }
  }
  return Object.freeze({
    read: async (inventory: Record<string, unknown>) => observe(inventoryRepositories(inventory)),
    // Diagnostic provider observation only. No signed inventory or execution authority.
    observeCurrentTargets: () => observe(),
  });
}
