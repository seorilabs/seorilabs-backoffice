import {
  createHash,
  createPrivateKey,
  randomBytes,
  sign,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

import type { ProviderCommandEnvelope } from "@/lib/control-plane/contracts";
import {
  buildProviderBrokerRequest,
  providerBrokerRequestDigest,
  type ProviderBrokerRequest,
  type ProviderBrokerStage,
} from "@/lib/control-plane/provider-adapter-client";

const ATTESTATION_DOMAIN = "seori-run-attestation-v1\n";
const SHA256 = /^[0-9a-f]{64}$/;

export type DurableProviderClaim = {
  id: string;
  status: string;
  leaseGeneration: number;
  workerId: string | null;
  leaseExpiresAt: Date | null;
  repoId: bigint;
  repoFullName: string;
  sourceSha: string;
  bindingHash: string;
};

export function providerSignerRequestId(input: {
  executionId: string;
  generation: number;
  stage: ProviderBrokerStage;
  ordinal: number;
}): string {
  const digest = createHash("sha256")
    .update(`${input.executionId}\n${input.generation}\n${input.stage}\n${input.ordinal}`, "utf8")
    .digest("hex");
  return `provider-attestation:${digest}`;
}

export function assertDurableProviderClaim(input: {
  claim: DurableProviderClaim | null;
  executionId: string;
  generation: number;
  workerId: string;
  now: Date;
}): DurableProviderClaim & { leaseExpiresAt: Date } {
  const claim = input.claim;
  if (
    !claim
    || claim.id !== input.executionId
    || claim.status !== "RUNNING"
    || claim.leaseGeneration !== input.generation
    || claim.workerId !== input.workerId
    || !claim.leaseExpiresAt
    || claim.leaseExpiresAt.getTime() - input.now.getTime() < 5_000
  ) {
    throw new Error("PROVIDER_SIGNER_STALE_DURABLE_CLAIM");
  }
  return claim as DurableProviderClaim & { leaseExpiresAt: Date };
}

export function assertProviderBrokerRequestBinding(input: {
  envelope: ProviderCommandEnvelope;
  subject: string;
  workerId: string;
  stage: ProviderBrokerStage;
  ordinal: number;
  expectedRequestDigest: string;
}): ProviderBrokerRequest {
  if (!SHA256.test(input.expectedRequestDigest)) {
    throw new Error("PROVIDER_SIGNER_REQUEST_DIGEST_INVALID");
  }
  const request = buildProviderBrokerRequest(input);
  const actual = Buffer.from(providerBrokerRequestDigest(request), "hex");
  const expected = Buffer.from(input.expectedRequestDigest, "hex");
  if (!timingSafeEqual(actual, expected)) {
    throw new Error("PROVIDER_SIGNER_REQUEST_BINDING_MISMATCH");
  }
  return request;
}

export function createRunAttestationNonce(): string {
  return randomBytes(18).toString("base64url");
}

export function runAttestationNonceDigest(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

/**
 * 이 함수는 signer process에서만 호출한다. worker bundle은 이 모듈을 import하지 않으며
 * production worker에는 private key volume도 broker network route도 없다.
 */
export function signRunAttestation(input: {
  privateKey: string | Buffer | KeyObject;
  clientSpiffeId: string;
  subject: string;
  runId: string;
  repository: string;
  workerId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}) {
  if (
    !Number.isSafeInteger(input.issuedAt)
    || !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt <= input.issuedAt
    || input.expiresAt - input.issuedAt > 60_000
  ) throw new Error("RUN_ATTESTATION_TIME_INVALID");
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    clientSpiffeId: input.clientSpiffeId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
    subject: input.subject,
    runId: input.runId,
    repository: input.repository,
    workerId: input.workerId,
  }), "utf8").toString("base64url");
  const privateKey = typeof input.privateKey === "string" || Buffer.isBuffer(input.privateKey)
    ? createPrivateKey(input.privateKey)
    : input.privateKey;
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("RUN_ATTESTATION_KEY_INVALID");
  const signature = sign(
    null,
    Buffer.from(`${ATTESTATION_DOMAIN}${payload}`, "utf8"),
    privateKey,
  ).toString("base64url");
  return `${payload}.${signature}`;
}
