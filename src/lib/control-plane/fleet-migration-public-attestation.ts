import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import { canonicalJson, jsonDigest, type JsonValue } from "@/lib/control-plane/json";

const CONTRACT = "seorilabs-fleet-migration-public-attestation-v1";
const DOMAIN = `${CONTRACT}\n`;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;

export type FleetMigrationAttestationPurpose = "SHADOW_RUNTIME" | "PROOF_WRITE_APPROVAL";

export interface FleetMigrationPublicAttestation {
  contract: typeof CONTRACT;
  purpose: FleetMigrationAttestationPurpose;
  keyId: string;
  keyFingerprint: string;
  policyRevision: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  payloadDigest: string;
  payload: Record<string, JsonValue>;
  signature: string;
}

type UnsignedAttestation = Omit<FleetMigrationPublicAttestation, "signature">;

function fail(code: string): never {
  throw new Error(code);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : Number.NaN;
}

function publicKeyFingerprint(key: KeyObject): string {
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}

function unsigned(value: FleetMigrationPublicAttestation): UnsignedAttestation {
  const result = { ...value } as Partial<FleetMigrationPublicAttestation>;
  Reflect.deleteProperty(result, "signature");
  return result as UnsignedAttestation;
}

export function fleetMigrationAttestationDigest(value: FleetMigrationPublicAttestation): string {
  return jsonDigest(value as unknown as JsonValue);
}

export function verifyFleetMigrationPublicAttestation(input: {
  value: unknown;
  publicKey: string | Buffer | KeyObject;
  purpose: FleetMigrationAttestationPurpose;
  expectedKeyId: string;
  expectedKeyFingerprint: string;
  expectedPolicyRevision: string;
  maxTtlMs: number;
  now?: Date;
}): FleetMigrationPublicAttestation {
  const value = structuredClone(input.value) as FleetMigrationPublicAttestation;
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value as unknown as Record<string, unknown>, [
      "contract",
      "expiresAt",
      "issuedAt",
      "keyFingerprint",
      "keyId",
      "nonce",
      "payload",
      "payloadDigest",
      "policyRevision",
      "purpose",
      "signature",
    ])
    || value.contract !== CONTRACT
    || value.purpose !== input.purpose
    || value.keyId !== input.expectedKeyId
    || value.keyFingerprint !== input.expectedKeyFingerprint
    || value.policyRevision !== input.expectedPolicyRevision
    || !PUBLIC_ID.test(value.keyId)
    || !PUBLIC_ID.test(value.policyRevision)
    || !PUBLIC_ID.test(value.nonce)
    || !SHA256.test(value.keyFingerprint)
    || !SHA256.test(value.payloadDigest)
    || !SIGNATURE.test(value.signature)
    || !value.payload
    || typeof value.payload !== "object"
    || Array.isArray(value.payload)
    || value.payloadDigest !== jsonDigest(value.payload as unknown as JsonValue)
  ) fail("FLEET_MIGRATION_PUBLIC_ATTESTATION_INVALID");

  const issuedAt = parseTimestamp(value.issuedAt);
  const expiresAt = parseTimestamp(value.expiresAt);
  const now = (input.now ?? new Date()).getTime();
  if (
    !Number.isFinite(now)
    || !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || issuedAt > now + 5_000
    || expiresAt <= now
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > input.maxTtlMs
  ) fail("FLEET_MIGRATION_PUBLIC_ATTESTATION_EXPIRED");

  try {
    const key = typeof input.publicKey === "string" || Buffer.isBuffer(input.publicKey)
      ? createPublicKey(input.publicKey)
      : input.publicKey;
    if (
      key.type !== "public"
      || key.asymmetricKeyType !== "ed25519"
      || publicKeyFingerprint(key) !== value.keyFingerprint
      || !verify(
        null,
        Buffer.from(`${DOMAIN}${canonicalJson(unsigned(value) as unknown as JsonValue)}`, "utf8"),
        key,
        Buffer.from(value.signature, "base64url"),
      )
    ) fail("FLEET_MIGRATION_PUBLIC_ATTESTATION_SIGNATURE_INVALID");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("FLEET_MIGRATION_")) throw error;
    fail("FLEET_MIGRATION_PUBLIC_ATTESTATION_SIGNATURE_INVALID");
  }
  return Object.freeze(value);
}

/** 테스트와 별도 trusted verifier 구현에서만 사용한다. private key는 shadow runtime에 배포하지 않는다. */
export function signFleetMigrationPublicAttestation(input: {
  privateKey: string | Buffer | KeyObject;
  purpose: FleetMigrationAttestationPurpose;
  keyId: string;
  policyRevision: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  payload: Record<string, JsonValue>;
}): FleetMigrationPublicAttestation {
  const key = typeof input.privateKey === "string" || Buffer.isBuffer(input.privateKey)
    ? createPrivateKey(input.privateKey)
    : input.privateKey;
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    fail("FLEET_MIGRATION_PUBLIC_ATTESTATION_SIGNING_KEY_INVALID");
  }
  const publicKey = createPublicKey(key);
  const value: FleetMigrationPublicAttestation = {
    contract: CONTRACT,
    purpose: input.purpose,
    keyId: input.keyId,
    keyFingerprint: publicKeyFingerprint(publicKey),
    policyRevision: input.policyRevision,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
    payloadDigest: jsonDigest(input.payload as unknown as JsonValue),
    payload: structuredClone(input.payload),
    signature: "A".repeat(86),
  };
  value.signature = sign(
    null,
    Buffer.from(`${DOMAIN}${canonicalJson(unsigned(value) as unknown as JsonValue)}`, "utf8"),
    key,
  ).toString("base64url");
  return value;
}
