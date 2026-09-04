import { createHash } from "node:crypto";

import type { Octokit } from "octokit";
import { z } from "zod";

import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  fleetMigrationAttestationDigest,
  verifyFleetMigrationPublicAttestation,
} from "@/lib/control-plane/fleet-migration-public-attestation";
import { readBoundSecretFile } from "@/lib/control-plane/seori-auth-agent-transport";
import type { FleetGitHubAppPublicSource } from "@/lib/github/app";

const ORGANIZATION_ID = "283115031";
const INSTALLATION_ID = "142120077";
const RUNTIME_CONTRACT = "seorilabs-fleet-migration-shadow-runtime-capability-v1";
const MAX_ATTESTATION_TTL_MS = 65 * 60_000;
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const REPOSITORY = /^seorilabs\/[A-Za-z0-9._-]+$/u;

const permissionRecord = z.record(z.enum(["read", "write", "admin"]));
const appPublicSourceSchema = z.object({
  observedAt: z.string().datetime({ offset: true }),
  app: z.object({
    id: z.string().regex(/^[1-9][0-9]{0,31}$/u),
    slug: z.string().min(1).max(191),
    ownerId: z.string().regex(/^[1-9][0-9]{0,31}$/u),
    ownerLogin: z.literal("seorilabs"),
    active: z.literal(true),
    webhookActive: z.literal(true),
    webhookUrl: z.string().url(),
    permissions: permissionRecord,
    events: z.array(z.string().min(1).max(64)).min(1),
  }).strict(),
  installation: z.object({
    appId: z.string().regex(/^[1-9][0-9]{0,31}$/u),
    installationId: z.literal(INSTALLATION_ID),
    targetId: z.literal(ORGANIZATION_ID),
    targetType: z.literal("Organization"),
    accountLogin: z.literal("seorilabs"),
    repositorySelection: z.literal("all"),
    suspended: z.literal(false),
    permissions: permissionRecord,
    events: z.array(z.string().min(1).max(64)).min(1),
    updatedAt: z.string().datetime({ offset: true }),
    suspendedAt: z.null(),
  }).strict(),
}).strict();

const runtimePayloadSchema = z.object({
  schemaVersion: z.literal(1),
  contract: z.literal(RUNTIME_CONTRACT),
  executionId: z.string().regex(ID),
  organizationId: z.literal(ORGANIZATION_ID),
  installationId: z.literal(INSTALLATION_ID),
  backofficeSourceSha: z.string().regex(SHA),
  detectorSourceSha: z.string().regex(SHA),
  readinessEvidenceDigest: z.string().regex(SHA256),
  readinessCohortDigest: z.string().regex(SHA256),
  snapshotSigningKeyId: z.string().regex(ID),
  snapshotPolicyRevision: z.string().regex(ID),
  approvedProofDigests: z.array(z.string().regex(SHA256)).max(500),
  github: z.object({
    tokenSha256: z.string().regex(SHA256),
    tokenExpiresAt: z.string().datetime({ offset: true }),
    permissions: z.object({
      contents: z.literal("read"),
      metadata: z.literal("read"),
    }).strict(),
    repositories: z.array(z.object({
      id: z.string().regex(/^[1-9][0-9]{0,31}$/u),
      fullName: z.string().regex(REPOSITORY),
    }).strict()).min(1).max(500),
    publicSource: appPublicSourceSchema,
    webhookAcceptance: z.object({
      deliveryId: z.string().regex(ID),
      acceptedAt: z.string().datetime({ offset: true }),
    }).strict(),
  }).strict(),
  configSnapshots: z.array(z.object({
    repositoryId: z.string().regex(/^[1-9][0-9]{0,31}$/u),
    appId: z.string().regex(ID),
    configRevisionId: z.string().regex(ID),
    sourceSha: z.string().regex(SHA),
    snapshotDigest: z.string().regex(SHA256),
    snapshotSignatureDigest: z.string().regex(SHA256),
  }).strict()).max(500),
}).strict();

export type FleetMigrationRuntimePayload = z.infer<typeof runtimePayloadSchema>;

export function parseFleetMigrationRuntimePayload(value: unknown): FleetMigrationRuntimePayload {
  const parsed = runtimePayloadSchema.safeParse(value);
  if (!parsed.success) fail("FLEET_MIGRATION_RUNTIME_CAPABILITY_BINDING_INVALID");
  return parsed.data;
}

function fail(code: string): never {
  throw new Error(code);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("FLEET_MIGRATION_RUNTIME_ATTESTATION_INVALID");
  }
}

export async function loadFleetMigrationRuntimeCapability(input: {
  attestationRoot: string;
  attestationFile: string;
  publicKeyRoot: string;
  publicKeyFile: string;
  tokenRoot: string;
  tokenFile: string;
  expectedExecutionId: string;
  expectedBackofficeSourceSha: string;
  expectedDetectorSourceSha: string;
  expectedKeyId: string;
  expectedKeyFingerprint: string;
  expectedPolicyRevision: string;
  now?: () => Date;
  createClient?: (token: string) => Octokit;
}) {
  if (
    !ID.test(input.expectedExecutionId)
    || !SHA.test(input.expectedBackofficeSourceSha)
    || !SHA.test(input.expectedDetectorSourceSha)
    || !ID.test(input.expectedKeyId)
    || !SHA256.test(input.expectedKeyFingerprint)
    || !ID.test(input.expectedPolicyRevision)
  ) fail("FLEET_MIGRATION_RUNTIME_CONFIGURATION_INVALID");

  let attestationBytes: Buffer | undefined;
  let publicKeyBytes: Buffer | undefined;
  let tokenBytes: Buffer | undefined;
  try {
    attestationBytes = await readBoundSecretFile({
      root: input.attestationRoot,
      relativePath: input.attestationFile,
      allowGroupRead: true,
      maxBytes: 1024 * 1024,
    });
    publicKeyBytes = await readBoundSecretFile({
      root: input.publicKeyRoot,
      relativePath: input.publicKeyFile,
      allowGroupRead: true,
      maxBytes: 64 * 1024,
    });
    tokenBytes = await readBoundSecretFile({
      root: input.tokenRoot,
      relativePath: input.tokenFile,
      allowGroupRead: true,
      maxBytes: 4 * 1024,
    });
    const now = input.now?.() ?? new Date();
    const attestation = verifyFleetMigrationPublicAttestation({
      value: parseJson(attestationBytes),
      publicKey: publicKeyBytes,
      purpose: "SHADOW_RUNTIME",
      expectedKeyId: input.expectedKeyId,
      expectedKeyFingerprint: input.expectedKeyFingerprint,
      expectedPolicyRevision: input.expectedPolicyRevision,
      maxTtlMs: MAX_ATTESTATION_TTL_MS,
      now,
    });
    let parsed: FleetMigrationRuntimePayload;
    try {
      parsed = parseFleetMigrationRuntimePayload(attestation.payload);
    } catch {
      fail("FLEET_MIGRATION_RUNTIME_CAPABILITY_BINDING_INVALID");
    }
    const token = tokenBytes.toString("utf8").trim();
    if (
      parsed.executionId !== input.expectedExecutionId
      || parsed.backofficeSourceSha !== input.expectedBackofficeSourceSha
      || parsed.detectorSourceSha !== input.expectedDetectorSourceSha
      || token.length < 20
      || token.length > 1024
      || /[\s\u0000-\u001f\u007f]/u.test(token)
      || sha256(token) !== parsed.github.tokenSha256
    ) fail("FLEET_MIGRATION_RUNTIME_CAPABILITY_BINDING_INVALID");
    const tokenExpiresAt = Date.parse(parsed.github.tokenExpiresAt);
    const attestationExpiresAt = Date.parse(attestation.expiresAt);
    if (
      !Number.isFinite(tokenExpiresAt)
      || tokenExpiresAt <= now.getTime()
      || tokenExpiresAt > Date.parse(attestation.issuedAt) + 60 * 60_000 + 5_000
      || tokenExpiresAt > attestationExpiresAt
    ) fail("FLEET_MIGRATION_RUNTIME_CAPABILITY_EXPIRED");
    const repositoryIds = parsed.github.repositories.map(({ id }) => id);
    if (
      new Set(repositoryIds).size !== repositoryIds.length
      || new Set(parsed.github.repositories.map(({ fullName }) => fullName.toLowerCase())).size
        !== parsed.github.repositories.length
    ) fail("FLEET_MIGRATION_RUNTIME_COHORT_INVALID");
    if (new Set(parsed.approvedProofDigests).size !== parsed.approvedProofDigests.length) {
      fail("FLEET_MIGRATION_RUNTIME_PROOF_APPROVAL_INVALID");
    }

    const client = input.createClient
      ? input.createClient(token)
      : new (await import("octokit")).Octokit({ auth: token });
    let consumed = false;
    const payload = Object.freeze(structuredClone(parsed));
    const assertFresh = (freshNow: Date = input.now?.() ?? new Date()): void => {
      const current = freshNow.getTime();
      if (
        !Number.isFinite(current)
        || current >= tokenExpiresAt
        || current >= attestationExpiresAt
      ) fail("FLEET_MIGRATION_RUNTIME_CAPABILITY_EXPIRED");
    };
    return Object.freeze({
      payload,
      publicAttestationDigest: fleetMigrationAttestationDigest(attestation),
      readAppSource: async (): Promise<FleetGitHubAppPublicSource> => structuredClone(payload.github.publicSource),
      readRepositoryWebhookAcceptance: async () => ({
        deliveryId: payload.github.webhookAcceptance.deliveryId,
        acceptedAt: new Date(payload.github.webhookAcceptance.acceptedAt),
      }),
      assertFresh,
      verifyConfigSnapshot(inputSnapshot: {
        repositoryId: string;
        appId: string;
        configRevisionId: string;
        sourceSha: string;
        snapshot: JsonValue;
        digest: string;
        signature: string;
      }): boolean {
        const expected = payload.configSnapshots.find((item) => (
          item.repositoryId === inputSnapshot.repositoryId
          && item.appId === inputSnapshot.appId
          && item.configRevisionId === inputSnapshot.configRevisionId
          && item.sourceSha === inputSnapshot.sourceSha
        ));
        return Boolean(
          expected
          && inputSnapshot.digest === expected.snapshotDigest
          && jsonDigest(inputSnapshot.snapshot) === expected.snapshotDigest
          && sha256(inputSnapshot.signature) === expected.snapshotSignatureDigest,
        );
      },
      async run<Result>(execute: (client: Octokit) => Promise<Result>): Promise<Result> {
        if (consumed) fail("FLEET_MIGRATION_RUNTIME_CAPABILITY_ALREADY_CONSUMED");
        consumed = true;
        try {
          assertFresh();
          return await execute(client);
        } finally {
          try {
            await client.request("DELETE /installation/token");
          } catch (revokeError) {
            throw new Error("FLEET_MIGRATION_GITHUB_TOKEN_REVOKE_FAILED", { cause: revokeError });
          }
        }
      },
      cohortDigest: `sha256:${jsonDigest({
        contract: RUNTIME_CONTRACT,
        executionId: payload.executionId,
        repositories: payload.github.repositories,
      } as unknown as JsonValue)}`,
    });
  } finally {
    attestationBytes?.fill(0);
    publicKeyBytes?.fill(0);
    tokenBytes?.fill(0);
  }
}
