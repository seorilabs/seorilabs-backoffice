import { Prisma } from "@prisma/client";
import { validateFleetMigrationCollection } from "@seorilabs/repo-contract/fleet-migration-collector";

import type { JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";

const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COLLECTION_CONTRACT = "seorilabs-fleet-migration-collection-v1";
const PRIVATE_KEY = /^(?:authorization|bytes|cookie|credentialValue|password|payload|privateKey|privateKeyPem|rawSecret|secret|secretValue|token)$/iu;
const PRIVATE_VALUE = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
];

export interface FleetMigrationOccurrenceClaimRequest {
  contract: string;
  deliveryId: string;
  requestedRunId: string;
  providerVectorDigest: string;
  inventoryDigest: string;
}

export interface FleetMigrationOccurrenceCompleteRequest {
  occurrenceId: string;
  runId: string;
  deliveryId: string;
  providerVectorDigest: string;
  inventoryDigest: string;
  collectionDigest: string;
  collection: JsonValue;
}

export interface FleetMigrationOccurrenceReadRequest {
  occurrenceId: string;
  runId: string;
  providerVectorDigest: string;
}

type OccurrenceClient = Pick<typeof prisma, "fleetMigrationCollectionOccurrence">;

function invalid(code: string): never {
  throw new Error(code);
}

function assertSecretFree(value: unknown): void {
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === "string") {
      if (PRIVATE_VALUE.some((pattern) => pattern.test(item))) {
        invalid("FLEET_MIGRATION_COLLECTION_PRIVATE_SURFACE_REJECTED");
      }
      return;
    }
    if (item === null || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) {
      if (PRIVATE_KEY.test(key)) invalid("FLEET_MIGRATION_COLLECTION_PRIVATE_SURFACE_REJECTED");
      visit(nested);
    }
  };
  visit(value);
}

function assertClaim(request: FleetMigrationOccurrenceClaimRequest): void {
  if (
    request.contract !== COLLECTION_CONTRACT
    || !EVIDENCE_ID.test(request.deliveryId)
    || !EVIDENCE_ID.test(request.requestedRunId)
    || !DIGEST.test(request.providerVectorDigest)
    || !DIGEST.test(request.inventoryDigest)
  ) invalid("FLEET_MIGRATION_COLLECTION_OCCURRENCE_CLAIM_INVALID");
}

function exactIdentity(row: {
  deliveryId: string;
  runId: string;
  providerVectorDigest: string;
  inventoryDigest: string;
}, request: FleetMigrationOccurrenceClaimRequest): boolean {
  return row.deliveryId === request.deliveryId
    && row.runId === request.requestedRunId
    && row.providerVectorDigest === request.providerVectorDigest
    && row.inventoryDigest === request.inventoryDigest;
}

export function createFleetMigrationOccurrenceStore(client: OccurrenceClient = prisma) {
  return Object.freeze({
    async claim(request: FleetMigrationOccurrenceClaimRequest) {
      assertClaim(request);
      let created = false;
      let row = await client.fleetMigrationCollectionOccurrence.findUnique({
        where: { deliveryId: request.deliveryId },
      });
      if (!row) {
        try {
          row = await client.fleetMigrationCollectionOccurrence.create({
            data: {
              deliveryId: request.deliveryId,
              runId: request.requestedRunId,
              providerVectorDigest: request.providerVectorDigest,
              inventoryDigest: request.inventoryDigest,
            },
          });
          created = true;
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
            throw error;
          }
          row = await client.fleetMigrationCollectionOccurrence.findUnique({
            where: { deliveryId: request.deliveryId },
          });
        }
      }
      if (!row || !exactIdentity(row, request)) {
        invalid("FLEET_MIGRATION_COLLECTION_OCCURRENCE_CLAIM_CONFLICT");
      }
      return {
        state: row.status === "COMPLETED" ? "COMPLETED" : created ? "CLAIMED" : "RESUME",
        occurrenceId: row.id,
        runId: row.runId,
        providerVectorDigest: row.providerVectorDigest,
      };
    },

    async complete(request: FleetMigrationOccurrenceCompleteRequest) {
      if (
        !EVIDENCE_ID.test(request.occurrenceId)
        || !EVIDENCE_ID.test(request.runId)
        || !EVIDENCE_ID.test(request.deliveryId)
        || !DIGEST.test(request.providerVectorDigest)
        || !DIGEST.test(request.inventoryDigest)
        || !DIGEST.test(request.collectionDigest)
      ) invalid("FLEET_MIGRATION_COLLECTION_COMPLETION_INVALID");
      assertSecretFree(request.collection);
      const collection = request.collection as Record<string, unknown>;
      if (
        collection.contract !== COLLECTION_CONTRACT
        || collection.collectionDigest !== request.collectionDigest
        || collection.inventoryDigest !== request.inventoryDigest
        || validateFleetMigrationCollection(request.collection).ok !== true
      ) invalid("FLEET_MIGRATION_COLLECTION_COMPLETION_INVALID");

      let current = await client.fleetMigrationCollectionOccurrence.findUnique({
        where: { id: request.occurrenceId },
      });
      if (
        !current
        || current.deliveryId !== request.deliveryId
        || current.runId !== request.runId
        || current.providerVectorDigest !== request.providerVectorDigest
        || current.inventoryDigest !== request.inventoryDigest
      ) invalid("FLEET_MIGRATION_COLLECTION_COMPLETION_CONFLICT");
      if (current.status === "CLAIMED") {
        const updated = await client.fleetMigrationCollectionOccurrence.updateMany({
          where: { id: current.id, status: "CLAIMED", collectionDigest: null },
          data: {
            status: "COMPLETED",
            collectionDigest: request.collectionDigest,
            collection: request.collection as Prisma.InputJsonValue,
            completedAt: new Date(),
          },
        });
        if (updated.count === 1) {
          current = {
            ...current,
            status: "COMPLETED",
            collectionDigest: request.collectionDigest,
            collection: request.collection,
            completedAt: new Date(),
          };
        } else {
          current = await client.fleetMigrationCollectionOccurrence.findUnique({
            where: { id: request.occurrenceId },
          }) ?? invalid("FLEET_MIGRATION_COLLECTION_COMPLETION_CONFLICT");
        }
      }
      if (current.status !== "COMPLETED" || current.collectionDigest !== request.collectionDigest) {
        invalid("FLEET_MIGRATION_COLLECTION_COMPLETION_CONFLICT");
      }
      return {
        state: "COMPLETED",
        occurrenceId: current.id,
        runId: current.runId,
        providerVectorDigest: current.providerVectorDigest,
        collectionDigest: request.collectionDigest,
      };
    },

    async read(request: FleetMigrationOccurrenceReadRequest) {
      if (
        !EVIDENCE_ID.test(request.occurrenceId)
        || !EVIDENCE_ID.test(request.runId)
        || !DIGEST.test(request.providerVectorDigest)
      ) invalid("FLEET_MIGRATION_COLLECTION_OCCURRENCE_READBACK_INVALID");
      const row = await client.fleetMigrationCollectionOccurrence.findUnique({
        where: { id: request.occurrenceId },
      });
      if (
        !row
        || row.status !== "COMPLETED"
        || row.runId !== request.runId
        || row.providerVectorDigest !== request.providerVectorDigest
        || !row.collection
      ) invalid("FLEET_MIGRATION_COLLECTION_OCCURRENCE_READBACK_MISSING");
      assertSecretFree(row.collection);
      if (validateFleetMigrationCollection(row.collection).ok !== true) {
        invalid("FLEET_MIGRATION_COLLECTION_OCCURRENCE_READBACK_INVALID");
      }
      return structuredClone(row.collection);
    },
  });
}
