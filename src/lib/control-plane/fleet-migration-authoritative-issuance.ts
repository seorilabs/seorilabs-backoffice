import { Prisma } from "@prisma/client";
import type { KeyObject } from "node:crypto";

import { validateFleetMigrationAuthoritativeInventory } from "seorilabs-org-contracts/repo-contract/trusted-inventory-issuer";

import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";

const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PRIVATE_KEY = /^(?:authorization|bytes|cookie|credentialValue|password|payload|privateKey|privateKeyPem|rawSecret|secret|secretValue|token)$/iu;
const PRIVATE_VALUE = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
];

type IssuanceClient = Pick<
  typeof prisma,
  "fleetMigrationAuthoritativeIssuance" | "fleetMigrationCollectionCompletion"
>;

export interface FleetMigrationIssuanceIdentity {
  occurrenceId: string;
  runId: string;
  providerVectorDigest: string;
}

export interface FleetMigrationIssuanceReadRequest extends FleetMigrationIssuanceIdentity {
  issuanceDigest: string;
  publicKey: KeyObject;
  now: Date;
}

export interface FleetMigrationIssuancePreserveRequest extends FleetMigrationIssuanceIdentity {
  issuance: Record<string, unknown>;
  publicKey: KeyObject;
  now: Date;
}

interface StoredIssuance {
  occurrenceId: string;
  runId: string;
  providerVectorDigest: string;
  inventoryId: string;
  inventoryDigest: string;
  issuanceDigest: string;
  keyFingerprint: string;
  signedAt: Date;
  expiresAt: Date;
  issuance: unknown;
}

function invalid(code: string): never {
  throw new Error(code);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_INVALID");
  }
  return value as Record<string, unknown>;
}

function validDate(value: unknown): Date {
  if (typeof value !== "string") {
    invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_INVALID");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_INVALID");
  }
  return new Date(milliseconds);
}

function assertIdentity(identity: FleetMigrationIssuanceIdentity): void {
  if (
    !EVIDENCE_ID.test(identity.occurrenceId)
    || !EVIDENCE_ID.test(identity.runId)
    || !DIGEST.test(identity.providerVectorDigest)
  ) invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_IDENTITY_INVALID");
}

function assertSecretFree(value: unknown): void {
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === "string") {
      if (PRIVATE_VALUE.some((pattern) => pattern.test(item))) {
        invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_PRIVATE_SURFACE_REJECTED");
      }
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) {
      if (PRIVATE_KEY.test(key)) {
        invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_PRIVATE_SURFACE_REJECTED");
      }
      visit(nested);
    }
  };
  visit(value);
}

function validateIssuance(
  issuanceInput: unknown,
  publicKey: KeyObject,
  now: Date,
  validateAuthoritative: typeof validateFleetMigrationAuthoritativeInventory,
): {
  issuance: Record<string, unknown>;
  inventoryId: string;
  inventoryDigest: string;
  issuanceDigest: string;
  keyFingerprint: string;
  signedAt: Date;
  expiresAt: Date;
} {
  if (!Number.isFinite(now.getTime())) {
    invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_TIME_INVALID");
  }
  const issuance = structuredClone(record(issuanceInput));
  assertSecretFree(issuance);
  const validation = validateAuthoritative(
    issuance,
    publicKey,
    { now: now.toISOString() },
  );
  if (!validation.ok) {
    invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_UNTRUSTED");
  }
  const inventory = record(issuance.inventory);
  const attestation = record(inventory.attestation);
  const inventoryId = inventory.inventoryId;
  const inventoryDigest = issuance.inventoryDigest;
  const issuanceDigest = issuance.issuanceDigest;
  const keyFingerprint = issuance.keyFingerprint;
  if (
    !EVIDENCE_ID.test(String(inventoryId ?? ""))
    || !DIGEST.test(String(inventoryDigest ?? ""))
    || !DIGEST.test(String(issuanceDigest ?? ""))
    || !DIGEST.test(String(keyFingerprint ?? ""))
  ) invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_INVALID");
  const signedAt = validDate(attestation.signedAt);
  const expiresAt = validDate(inventory.expiresAt);
  if (signedAt >= expiresAt || expiresAt <= now) {
    invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_EXPIRED");
  }
  return {
    issuance,
    inventoryId: String(inventoryId),
    inventoryDigest: String(inventoryDigest),
    issuanceDigest: String(issuanceDigest),
    keyFingerprint: String(keyFingerprint),
    signedAt,
    expiresAt,
  };
}

function validateStored(
  row: StoredIssuance,
  identity: FleetMigrationIssuanceIdentity,
  publicKey: KeyObject,
  now: Date,
  validateAuthoritative: typeof validateFleetMigrationAuthoritativeInventory,
): Record<string, unknown> {
  if (
    row.occurrenceId !== identity.occurrenceId
    || row.runId !== identity.runId
    || row.providerVectorDigest !== identity.providerVectorDigest
  ) invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_IDENTITY_MISMATCH");
  const validated = validateIssuance(
    row.issuance,
    publicKey,
    now,
    validateAuthoritative,
  );
  if (
    row.inventoryId !== validated.inventoryId
    || row.inventoryDigest !== validated.inventoryDigest
    || row.issuanceDigest !== validated.issuanceDigest
    || row.keyFingerprint !== validated.keyFingerprint
    || row.signedAt.toISOString() !== validated.signedAt.toISOString()
    || row.expiresAt.toISOString() !== validated.expiresAt.toISOString()
    || jsonDigest(row.issuance as JsonValue) !== jsonDigest(validated.issuance as JsonValue)
  ) invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_ROW_DRIFT");
  return validated.issuance;
}

export function createFleetMigrationAuthoritativeIssuanceStore(
  client: IssuanceClient = prisma,
  dependencies: {
    validateAuthoritative?: typeof validateFleetMigrationAuthoritativeInventory;
  } = {},
) {
  const validateAuthoritative = dependencies.validateAuthoritative
    ?? validateFleetMigrationAuthoritativeInventory;
  async function readByOccurrence(
    request: FleetMigrationIssuanceIdentity & { publicKey: KeyObject; now: Date },
  ): Promise<Record<string, unknown> | null> {
    assertIdentity(request);
    const row = await client.fleetMigrationAuthoritativeIssuance.findUnique({
      where: { occurrenceId: request.occurrenceId },
    });
    return row
      ? validateStored(
        row,
        request,
        request.publicKey,
        request.now,
        validateAuthoritative,
      )
      : null;
  }

  return Object.freeze({
    readByOccurrence,

    async preserve(request: FleetMigrationIssuancePreserveRequest) {
      assertIdentity(request);
      const validated = validateIssuance(
        request.issuance,
        request.publicKey,
        request.now,
        validateAuthoritative,
      );
      const completion = await client.fleetMigrationCollectionCompletion.findUnique({
        where: { occurrenceId: request.occurrenceId },
        select: {
          occurrenceId: true,
          runId: true,
          providerVectorDigest: true,
          inventoryDigest: true,
        },
      });
      if (
        !completion
        || completion.occurrenceId !== request.occurrenceId
        || completion.runId !== request.runId
        || completion.providerVectorDigest !== request.providerVectorDigest
        || completion.inventoryDigest !== validated.inventoryDigest
      ) invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_COMPLETION_MISMATCH");

      const existing = await readByOccurrence(request);
      if (existing) return { state: "REPLAYED" as const, issuance: existing };

      try {
        const row = await client.fleetMigrationAuthoritativeIssuance.create({
          data: {
            occurrenceId: request.occurrenceId,
            runId: request.runId,
            providerVectorDigest: request.providerVectorDigest,
            inventoryId: validated.inventoryId,
            inventoryDigest: validated.inventoryDigest,
            issuanceDigest: validated.issuanceDigest,
            keyFingerprint: validated.keyFingerprint,
            signedAt: validated.signedAt,
            expiresAt: validated.expiresAt,
            issuance: validated.issuance as Prisma.InputJsonValue,
          },
        });
        return {
          state: "PRESERVED" as const,
          issuance: validateStored(
            row,
            request,
            request.publicKey,
            request.now,
            validateAuthoritative,
          ),
        };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
          throw error;
        }
        const winner = await readByOccurrence(request);
        if (!winner) invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_CONFLICT");
        return { state: "REPLAYED" as const, issuance: winner };
      }
    },

    async readExact(request: FleetMigrationIssuanceReadRequest) {
      assertIdentity(request);
      if (!DIGEST.test(request.issuanceDigest)) {
        invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_IDENTITY_INVALID");
      }
      const row = await client.fleetMigrationAuthoritativeIssuance.findUnique({
        where: { issuanceDigest: request.issuanceDigest },
      });
      if (!row) invalid("FLEET_MIGRATION_AUTHORITATIVE_ISSUANCE_NOT_FOUND");
      return validateStored(
        row,
        request,
        request.publicKey,
        request.now,
        validateAuthoritative,
      );
    },
  });
}
