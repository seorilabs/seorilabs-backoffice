import { z } from "zod";

import { containsCredentialCandidate } from "@/lib/control-plane/contracts";
import { canonicalJson, jsonDigest, type JsonValue } from "@/lib/control-plane/json";

export const FLEET_STANDARD_LABEL_ACTION = "github.standard-labels.ensure" as const;
export const FLEET_STANDARD_LABEL_AUTOMATION_TEMPLATE = "fleet-standard-label-reconcile-v1" as const;
export const FLEET_STANDARD_LABEL_CONTRACT_PATH = "contracts/fleet-standard-labels.json" as const;
export const FLEET_STANDARD_LABEL_PACKAGE_EXPORT = "@seorilabs/repo-contract/standard-labels" as const;
export const FLEET_STANDARD_LABEL_CONTRACT_REPOSITORY = "seorilabs/.github" as const;

const REPOSITORY_ID = /^[1-9][0-9]{0,31}$/u;
const REPOSITORY_FULL_NAME = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/u;
const COLOR = /^[0-9A-F]{6}$/u;

const publicText = (max: number) => z.string().min(1).max(max).refine(
  (value) => !containsCredentialCandidate(value),
  "credential 후보가 없는 공개 텍스트가 필요합니다.",
);

export const fleetStandardLabelSchema = z.object({
  name: publicText(50),
  color: z.string().regex(COLOR),
  description: z.string().max(100).refine(
    (value) => !containsCredentialCandidate(value),
    "credential 후보가 없는 공개 설명이 필요합니다.",
  ),
}).strict();

export const fleetStandardLabelCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  catalogVersion: z.string().regex(PUBLIC_ID),
  strategy: z.literal("UPSERT_FIXED_PRESERVE_CUSTOM"),
  labels: z.array(fleetStandardLabelSchema).min(1).max(100),
}).strict().superRefine((catalog, context) => {
  const normalized = catalog.labels.map((label) => label.name.toLocaleLowerCase("en-US"));
  if (new Set(normalized).size !== normalized.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["labels"],
      message: "label name은 대소문자를 무시하고 유일해야 합니다.",
    });
  }
});

export type FleetStandardLabel = z.infer<typeof fleetStandardLabelSchema>;
export type FleetStandardLabelCatalog = z.infer<typeof fleetStandardLabelCatalogSchema>;

export interface FleetStandardLabelContractSourceConfig {
  repositoryId: string;
  repositoryFullName: typeof FLEET_STANDARD_LABEL_CONTRACT_REPOSITORY;
  sourceSha: string;
  catalogPath: typeof FLEET_STANDARD_LABEL_CONTRACT_PATH;
  catalogBlobSha: string;
  expectedCatalogDigest: string;
  packageExport: typeof FLEET_STANDARD_LABEL_PACKAGE_EXPORT;
}

export interface FleetStandardLabelContract extends FleetStandardLabelContractSourceConfig {
  catalog: FleetStandardLabelCatalog;
  catalogDigest: string;
}

export function fleetStandardLabelContractSourceConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FleetStandardLabelContractSourceConfig {
  const repositoryId = environment.FLEET_STANDARD_LABELS_CONTRACT_REPOSITORY_ID?.trim() ?? "";
  const sourceSha = environment.FLEET_STANDARD_LABELS_CONTRACT_SOURCE_SHA?.trim().toLowerCase() ?? "";
  const catalogBlobSha = environment.FLEET_STANDARD_LABELS_CATALOG_BLOB_SHA?.trim().toLowerCase() ?? "";
  const expectedCatalogDigest = environment.FLEET_STANDARD_LABELS_CATALOG_DIGEST?.trim().toLowerCase() ?? "";
  if (
    !REPOSITORY_ID.test(repositoryId)
    || !SHA40.test(sourceSha)
    || !SHA40.test(catalogBlobSha)
    || !SHA256.test(expectedCatalogDigest)
  ) {
    throw new Error("FLEET_STANDARD_LABEL_CONTRACT_SOURCE_INVALID");
  }
  return Object.freeze({
    repositoryId,
    repositoryFullName: FLEET_STANDARD_LABEL_CONTRACT_REPOSITORY,
    sourceSha,
    catalogPath: FLEET_STANDARD_LABEL_CONTRACT_PATH,
    catalogBlobSha,
    expectedCatalogDigest,
    packageExport: FLEET_STANDARD_LABEL_PACKAGE_EXPORT,
  });
}

export function parseFleetStandardLabelContract(input: {
  config: FleetStandardLabelContractSourceConfig;
  blobSha: string;
  text: string;
}): FleetStandardLabelContract {
  if (input.blobSha.toLowerCase() !== input.config.catalogBlobSha) {
    throw new Error("FLEET_STANDARD_LABEL_CONTRACT_BLOB_MISMATCH");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input.text);
  } catch {
    throw new Error("FLEET_STANDARD_LABEL_CATALOG_INVALID");
  }
  const catalog = fleetStandardLabelCatalogSchema.parse(raw);
  const catalogDigest = `sha256:${jsonDigest(catalog as unknown as JsonValue)}`;
  if (catalogDigest !== input.config.expectedCatalogDigest) {
    throw new Error("FLEET_STANDARD_LABEL_CATALOG_DIGEST_MISMATCH");
  }
  return Object.freeze({
    ...input.config,
    catalog: structuredClone(catalog),
    catalogDigest,
  });
}

export interface FleetStandardLabelOperation {
  kind: typeof FLEET_STANDARD_LABEL_ACTION;
  idempotencyKey: string;
  payload: {
    catalogDigest: string;
    catalogVersion: string;
    labels: FleetStandardLabel[];
    repositoryFullName: string;
    repositoryId: string;
    strategy: "UPSERT_FIXED_PRESERVE_CUSTOM";
  };
}

export function fleetStandardLabelOperation(input: {
  contract: FleetStandardLabelContract;
  repositoryId: string;
  repositoryFullName: string;
}): FleetStandardLabelOperation {
  if (!REPOSITORY_ID.test(input.repositoryId) || !REPOSITORY_FULL_NAME.test(input.repositoryFullName)) {
    throw new Error("FLEET_STANDARD_LABEL_REPOSITORY_INVALID");
  }
  const payload: FleetStandardLabelOperation["payload"] = {
    catalogDigest: input.contract.catalogDigest,
    catalogVersion: input.contract.catalog.catalogVersion,
    labels: structuredClone(input.contract.catalog.labels),
    repositoryFullName: input.repositoryFullName,
    repositoryId: input.repositoryId,
    strategy: input.contract.catalog.strategy,
  };
  return Object.freeze({
    kind: FLEET_STANDARD_LABEL_ACTION,
    idempotencyKey: `sha256:${jsonDigest({
      kind: FLEET_STANDARD_LABEL_ACTION,
      payload,
      repositoryId: input.repositoryId,
    } as JsonValue)}`,
    payload,
  });
}

export interface FleetRepositoryLabel {
  name: string;
  color: string;
  description: string;
}

export interface FleetStandardLabelObservation {
  kind: typeof FLEET_STANDARD_LABEL_ACTION;
  repositoryId: string;
  catalogVersion: string;
  catalogDigest: string;
  state: "MATCH" | "DRIFT";
  customLabelCount: number;
  customLabelsDigest: string;
  readbackDigest: string;
}

export function normalizeFleetRepositoryLabels(input: {
  operation: FleetStandardLabelOperation;
  labels: readonly FleetRepositoryLabel[];
}): {
  labels: FleetRepositoryLabel[];
  customLabels: FleetRepositoryLabel[];
  observation: FleetStandardLabelObservation;
} {
  if (input.labels.length > 1_000) throw new Error("FLEET_STANDARD_LABEL_READBACK_INVALID");
  const labels = input.labels.map((label) => {
    const parsed = z.object({
      name: publicText(50),
      color: z.string().regex(/^[0-9a-f]{6}$/iu),
      description: z.string().max(100),
    }).strict().parse(label);
    return {
      name: parsed.name,
      color: parsed.color.toUpperCase(),
      description: parsed.description,
    };
  });
  const normalizedNames = labels.map((label) => label.name.toLocaleLowerCase("en-US"));
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    throw new Error("FLEET_STANDARD_LABEL_READBACK_INVALID");
  }
  const expectedByName = new Map(input.operation.payload.labels.map((label) => [
    label.name.toLocaleLowerCase("en-US"),
    label,
  ]));
  const actualByName = new Map(labels.map((label) => [
    label.name.toLocaleLowerCase("en-US"),
    label,
  ]));
  const matches = input.operation.payload.labels.every((expected) => (
    canonicalJson(actualByName.get(expected.name.toLocaleLowerCase("en-US")) as unknown as JsonValue)
      === canonicalJson(expected as unknown as JsonValue)
  ));
  const customLabels = labels
    .filter((label) => !expectedByName.has(label.name.toLocaleLowerCase("en-US")))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const readbackDigest = `sha256:${jsonDigest(labels
    .toSorted((left, right) => left.name.localeCompare(right.name)) as unknown as JsonValue)}`;
  return {
    labels,
    customLabels,
    observation: {
      kind: FLEET_STANDARD_LABEL_ACTION,
      repositoryId: input.operation.payload.repositoryId,
      catalogVersion: input.operation.payload.catalogVersion,
      catalogDigest: input.operation.payload.catalogDigest,
      state: matches ? "MATCH" : "DRIFT",
      customLabelCount: customLabels.length,
      customLabelsDigest: `sha256:${jsonDigest(customLabels as unknown as JsonValue)}`,
      readbackDigest,
    },
  };
}

export function fleetCustomLabelsPreserved(
  before: readonly FleetRepositoryLabel[],
  after: readonly FleetRepositoryLabel[],
): boolean {
  const afterByName = new Map(after.map((label) => [label.name.toLocaleLowerCase("en-US"), label]));
  return before.every((label) => (
    canonicalJson(afterByName.get(label.name.toLocaleLowerCase("en-US")) as unknown as JsonValue)
      === canonicalJson(label as unknown as JsonValue)
  ));
}

export const fleetStandardLabelPlanRequestSchema = z.object({
  mode: z.literal("PLAN"),
}).strict();

export const fleetStandardLabelApplyRequestSchema = z.object({
  mode: z.literal("APPLY"),
  planId: z.string().min(1).max(191),
  planDigest: z.string().regex(SHA256),
}).strict();

export const fleetStandardLabelRequestSchema = z.discriminatedUnion("mode", [
  fleetStandardLabelPlanRequestSchema,
  fleetStandardLabelApplyRequestSchema,
]);

export const fleetStandardLabelTaskSchema = z.object({
  schemaVersion: z.literal(1),
  action: z.literal(FLEET_STANDARD_LABEL_ACTION),
  repositoryId: z.string().regex(REPOSITORY_ID),
  repositoryFullName: z.string().regex(REPOSITORY_FULL_NAME),
  registrationStatus: z.enum(["MANAGED", "NEEDS_INPUT"]),
  registrationGeneration: z.number().int().nonnegative(),
  contract: z.object({
    repositoryId: z.string().regex(REPOSITORY_ID),
    repositoryFullName: z.literal(FLEET_STANDARD_LABEL_CONTRACT_REPOSITORY),
    sourceSha: z.string().regex(SHA40),
    catalogPath: z.literal(FLEET_STANDARD_LABEL_CONTRACT_PATH),
    catalogBlobSha: z.string().regex(SHA40),
    catalogDigest: z.string().regex(SHA256),
    catalogVersion: z.string().regex(PUBLIC_ID),
    packageExport: z.literal(FLEET_STANDARD_LABEL_PACKAGE_EXPORT),
  }).strict(),
  operation: z.object({
    kind: z.literal(FLEET_STANDARD_LABEL_ACTION),
    idempotencyKey: z.string().regex(SHA256),
    payload: z.object({
      catalogDigest: z.string().regex(SHA256),
      catalogVersion: z.string().regex(PUBLIC_ID),
      labels: z.array(fleetStandardLabelSchema).min(1).max(100),
      repositoryFullName: z.string().regex(REPOSITORY_FULL_NAME),
      repositoryId: z.string().regex(REPOSITORY_ID),
      strategy: z.literal("UPSERT_FIXED_PRESERVE_CUSTOM"),
    }).strict(),
  }).strict(),
  plannedObservation: z.object({
    kind: z.literal(FLEET_STANDARD_LABEL_ACTION),
    repositoryId: z.string().regex(REPOSITORY_ID),
    catalogVersion: z.string().regex(PUBLIC_ID),
    catalogDigest: z.string().regex(SHA256),
    state: z.enum(["MATCH", "DRIFT"]),
    customLabelCount: z.number().int().nonnegative(),
    customLabelsDigest: z.string().regex(SHA256),
    readbackDigest: z.string().regex(SHA256),
  }).strict(),
  desiredDigest: z.string().regex(SHA256),
}).strict();

export type FleetStandardLabelTask = z.infer<typeof fleetStandardLabelTaskSchema>;

export function fleetStandardLabelDesiredDigest(
  task: Omit<FleetStandardLabelTask, "desiredDigest">,
): string {
  return `sha256:${jsonDigest(task as unknown as JsonValue)}`;
}
