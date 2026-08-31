import { Buffer } from "node:buffer";
import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { request as httpsRequest, type RequestOptions } from "node:https";

import { computeFleetEvidenceDigest } from "seorilabs-org-contracts/repo-contract/fleet-migration";
import { fleetMigrationInventoryIssuerContract } from "seorilabs-org-contracts/repo-contract/trusted-inventory-issuer";

import { readBoundSecretFile } from "@/lib/control-plane/seori-auth-agent-transport";

const MAX_PUBLIC_METADATA_BYTES = 64 * 1024;
const MAX_SIGNING_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_SIGNING_RESPONSE_BYTES = 8 * 1024;
const SIGNING_ROUTE = "/v1/fleet-migration/inventory-signatures";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const SIGNING_REQUEST_KEYS = [
  "algorithm",
  "collectionCapabilityEvidenceDigest",
  "collectionDigest",
  "credentialId",
  "inventoryDigest",
  "inventoryId",
  "issuanceCapabilityEvidenceDigest",
  "keyId",
  "keyPurpose",
  "payload",
  "payloadDigest",
  "policyRevision",
  "signedAt",
].sort().join(",");

interface PublicCatalogEntry {
  schemaVersion: 1;
  credentialId: string;
  keyId: string;
  keyPurpose: string;
  algorithm: "Ed25519";
  keyFingerprint: string;
  state: "ACTIVE";
  revision: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function evidence<T extends Record<string, unknown>>(value: T): T & { evidenceDigest: string } {
  const result = { ...value, evidenceDigest: `sha256:${"0".repeat(64)}` };
  result.evidenceDigest = computeFleetEvidenceDigest(result);
  return result;
}

function parseCatalogEntry(bytes: Buffer): PublicCatalogEntry {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("FLEET_MIGRATION_INVENTORY_CATALOG_INVALID");
  }
  const entry = value as Partial<PublicCatalogEntry> | null;
  const keys = Object.keys(entry ?? {}).sort().join(",");
  if (
    keys !== "algorithm,credentialId,keyFingerprint,keyId,keyPurpose,revision,schemaVersion,state"
    || entry?.schemaVersion !== 1
    || entry.credentialId !== fleetMigrationInventoryIssuerContract.signingCredentialId
    || entry.keyId !== fleetMigrationInventoryIssuerContract.keyId
    || entry.keyPurpose !== fleetMigrationInventoryIssuerContract.keyPurpose
    || entry.algorithm !== "Ed25519"
    || entry.state !== "ACTIVE"
    || !DIGEST.test(entry.keyFingerprint ?? "")
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(entry.revision ?? "")
  ) fail("FLEET_MIGRATION_INVENTORY_CATALOG_INVALID");
  return entry as PublicCatalogEntry;
}

export async function loadFleetMigrationInventoryPublicIdentity(input: {
  root: string;
  publicKeyFile: string;
  publicCatalogFile: string;
}): Promise<{ publicKey: KeyObject; catalog: PublicCatalogEntry }> {
  const [publicKeyBytes, catalogBytes] = await Promise.all([
    readBoundSecretFile({
      root: input.root,
      relativePath: input.publicKeyFile,
      allowGroupRead: true,
      maxBytes: MAX_PUBLIC_METADATA_BYTES,
    }),
    readBoundSecretFile({
      root: input.root,
      relativePath: input.publicCatalogFile,
      allowGroupRead: true,
      maxBytes: MAX_PUBLIC_METADATA_BYTES,
    }),
  ]);
  try {
    const publicKey = createPublicKey(publicKeyBytes);
    if (publicKey.asymmetricKeyType !== "ed25519") fail("FLEET_MIGRATION_INVENTORY_PUBLIC_KEY_INVALID");
    const spki = publicKey.export({ format: "der", type: "spki" });
    try {
      const catalog = parseCatalogEntry(catalogBytes);
      if (sha256(spki) !== catalog.keyFingerprint) fail("FLEET_MIGRATION_INVENTORY_PUBLIC_KEY_MISMATCH");
      return { publicKey, catalog };
    } finally {
      spki.fill(0);
    }
  } finally {
    publicKeyBytes.fill(0);
    catalogBytes.fill(0);
  }
}

export interface FleetMigrationSigningServiceResponse {
  algorithm: "Ed25519";
  credentialId: string;
  keyFingerprint: string;
  keyId: string;
  value: string;
}

export type FleetMigrationSigningTransport = (
  request: Record<string, unknown> & { payload: Buffer },
) => Promise<FleetMigrationSigningServiceResponse>;

export function createFleetMigrationInventoryIssuerAdapters(input: {
  catalog: PublicCatalogEntry;
  signingTransport: FleetMigrationSigningTransport;
  now?: () => Date;
}) {
  return Object.freeze({
    async readSigningKeyPublicIdentity(request: Record<string, unknown>) {
      if (
        request.contract !== fleetMigrationInventoryIssuerContract.signingKeyReadbackContract
        || request.credentialId !== input.catalog.credentialId
        || request.keyId !== input.catalog.keyId
        || request.keyPurpose !== input.catalog.keyPurpose
        || request.readMode !== "CURRENT_PUBLIC_METADATA"
      ) fail("FLEET_MIGRATION_INVENTORY_SIGNING_KEY_REQUEST_INVALID");
      const observedAt = input.now?.() ?? new Date();
      if (!Number.isFinite(observedAt.getTime())) fail("FLEET_MIGRATION_INVENTORY_SIGNING_KEY_TIME_INVALID");
      return evidence({
        contract: fleetMigrationInventoryIssuerContract.signingKeyReadbackContract,
        readbackId: `inventory-signing-key-readback-${observedAt.getTime()}`,
        observedAt: observedAt.toISOString(),
        revision: input.catalog.revision,
        algorithm: input.catalog.algorithm,
        credentialId: input.catalog.credentialId,
        keyId: input.catalog.keyId,
        keyPurpose: input.catalog.keyPurpose,
        keyFingerprint: input.catalog.keyFingerprint,
        state: input.catalog.state,
      });
    },
    async signInventoryPayload(request: Record<string, unknown> & { payload: Buffer }) {
      if (
        Object.keys(request).sort().join(",") !== SIGNING_REQUEST_KEYS
        ||
        !Buffer.isBuffer(request.payload)
        || request.payload.length < 1
        || request.payload.length > MAX_SIGNING_PAYLOAD_BYTES
        || request.algorithm !== "Ed25519"
        || request.credentialId !== input.catalog.credentialId
        || request.keyId !== input.catalog.keyId
        || request.keyPurpose !== input.catalog.keyPurpose
        || !DIGEST.test(String(request.payloadDigest ?? ""))
        || sha256(request.payload) !== request.payloadDigest
      ) fail("FLEET_MIGRATION_INVENTORY_SIGNING_REQUEST_INVALID");
      const result = await input.signingTransport(request);
      if (
        Object.keys(result).sort().join(",") !== "algorithm,credentialId,keyFingerprint,keyId,value"
        ||
        result.algorithm !== "Ed25519"
        || result.credentialId !== input.catalog.credentialId
        || result.keyId !== input.catalog.keyId
        || result.keyFingerprint !== input.catalog.keyFingerprint
        || !SIGNATURE.test(result.value)
      ) fail("FLEET_MIGRATION_INVENTORY_SIGNING_RESPONSE_INVALID");
      return {
        algorithm: result.algorithm,
        credentialId: result.credentialId,
        keyFingerprint: result.keyFingerprint,
        keyId: result.keyId,
        value: result.value,
      };
    },
  });
}

export async function withFleetMigrationMtlsMaterial<Result>(input: {
  root: string;
  caFile: string;
  certificateFile: string;
  privateKeyFile: string;
}, execute: (material: { ca: Buffer; certificate: Buffer; privateKey: Buffer }) => Promise<Result>): Promise<Result> {
  let ca: Buffer | undefined;
  let certificate: Buffer | undefined;
  let privateKey: Buffer | undefined;
  try {
    ca = await readBoundSecretFile({ root: input.root, relativePath: input.caFile, allowGroupRead: true, maxBytes: 1024 * 1024 });
    certificate = await readBoundSecretFile({ root: input.root, relativePath: input.certificateFile, allowGroupRead: true, maxBytes: 1024 * 1024 });
    privateKey = await readBoundSecretFile({ root: input.root, relativePath: input.privateKeyFile, allowGroupRead: true, maxBytes: 1024 * 1024 });
    return await execute({ ca, certificate, privateKey });
  } finally {
    ca?.fill(0);
    certificate?.fill(0);
    privateKey?.fill(0);
  }
}

export function createFleetMigrationMtlsSigningTransport(input: {
  origin: string;
  root: string;
  caFile: string;
  certificateFile: string;
  privateKeyFile: string;
}): FleetMigrationSigningTransport {
  const origin = new URL(input.origin);
  if (
    origin.protocol !== "https:"
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
    || origin.username
    || origin.password
  ) fail("FLEET_MIGRATION_SIGNING_SERVICE_ORIGIN_INVALID");
  return async (request) => {
    const body = Buffer.from(JSON.stringify({
      algorithm: request.algorithm,
      collectionCapabilityEvidenceDigest: request.collectionCapabilityEvidenceDigest,
      collectionDigest: request.collectionDigest,
      credentialId: request.credentialId,
      inventoryDigest: request.inventoryDigest,
      inventoryId: request.inventoryId,
      issuanceCapabilityEvidenceDigest: request.issuanceCapabilityEvidenceDigest,
      keyId: request.keyId,
      keyPurpose: request.keyPurpose,
      payload: request.payload.toString("base64"),
      payloadDigest: request.payloadDigest,
      payloadEncoding: "base64",
      policyRevision: request.policyRevision,
      signedAt: request.signedAt,
    }), "utf8");
    try {
      return await withFleetMigrationMtlsMaterial(input, async ({ ca, certificate, privateKey }) => (
        new Promise<FleetMigrationSigningServiceResponse>((resolve, reject) => {
          const options: RequestOptions = {
            protocol: "https:",
            hostname: origin.hostname,
            port: origin.port ? Number(origin.port) : 443,
            method: "POST",
            path: SIGNING_ROUTE,
            ca,
            cert: certificate,
            key: privateKey,
            servername: origin.hostname,
            minVersion: "TLSv1.3",
            maxVersion: "TLSv1.3",
            timeout: 10_000,
            headers: {
              "content-type": "application/json",
              "content-length": String(body.length),
            },
          };
          const outgoing = httpsRequest(options, (incoming) => {
            const chunks: Buffer[] = [];
            let size = 0;
            let settled = false;
            const rejectResponse = (error: Error) => {
              if (settled) return;
              settled = true;
              chunks.forEach((chunk) => chunk.fill(0));
              incoming.destroy();
              reject(error);
            };
            incoming.on("data", (chunk: Buffer) => {
              const copy = Buffer.from(chunk);
              size += copy.length;
              if (size > MAX_SIGNING_RESPONSE_BYTES) {
                copy.fill(0);
                rejectResponse(new Error("FLEET_MIGRATION_SIGNING_SERVICE_RESPONSE_LIMIT"));
              } else chunks.push(copy);
            });
            incoming.once("error", () => {
              rejectResponse(new Error("FLEET_MIGRATION_SIGNING_SERVICE_RESPONSE_INVALID"));
            });
            incoming.on("end", () => {
              if (settled) return;
              settled = true;
              const response = Buffer.concat(chunks);
              try {
                if (incoming.statusCode !== 200) fail("FLEET_MIGRATION_SIGNING_SERVICE_REJECTED");
                resolve(JSON.parse(response.toString("utf8")) as FleetMigrationSigningServiceResponse);
              } catch {
                reject(new Error("FLEET_MIGRATION_SIGNING_SERVICE_RESPONSE_INVALID"));
              } finally {
                response.fill(0);
                chunks.forEach((chunk) => chunk.fill(0));
              }
            });
          });
          outgoing.once("timeout", () => outgoing.destroy(new Error("FLEET_MIGRATION_SIGNING_SERVICE_TIMEOUT")));
          outgoing.once("error", reject);
          outgoing.end(body);
        })
      ));
    } finally {
      body.fill(0);
    }
  };
}
