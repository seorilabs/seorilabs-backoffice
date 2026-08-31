import { Buffer } from "node:buffer";
import {
  createHash,
  createPublicKey,
  sign as signEd25519,
  type KeyObject,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server, type ServerOptions } from "node:https";
import type { TLSSocket } from "node:tls";
import { z } from "zod";

import { fleetMigrationInventoryIssuerContract } from "seorilabs-org-contracts/repo-contract/trusted-inventory-issuer";

export const FLEET_MIGRATION_INVENTORY_SIGNING_ROUTE = "/v1/fleet-migration/inventory-signatures" as const;
export const FLEET_MIGRATION_INVENTORY_ISSUER_SPIFFE_ID =
  "spiffe://seorilabs.local/ns/platform/sa/fleet-migration-inventory-issuer" as const;

const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = Math.ceil(MAX_PAYLOAD_BYTES * 4 / 3) + 64 * 1024;
const MAX_CLOCK_SKEW_MS = 5_000;
const MAX_REQUEST_AGE_MS = 60_000;
const MAX_INVENTORY_LIFETIME_MS = 65 * 60_000;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SHA = /^[0-9a-f]{40}$/u;

const signingRequestSchema = z.object({
  algorithm: z.literal("Ed25519"),
  collectionCapabilityEvidenceDigest: z.string().regex(DIGEST),
  collectionDigest: z.string().regex(DIGEST),
  credentialId: z.literal(fleetMigrationInventoryIssuerContract.signingCredentialId),
  inventoryDigest: z.string().regex(DIGEST),
  inventoryId: z.string().regex(EVIDENCE_ID),
  issuanceCapabilityEvidenceDigest: z.string().regex(DIGEST),
  keyId: z.literal(fleetMigrationInventoryIssuerContract.keyId),
  keyPurpose: z.literal(fleetMigrationInventoryIssuerContract.keyPurpose),
  payload: z.string().min(4).max(MAX_REQUEST_BYTES),
  payloadDigest: z.string().regex(DIGEST),
  payloadEncoding: z.literal("base64"),
  policyRevision: z.literal(fleetMigrationInventoryIssuerContract.policyRevision),
  signedAt: z.string(),
}).strict();

const attestationPayloadSchema = z.object({
  algorithm: z.literal("Ed25519"),
  baselineRatification: z.record(z.unknown()).nullable().optional(),
  capturedAt: z.string(),
  contract: z.literal("seorilabs-fleet-migration-inventory-attestation-v2"),
  coverageObservedAt: z.string(),
  coverageProvider: z.literal("GITHUB_APP_INSTALLATION_REPOSITORY_READBACK"),
  coverageQuery: z.record(z.unknown()),
  coverageReadbackId: z.string().regex(EVIDENCE_ID),
  coverageSnapshotId: z.string().regex(EVIDENCE_ID),
  detectorSourceSha: z.string().regex(SHA),
  expectedCounts: z.record(z.unknown()),
  expiresAt: z.string(),
  installationId: z.literal("142120077"),
  inventoryDigest: z.string().regex(DIGEST),
  inventoryId: z.string().regex(EVIDENCE_ID),
  keyId: z.literal(fleetMigrationInventoryIssuerContract.keyId),
  lineage: z.record(z.unknown()),
  organizationId: z.literal("283115031"),
  organizationLogin: z.literal("seorilabs"),
  policyRevision: z.literal(fleetMigrationInventoryIssuerContract.policyRevision),
  providerTotalCount: z.number().int().min(1).max(10_000),
  repositoriesDigest: z.string().regex(DIGEST),
  signedAt: z.string(),
}).strict();

export interface FleetMigrationInventorySigningResponse {
  algorithm: "Ed25519";
  credentialId: string;
  keyFingerprint: string;
  keyId: string;
  value: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalIso(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("FLEET_MIGRATION_SIGNING_TIME_INVALID");
  }
  return milliseconds;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort(compareUtf8)
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function keyFingerprint(privateKey: KeyObject): string {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    fail("FLEET_MIGRATION_SIGNING_KEY_INVALID");
  }
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: "der", type: "spki" });
  try {
    return sha256(spki);
  } finally {
    spki.fill(0);
  }
}

function decodeCanonicalPayload(encoded: string): {
  bytes: Buffer;
  value: z.infer<typeof attestationPayloadSchema>;
} {
  let bytes: Buffer | undefined;
  try {
    bytes = Buffer.from(encoded, "base64");
    if (
      bytes.length < 1
      || bytes.length > MAX_PAYLOAD_BYTES
      || bytes.toString("base64") !== encoded
    ) fail("FLEET_MIGRATION_SIGNING_PAYLOAD_INVALID");
    const parsed = attestationPayloadSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (JSON.stringify(canonicalize(parsed)) !== bytes.toString("utf8")) {
      fail("FLEET_MIGRATION_SIGNING_PAYLOAD_NOT_CANONICAL");
    }
    return { bytes, value: parsed };
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof Error && error.message.startsWith("FLEET_MIGRATION_")) throw error;
    fail("FLEET_MIGRATION_SIGNING_PAYLOAD_INVALID");
  }
}

export function signFleetMigrationInventoryPayload(input: {
  body: unknown;
  privateKey: KeyObject;
  expectedKeyFingerprint: string;
  now: Date;
}): FleetMigrationInventorySigningResponse {
  if (!DIGEST.test(input.expectedKeyFingerprint) || !Number.isFinite(input.now.getTime())) {
    fail("FLEET_MIGRATION_SIGNING_CONFIGURATION_INVALID");
  }
  const actualFingerprint = keyFingerprint(input.privateKey);
  if (actualFingerprint !== input.expectedKeyFingerprint) {
    fail("FLEET_MIGRATION_SIGNING_KEY_FINGERPRINT_MISMATCH");
  }
  const request = signingRequestSchema.parse(input.body);
  const payload = decodeCanonicalPayload(request.payload);
  let signature: Buffer | undefined;
  try {
    if (
      request.payloadDigest !== sha256(payload.bytes)
      || payload.value.inventoryId !== request.inventoryId
      || payload.value.inventoryDigest !== request.inventoryDigest
      || payload.value.signedAt !== request.signedAt
    ) fail("FLEET_MIGRATION_SIGNING_REQUEST_BINDING_MISMATCH");

    const now = input.now.getTime();
    const signedAt = canonicalIso(request.signedAt);
    const capturedAt = canonicalIso(payload.value.capturedAt);
    const expiresAt = canonicalIso(payload.value.expiresAt);
    const coverageObservedAt = canonicalIso(payload.value.coverageObservedAt);
    if (
      signedAt > now + MAX_CLOCK_SKEW_MS
      || now - signedAt > MAX_REQUEST_AGE_MS
      || capturedAt > signedAt
      || coverageObservedAt > signedAt
      || expiresAt <= signedAt
      || expiresAt - signedAt > MAX_INVENTORY_LIFETIME_MS
    ) fail("FLEET_MIGRATION_SIGNING_TIME_INVALID");

    signature = signEd25519(null, payload.bytes, input.privateKey);
    if (signature.length !== 64) fail("FLEET_MIGRATION_SIGNING_FAILED");
    return {
      algorithm: "Ed25519",
      credentialId: fleetMigrationInventoryIssuerContract.signingCredentialId,
      keyFingerprint: actualFingerprint,
      keyId: fleetMigrationInventoryIssuerContract.keyId,
      value: signature.toString("base64url"),
    };
  } finally {
    signature?.fill(0);
    payload.bytes.fill(0);
  }
}

function assertIssuerPeer(socket: TLSSocket): void {
  if (!socket.authorized) fail("FLEET_MIGRATION_SIGNING_MTLS_REQUIRED");
  const certificate = socket.getPeerCertificate(true);
  if (certificate.subjectaltname !== `URI:${FLEET_MIGRATION_INVENTORY_ISSUER_SPIFFE_ID}`) {
    fail("FLEET_MIGRATION_SIGNING_CLIENT_IDENTITY_MISMATCH");
  }
}

function signingRequestLength(request: IncomingMessage): number {
  const contentLength = request.headers["content-length"];
  if (
    request.method !== "POST"
    || request.url !== FLEET_MIGRATION_INVENTORY_SIGNING_ROUTE
    || request.headers["content-type"] !== "application/json"
    || request.headers["transfer-encoding"] !== undefined
    || typeof contentLength !== "string"
    || !/^[1-9][0-9]*$/u.test(contentLength)
  ) fail("FLEET_MIGRATION_SIGNING_ROUTE_REJECTED");
  const length = Number(contentLength);
  if (!Number.isSafeInteger(length) || length > MAX_REQUEST_BYTES) {
    fail("FLEET_MIGRATION_SIGNING_REQUEST_TOO_LARGE");
  }
  return length;
}

async function readJson(request: IncomingMessage, expectedLength: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const copy = Buffer.from(chunk as Buffer);
      size += copy.length;
      if (size > MAX_REQUEST_BYTES) {
        copy.fill(0);
        fail("FLEET_MIGRATION_SIGNING_REQUEST_TOO_LARGE");
      }
      chunks.push(copy);
    }
    if (size !== expectedLength) fail("FLEET_MIGRATION_SIGNING_REQUEST_LENGTH_MISMATCH");
    const body = Buffer.concat(chunks);
    try {
      return JSON.parse(body.toString("utf8"));
    } finally {
      body.fill(0);
    }
  } finally {
    chunks.forEach((chunk) => chunk.fill(0));
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(encoded.length),
    "content-type": "application/json",
  });
  response.end(encoded, () => encoded.fill(0));
}

export function createFleetMigrationInventorySigningServer(input: {
  tls: ServerOptions;
  privateKey: KeyObject;
  expectedKeyFingerprint: string;
  now?: () => Date;
}): Server {
  const server = createServer({
    ...input.tls,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    requestCert: true,
    rejectUnauthorized: true,
  }, async (request, response) => {
    try {
      assertIssuerPeer(request.socket as TLSSocket);
      const expectedLength = signingRequestLength(request);
      const result = signFleetMigrationInventoryPayload({
        body: await readJson(request, expectedLength),
        privateKey: input.privateKey,
        expectedKeyFingerprint: input.expectedKeyFingerprint,
        now: input.now?.() ?? new Date(),
      });
      respond(response, 200, result);
    } catch {
      respond(response, 403, { error: "FLEET_MIGRATION_SIGNING_REQUEST_REJECTED" });
    }
  });
  server.maxHeadersCount = 24;
  server.headersTimeout = 15_000;
  server.requestTimeout = 15_000;
  return server;
}
