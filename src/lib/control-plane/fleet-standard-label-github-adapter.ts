import { TextDecoder } from "node:util";
import type { Octokit } from "octokit";

import {
  fleetCustomLabelsPreserved,
  normalizeFleetRepositoryLabels,
  parseFleetStandardLabelContract,
  type FleetRepositoryLabel,
  type FleetStandardLabelContract,
  type FleetStandardLabelContractSourceConfig,
  type FleetStandardLabelObservation,
  type FleetStandardLabelOperation,
} from "@/lib/control-plane/fleet-standard-labels";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  withFleetScopedGithubClient,
  type FleetScopedGithubTokenIssuer,
} from "@/lib/github/scoped-installation-client";

const MAX_LABEL_PAGES = 10;
const LABELS_PER_PAGE = 100;

export interface FleetStandardLabelRepositoryIdentity {
  repositoryId: string;
  repositoryFullName: string;
  archived: false;
  private: boolean;
}

export interface FleetStandardLabelRepositoryReadback {
  identity: FleetStandardLabelRepositoryIdentity;
  labels: FleetRepositoryLabel[];
  observation: FleetStandardLabelObservation;
}

export interface FleetStandardLabelApplyReceipt {
  action: "github.standard-labels.ensure";
  repositoryId: string;
  repositoryFullName: string;
  catalogVersion: string;
  catalogDigest: string;
  method: "UPSERT_FIXED_LABELS_PRESERVE_CUSTOM";
  state: "UNCHANGED" | "UPDATED";
  mutations: number;
  beforeReadbackDigest: string;
  afterReadbackDigest: string;
  customLabelsDigest: string;
}

export interface FleetStandardLabelGithubTransport {
  readContract(config: FleetStandardLabelContractSourceConfig): Promise<FleetStandardLabelContract>;
  readRepository(input: {
    repositoryId: string;
    repositoryFullName: string;
    operation: FleetStandardLabelOperation;
  }): Promise<FleetStandardLabelRepositoryReadback>;
  ensureRepository(input: {
    repositoryId: string;
    repositoryFullName: string;
    operation: FleetStandardLabelOperation;
    assertLease: () => Promise<void>;
  }): Promise<FleetStandardLabelApplyReceipt>;
}

interface ScopedIssuerContext {
  installationId: string;
  issuer: FleetScopedGithubTokenIssuer<Octokit>;
}

interface FleetStandardLabelGithubAdapterDependencies {
  getIssuer: () => Promise<ScopedIssuerContext>;
  now: () => Date;
}

function repositoryParts(fullName: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error("FLEET_GITHUB_REPOSITORY_INVALID");
  return { owner, repo };
}

function sanitizeGithubError(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{7,190}$/u.test(message) ? new Error(message) : new Error(fallback);
}

async function readRepositoryIdentity(input: {
  client: Octokit;
  repositoryId: string;
  repositoryFullName: string;
}): Promise<FleetStandardLabelRepositoryIdentity> {
  const { owner, repo } = repositoryParts(input.repositoryFullName);
  const response = await input.client.rest.repos.get({ owner, repo });
  if (
    String(response.data.id) !== input.repositoryId
    || response.data.full_name.toLowerCase() !== input.repositoryFullName.toLowerCase()
    || response.data.archived
    || typeof response.data.private !== "boolean"
  ) {
    throw new Error("FLEET_GITHUB_REPOSITORY_IDENTITY_MISMATCH");
  }
  return {
    repositoryId: input.repositoryId,
    repositoryFullName: response.data.full_name,
    archived: false,
    private: response.data.private,
  };
}

async function readAllLabelsOnce(input: {
  client: Octokit;
  repositoryFullName: string;
}): Promise<{ labels: FleetRepositoryLabel[]; pageCount: number }> {
  const { owner, repo } = repositoryParts(input.repositoryFullName);
  const labels: FleetRepositoryLabel[] = [];
  for (let page = 1; page <= MAX_LABEL_PAGES; page += 1) {
    const response = await input.client.rest.issues.listLabelsForRepo({
      owner,
      repo,
      per_page: LABELS_PER_PAGE,
      page,
    });
    labels.push(...response.data.map((label) => ({
      name: label.name,
      color: label.color,
      description: label.description ?? "",
    })));
    if (response.data.length < LABELS_PER_PAGE) return { labels, pageCount: page };
  }
  throw new Error("FLEET_STANDARD_LABEL_PAGINATION_LIMIT");
}

async function readStableLabels(input: {
  client: Octokit;
  repositoryFullName: string;
}): Promise<FleetRepositoryLabel[]> {
  const first = await readAllLabelsOnce(input);
  if (first.pageCount === 1) return first.labels;
  const second = await readAllLabelsOnce(input);
  if (
    first.pageCount !== second.pageCount
    || jsonDigest(first.labels as unknown as JsonValue) !== jsonDigest(second.labels as unknown as JsonValue)
  ) {
    throw new Error("FLEET_STANDARD_LABEL_UNSTABLE_READBACK");
  }
  return second.labels;
}

function decodeContent(data: {
  type?: string;
  sha?: string;
  encoding?: string;
  content?: string;
}, expectedBlobSha: string): { blobSha: string; text: string } {
  if (
    data.type !== "file"
    || data.sha?.toLowerCase() !== expectedBlobSha
    || data.encoding !== "base64"
    || typeof data.content !== "string"
    || !/^(?:[A-Za-z0-9+/]{4}|\s)*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\s*$/u.test(data.content)
  ) {
    throw new Error("FLEET_STANDARD_LABEL_CONTRACT_CONTENT_INVALID");
  }
  const bytes = Buffer.from(data.content.replace(/\s/gu, ""), "base64");
  try {
    if (bytes.length === 0 || bytes.length > 128 * 1024) {
      throw new Error("FLEET_STANDARD_LABEL_CONTRACT_CONTENT_INVALID");
    }
    return {
      blobSha: data.sha.toLowerCase(),
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } finally {
    bytes.fill(0);
  }
}

export function createFleetStandardLabelGithubAdapter(
  dependencies: FleetStandardLabelGithubAdapterDependencies = {
    getIssuer: async () => (await import("@/lib/github/app")).getFleetScopedGithubTokenIssuer(),
    now: () => new Date(),
  },
): FleetStandardLabelGithubTransport {
  return {
    async readContract(config) {
      try {
        const scoped = await dependencies.getIssuer();
        return await withFleetScopedGithubClient({
          ...scoped,
          capability: "github.standard-labels.contract.read",
          repositoryId: config.repositoryId,
          repositoryFullName: config.repositoryFullName,
          now: dependencies.now(),
          execute: async (client) => {
            await readRepositoryIdentity({
              client,
              repositoryId: config.repositoryId,
              repositoryFullName: config.repositoryFullName,
            });
            const { owner, repo } = repositoryParts(config.repositoryFullName);
            const response = await client.rest.repos.getContent({
              owner,
              repo,
              path: config.catalogPath,
              ref: config.sourceSha,
            });
            if (Array.isArray(response.data)) {
              throw new Error("FLEET_STANDARD_LABEL_CONTRACT_CONTENT_INVALID");
            }
            const content = decodeContent(response.data, config.catalogBlobSha);
            return parseFleetStandardLabelContract({ config, ...content });
          },
        });
      } catch (error) {
        throw sanitizeGithubError(error, "FLEET_STANDARD_LABEL_CONTRACT_READ_FAILED");
      }
    },

    async readRepository(input) {
      try {
        const scoped = await dependencies.getIssuer();
        return await withFleetScopedGithubClient({
          ...scoped,
          capability: "github.standard-labels.read",
          repositoryId: input.repositoryId,
          repositoryFullName: input.repositoryFullName,
          now: dependencies.now(),
          execute: async (client) => {
            const identity = await readRepositoryIdentity({ client, ...input });
            const labels = await readStableLabels({ client, repositoryFullName: input.repositoryFullName });
            const normalized = normalizeFleetRepositoryLabels({ operation: input.operation, labels });
            return { identity, labels: normalized.labels, observation: normalized.observation };
          },
        });
      } catch (error) {
        throw sanitizeGithubError(error, "FLEET_STANDARD_LABEL_READBACK_FAILED");
      }
    },

    async ensureRepository(input) {
      try {
        const scoped = await dependencies.getIssuer();
        return await withFleetScopedGithubClient({
          ...scoped,
          capability: "github.standard-labels.ensure",
          repositoryId: input.repositoryId,
          repositoryFullName: input.repositoryFullName,
          now: dependencies.now(),
          execute: async (client) => {
            await readRepositoryIdentity({ client, ...input });
            const beforeLabels = await readStableLabels({
              client,
              repositoryFullName: input.repositoryFullName,
            });
            const before = normalizeFleetRepositoryLabels({
              operation: input.operation,
              labels: beforeLabels,
            });
            if (before.observation.state === "MATCH") {
              return {
                action: input.operation.kind,
                repositoryId: input.repositoryId,
                repositoryFullName: input.repositoryFullName,
                catalogVersion: input.operation.payload.catalogVersion,
                catalogDigest: input.operation.payload.catalogDigest,
                method: "UPSERT_FIXED_LABELS_PRESERVE_CUSTOM",
                state: "UNCHANGED",
                mutations: 0,
                beforeReadbackDigest: before.observation.readbackDigest,
                afterReadbackDigest: before.observation.readbackDigest,
                customLabelsDigest: before.observation.customLabelsDigest,
              };
            }
            const { owner, repo } = repositoryParts(input.repositoryFullName);
            const actualByName = new Map(before.labels.map((label) => [
              label.name.toLocaleLowerCase("en-US"),
              label,
            ]));
            let mutations = 0;
            for (const expected of input.operation.payload.labels) {
              await input.assertLease();
              const actual = actualByName.get(expected.name.toLocaleLowerCase("en-US"));
              if (!actual) {
                await client.rest.issues.createLabel({
                  owner,
                  repo,
                  name: expected.name,
                  color: expected.color,
                  description: expected.description,
                });
                mutations += 1;
              } else if (
                actual.name !== expected.name
                || actual.color !== expected.color
                || actual.description !== expected.description
              ) {
                await client.rest.issues.updateLabel({
                  owner,
                  repo,
                  name: actual.name,
                  new_name: expected.name,
                  color: expected.color,
                  description: expected.description,
                });
                mutations += 1;
              }
            }
            await input.assertLease();
            const afterLabels = await readStableLabels({
              client,
              repositoryFullName: input.repositoryFullName,
            });
            const after = normalizeFleetRepositoryLabels({
              operation: input.operation,
              labels: afterLabels,
            });
            if (
              after.observation.state !== "MATCH"
              || !fleetCustomLabelsPreserved(before.customLabels, after.customLabels)
            ) {
              throw new Error("FLEET_STANDARD_LABEL_POST_WRITE_READBACK_MISMATCH");
            }
            return {
              action: input.operation.kind,
              repositoryId: input.repositoryId,
              repositoryFullName: input.repositoryFullName,
              catalogVersion: input.operation.payload.catalogVersion,
              catalogDigest: input.operation.payload.catalogDigest,
              method: "UPSERT_FIXED_LABELS_PRESERVE_CUSTOM",
              state: mutations === 0 ? "UNCHANGED" : "UPDATED",
              mutations,
              beforeReadbackDigest: before.observation.readbackDigest,
              afterReadbackDigest: after.observation.readbackDigest,
              customLabelsDigest: after.observation.customLabelsDigest,
            };
          },
        });
      } catch (error) {
        throw sanitizeGithubError(error, "FLEET_STANDARD_LABEL_APPLY_RESULT_UNKNOWN");
      }
    },
  };
}
