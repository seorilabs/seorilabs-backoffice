import type { Octokit } from "octokit";
import { parse } from "yaml";

import type { FleetGitHubAppPublicSource } from "@/lib/github/app";

const ORGANIZATION = "seorilabs";
const CENTRAL_REPOSITORY_ID = "1241442018";
const CENTRAL_FULL_NAME = "seorilabs/.github";
export const FLEET_P7_CENTRAL_SOURCE_SHA = "f610f09b8e4b0cc8b19ed37673ea4d8b21c3f203" as const;
const CENTRAL_CONTRACT_PATH = "contracts/fleet-p3-runtime.yaml";
const ORG_CONTRACT_CALLER_PATH = ".github/workflows/org-contract.yml";
const SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const MAX_CONTRACT_BYTES = 1024 * 1024;

interface InventoryRepository {
  repository: {
    id: string;
    fullName: string;
    sourceSha: string;
    private: boolean;
    classification: string;
  };
}

export interface FleetP7GitHubPublicReadback {
  currentCentralSourceSha: string;
  installation: Record<string, unknown> | null;
  organizationCustomProperties: Array<Record<string, unknown>> | null;
  rulesets: Array<Record<string, unknown>> | null;
  defaultBranchOrgContractCallers: Array<{ fullName: string }> | null;
}

function fail(code: string): never {
  throw new Error(code);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    fail("FLEET_P7_GITHUB_READBACK_INVALID");
  }
  return value as Record<string, unknown>;
}

function inventoryRepositories(inventory: Record<string, unknown>): InventoryRepository[] {
  const repositories = inventory.repositories;
  if (!Array.isArray(repositories)) fail("FLEET_P7_GITHUB_INVENTORY_INVALID");
  return repositories.map((item) => {
    const repository = record(record(item).repository);
    if (
      !/^[1-9][0-9]{0,31}$/u.test(String(repository.id ?? ""))
      || !REPOSITORY.test(String(repository.fullName ?? ""))
      || !SHA.test(String(repository.sourceSha ?? ""))
      || typeof repository.private !== "boolean"
      || typeof repository.classification !== "string"
    ) fail("FLEET_P7_GITHUB_INVENTORY_INVALID");
    return { repository } as InventoryRepository;
  });
}

function centralTargets(bytes: Buffer): string[] {
  if (bytes.length < 1 || bytes.length > MAX_CONTRACT_BYTES) {
    fail("FLEET_P7_CENTRAL_CONTRACT_INVALID");
  }
  let document: unknown;
  try {
    document = parse(bytes.toString("utf8"));
  } finally {
    bytes.fill(0);
  }
  const root = record(document);
  const github = record(root.github);
  const ruleset = record(github.ruleset);
  const repositories = ruleset.repositories;
  if (root.schemaVersion !== 3 || !Array.isArray(repositories)) {
    fail("FLEET_P7_CENTRAL_CONTRACT_INVALID");
  }
  const targets = repositories.map((name) => {
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/u.test(name)) {
      fail("FLEET_P7_CENTRAL_CONTRACT_INVALID");
    }
    return `${ORGANIZATION}/${name}`;
  }).sort();
  if (targets.length < 1 || new Set(targets).size !== targets.length) {
    fail("FLEET_P7_CENTRAL_CONTRACT_INVALID");
  }
  return targets;
}

async function readContent(
  client: Octokit,
  fullName: string,
  path: string,
  ref: string,
): Promise<Buffer | null> {
  const [owner, repo] = fullName.split("/");
  try {
    const response = await client.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      ref,
    });
    const data = response.data as {
      type?: unknown;
      encoding?: unknown;
      content?: unknown;
      size?: unknown;
    } | null;
    if (
      data?.type !== "file"
      || data.encoding !== "base64"
      || typeof data.content !== "string"
      || typeof data.size !== "number"
      || !Number.isSafeInteger(data.size)
      || data.size < 1
      || data.size > MAX_CONTRACT_BYTES
    ) fail("FLEET_P7_GITHUB_CONTENT_INVALID");
    const bytes = Buffer.from(data.content.replace(/\s/gu, ""), "base64");
    if (bytes.length !== data.size) {
      bytes.fill(0);
      fail("FLEET_P7_GITHUB_CONTENT_INVALID");
    }
    return bytes;
  } catch (error) {
    const status = (error as { status?: unknown })?.status;
    if (status === 404) return null;
    throw error;
  }
}

async function readCurrentCentralSourceSha(client: Octokit): Promise<string> {
  const repository = await client.request("GET /repositories/{repository_id}", {
    repository_id: Number(CENTRAL_REPOSITORY_ID),
  });
  const data = repository.data as {
    id?: unknown;
    full_name?: unknown;
    default_branch?: unknown;
    archived?: unknown;
  } | null;
  if (
    String(data?.id ?? "") !== CENTRAL_REPOSITORY_ID
    || data?.full_name !== CENTRAL_FULL_NAME
    || data.default_branch !== "main"
    || data.archived !== false
  ) fail("FLEET_P7_CENTRAL_REPOSITORY_DRIFT");
  const ref = await client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    owner: ORGANIZATION,
    repo: ".github",
    ref: "heads/main",
  });
  const sha = (ref.data as { object?: { sha?: unknown } } | null)?.object?.sha;
  if (typeof sha !== "string" || !SHA.test(sha)) {
    fail("FLEET_P7_CENTRAL_SOURCE_READBACK_INVALID");
  }
  if (sha !== FLEET_P7_CENTRAL_SOURCE_SHA) {
    fail("FLEET_P7_CENTRAL_SOURCE_DRIFT");
  }
  return sha;
}

function installationReadback(source: FleetGitHubAppPublicSource): Record<string, unknown> {
  return {
    app_id: Number(source.app.id),
    app_slug: source.app.slug,
    id: Number(source.installation.installationId),
    repository_selection: source.installation.repositorySelection,
    suspended_at: source.installation.suspendedAt,
    permissions: structuredClone(source.installation.permissions),
    events: [...source.app.events],
  };
}

async function readCustomProperties(client: Octokit): Promise<Array<Record<string, unknown>>> {
  const response = await client.request("GET /orgs/{org}/properties/schema", {
    org: ORGANIZATION,
  });
  if (!Array.isArray(response.data)) fail("FLEET_P7_CUSTOM_PROPERTIES_INVALID");
  return response.data.map((item) => {
    const property = record(item);
    return {
      property_name: property.property_name,
      value_type: property.value_type,
      required: property.required,
      description: property.description,
      allowed_values: property.allowed_values,
      values_editable_by: property.values_editable_by,
      require_explicit_values: property.require_explicit_values,
    };
  });
}

function repositoryNamesForRule(
  rule: Record<string, unknown>,
  namesById: ReadonlyMap<string, string>,
): string[] {
  const conditions = record(rule.conditions);
  const repositoryId = conditions.repository_id;
  if (!repositoryId || Array.isArray(repositoryId) || typeof repositoryId !== "object") return [];
  const ids = (repositoryId as Record<string, unknown>).repository_ids;
  if (!Array.isArray(ids)) return [];
  return ids.flatMap((id) => {
    const name = namesById.get(String(id));
    return name ? [name] : [];
  }).sort();
}

function requiredStatusChecks(rule: Record<string, unknown>): string[] {
  const rules = rule.rules;
  if (!Array.isArray(rules)) return [];
  const statusRule = rules.map(record).find((candidate) => candidate.type === "required_status_checks");
  if (!statusRule) return [];
  const parameters = record(statusRule.parameters);
  const checks = parameters.required_status_checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((check) => {
    const context = record(check).context;
    return typeof context === "string" ? [context] : [];
  }).sort();
}

async function readRulesets(
  client: Octokit,
  namesById: ReadonlyMap<string, string>,
): Promise<Array<Record<string, unknown>>> {
  const list = await client.request("GET /orgs/{org}/rulesets", {
    org: ORGANIZATION,
    per_page: 100,
    includes_parents: false,
  });
  if (!Array.isArray(list.data)) fail("FLEET_P7_RULESET_READBACK_INVALID");
  const result: Array<Record<string, unknown>> = [];
  for (const summary of list.data) {
    const id = record(summary).id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      fail("FLEET_P7_RULESET_READBACK_INVALID");
    }
    const response = await client.request("GET /orgs/{org}/rulesets/{ruleset_id}", {
      org: ORGANIZATION,
      ruleset_id: id,
    });
    const detail = record(response.data);
    result.push({
      id,
      name: detail.name,
      target: detail.target,
      enforcement: detail.enforcement,
      requiredStatusChecks: requiredStatusChecks(detail),
      repositories: repositoryNamesForRule(detail, namesById),
    });
  }
  return result;
}

async function readOrgContractCallers(
  client: Octokit,
  repositories: InventoryRepository[],
  currentCentralSourceSha: string,
): Promise<Array<{ fullName: string }>> {
  const central = await readContent(
    client,
    CENTRAL_FULL_NAME,
    CENTRAL_CONTRACT_PATH,
    currentCentralSourceSha,
  );
  if (!central) fail("FLEET_P7_CENTRAL_CONTRACT_MISSING");
  const targets = centralTargets(central);
  const byName = new Map(repositories.map(({ repository }) => [repository.fullName, repository]));
  const callers: Array<{ fullName: string }> = [];
  for (const fullName of targets) {
    const repository = byName.get(fullName);
    if (!repository) continue;
    const content = await readContent(
      client,
      fullName,
      ORG_CONTRACT_CALLER_PATH,
      repository.sourceSha,
    );
    if (content) {
      content.fill(0);
      callers.push({ fullName });
    }
  }
  return callers;
}

export function createFleetP7GitHubReadbackAdapter(input: {
  client: Octokit;
  readAppSource: () => Promise<FleetGitHubAppPublicSource>;
}) {
  return Object.freeze({
    async read(inventory: Record<string, unknown>): Promise<FleetP7GitHubPublicReadback> {
      const repositories = inventoryRepositories(inventory);
      const namesById = new Map(
        repositories.map(({ repository }) => [repository.id, repository.fullName]),
      );
      const currentCentralSourceSha = await readCurrentCentralSourceSha(input.client);
      const [installation, organizationCustomProperties, rulesets, callers] = await Promise.all([
        input.readAppSource().then(installationReadback).catch(() => null),
        readCustomProperties(input.client).catch(() => null),
        readRulesets(input.client, namesById).catch(() => null),
        readOrgContractCallers(input.client, repositories, currentCentralSourceSha).catch(() => null),
      ]);
      return {
        currentCentralSourceSha,
        installation,
        organizationCustomProperties,
        rulesets,
        defaultBranchOrgContractCallers: callers,
      };
    },
  });
}
