import { Prisma } from "@prisma/client";
import { validateFleetMigrationCollection } from "seorilabs-org-contracts/repo-contract/fleet-migration-collector";

import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { prisma } from "@/lib/prisma";

const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COLLECTION_CONTRACT = "seorilabs-fleet-migration-collection-v1";
const FINALIZATION_CONTRACT = "seorilabs-fleet-migration-finalization-v1";
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

export interface FleetMigrationFinalizationEvidence {
  finalGithubDigest: string;
  finalBackofficeDigest: string;
  finalizationDigest: string;
}

export interface FleetMigrationOccurrenceCompleteRequest extends FleetMigrationFinalizationEvidence {
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

type OccurrenceClient = Pick<
  typeof prisma,
  "fleetMigrationCollectionOccurrence" | "fleetMigrationCollectionCompletion"
>;

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

function digest(value: JsonValue): string {
  return `sha256:${jsonDigest(value)}`;
}

export function computeFleetMigrationFinalizationDigest(input: {
  occurrenceId: string;
  runId: string;
  deliveryId: string;
  providerVectorDigest: string;
  inventoryDigest: string;
  collectionDigest: string;
  finalGithubDigest: string;
  finalBackofficeDigest: string;
}): string {
  return digest({
    contract: FINALIZATION_CONTRACT,
    collectionDigest: input.collectionDigest,
    deliveryId: input.deliveryId,
    finalBackofficeDigest: input.finalBackofficeDigest,
    finalGithubDigest: input.finalGithubDigest,
    inventoryDigest: input.inventoryDigest,
    occurrenceId: input.occurrenceId,
    providerVectorDigest: input.providerVectorDigest,
    runId: input.runId,
  });
}

function assertCollectionBinding(request: FleetMigrationOccurrenceCompleteRequest): void {
  if (
    !EVIDENCE_ID.test(request.occurrenceId)
    || !EVIDENCE_ID.test(request.runId)
    || !EVIDENCE_ID.test(request.deliveryId)
    || !DIGEST.test(request.providerVectorDigest)
    || !DIGEST.test(request.inventoryDigest)
    || !DIGEST.test(request.collectionDigest)
    || !DIGEST.test(request.finalGithubDigest)
    || !DIGEST.test(request.finalBackofficeDigest)
    || !DIGEST.test(request.finalizationDigest)
  ) invalid("FLEET_MIGRATION_COLLECTION_COMPLETION_INVALID");
  assertSecretFree(request.collection);
  const collection = request.collection as Record<string, unknown>;
  const occurrence = collection.occurrence as Record<string, unknown> | null;
  if (
    collection.contract !== COLLECTION_CONTRACT
    || collection.collectionDigest !== request.collectionDigest
    || collection.inventoryDigest !== request.inventoryDigest
    || occurrence?.occurrenceId !== request.occurrenceId
    || occurrence.runId !== request.runId
    || occurrence.providerVectorDigest !== request.providerVectorDigest
    || validateFleetMigrationCollection(request.collection).ok !== true
    || request.finalizationDigest !== computeFleetMigrationFinalizationDigest(request)
  ) invalid("FLEET_MIGRATION_COLLECTION_COMPLETION_INVALID");
}

function exactCompletion(row: {
  occurrenceId: string;
  deliveryId: string;
  runId: string;
  providerVectorDigest: string;
  inventoryDigest: string;
  collectionDigest: string;
  finalGithubDigest: string;
  finalBackofficeDigest: string;
  finalizationDigest: string;
  collection: unknown;
}, request: FleetMigrationOccurrenceCompleteRequest): boolean {
  return row.occurrenceId === request.occurrenceId
    && row.deliveryId === request.deliveryId
    && row.runId === request.runId
    && row.providerVectorDigest === request.providerVectorDigest
    && row.inventoryDigest === request.inventoryDigest
    && row.collectionDigest === request.collectionDigest
    && row.finalGithubDigest === request.finalGithubDigest
    && row.finalBackofficeDigest === request.finalBackofficeDigest
    && row.finalizationDigest === request.finalizationDigest
    && jsonDigest(row.collection as JsonValue) === jsonDigest(request.collection);
}

export function createFleetMigrationOccurrenceStore(client: OccurrenceClient = prisma) {
  return Object.freeze({
    async claim(request: FleetMigrationOccurrenceClaimRequest) {
      assertClaim(request);
      let created = false;
      let row = await client.fleetMigrationCollectionOccurrence.findUnique({
        where: { deliveryId: request.deliveryId },
        include: { completion: { select: { id: true } } },
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
            include: { completion: { select: { id: true } } },
          });
          created = true;
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
            throw error;
          }
          row = await client.fleetMigrationCollectionOccurrence.findUnique({
            where: { deliveryId: request.deliveryId },
            include: { completion: { select: { id: true } } },
          });
        }
      }
      if (!row || !exactIdentity(row, request)) {
        invalid("FLEET_MIGRATION_COLLECTION_OCCURRENCE_CLAIM_CONFLICT");
      }
      return {
        state: row.completion ? "COMPLETED" : created ? "CLAIMED" : "RESUME",
        occurrenceId: row.id,
        runId: row.runId,
        providerVectorDigest: row.providerVectorDigest,
      };
    },

    async complete(request: FleetMigrationOccurrenceCompleteRequest) {
      assertCollectionBinding(request);
      const claim = await client.fleetMigrationCollectionOccurrence.findUnique({
        where: { id: request.occurrenceId },
      });
      if (
        !claim
        || claim.deliveryId !== request.deliveryId
        || claim.runId !== request.runId
        || claim.providerVectorDigest !== request.providerVectorDigest
        || claim.inventoryDigest !== request.inventoryDigest
      ) invalid("FLEET_MIGRATION_COLLECTION_COMPLETION_CONFLICT");

      let completion = await client.fleetMigrationCollectionCompletion.findUnique({
        where: { occurrenceId: request.occurrenceId },
      });
      if (!completion) {
        try {
          completion = await client.fleetMigrationCollectionCompletion.create({
            data: {
              occurrenceId: request.occurrenceId,
              deliveryId: request.deliveryId,
              runId: request.runId,
              providerVectorDigest: request.providerVectorDigest,
              inventoryDigest: request.inventoryDigest,
              collectionDigest: request.collectionDigest,
              finalGithubDigest: request.finalGithubDigest,
              finalBackofficeDigest: request.finalBackofficeDigest,
              finalizationDigest: request.finalizationDigest,
              collection: request.collection as Prisma.InputJsonValue,
            },
          });
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
            throw error;
          }
          completion = await client.fleetMigrationCollectionCompletion.findUnique({
            where: { occurrenceId: request.occurrenceId },
          });
        }
      }
      if (!completion || !exactCompletion(completion, request)) {
        invalid("FLEET_MIGRATION_COLLECTION_COMPLETION_CONFLICT");
      }
      return {
        state: "COMPLETED",
        occurrenceId: claim.id,
        runId: claim.runId,
        providerVectorDigest: claim.providerVectorDigest,
        collectionDigest: completion.collectionDigest,
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
        include: { completion: true },
      });
      const completion = row?.completion;
      if (
        !row
        || row.runId !== request.runId
        || row.providerVectorDigest !== request.providerVectorDigest
        || !completion
        || completion.occurrenceId !== row.id
        || completion.deliveryId !== row.deliveryId
        || completion.runId !== row.runId
        || completion.providerVectorDigest !== row.providerVectorDigest
        || completion.inventoryDigest !== row.inventoryDigest
        || completion.finalizationDigest !== computeFleetMigrationFinalizationDigest(completion)
      ) invalid("FLEET_MIGRATION_COLLECTION_OCCURRENCE_READBACK_MISSING");
      assertSecretFree(completion.collection);
      const collection = completion.collection as Record<string, unknown>;
      const occurrence = collection.occurrence as Record<string, unknown> | null;
      if (
        completion.collectionDigest !== collection.collectionDigest
        || row.inventoryDigest !== collection.inventoryDigest
        || occurrence?.occurrenceId !== row.id
        || occurrence.runId !== row.runId
        || occurrence.providerVectorDigest !== row.providerVectorDigest
        || validateFleetMigrationCollection(completion.collection).ok !== true
      ) invalid("FLEET_MIGRATION_COLLECTION_OCCURRENCE_READBACK_INVALID");
      return structuredClone(completion.collection);
    },
  });
}
