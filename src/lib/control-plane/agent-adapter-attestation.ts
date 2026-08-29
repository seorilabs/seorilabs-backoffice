import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import { canonicalJson, jsonDigest, type JsonValue } from "@/lib/control-plane/json";

const DOMAIN = "seori-agent-adapter-attestation-v1\n";
const SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9._:/-]{1,191}$/;

export interface AgentAdapterAttestationPayload {
  version: 1;
  runtimeIdentity: string;
  route: string;
  requestId: string;
  bodyDigest: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export function agentAdapterBodyDigest(body: JsonValue): string {
  return jsonDigest(body);
}

function parsePayload(encoded: string): AgentAdapterAttestationPayload | null {
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    const expectedKeys = [
      "bodyDigest",
      "expiresAt",
      "issuedAt",
      "nonce",
      "requestId",
      "route",
      "runtimeIdentity",
      "version",
    ].sort();
    const keys = Object.keys(value).sort();
    if (
      keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])
      || value.version !== 1
      || typeof value.runtimeIdentity !== "string"
      || !IDENTIFIER.test(value.runtimeIdentity)
      || typeof value.route !== "string"
      || !value.route.startsWith("/api/internal/agent-adapter/")
      || typeof value.requestId !== "string"
      || !IDENTIFIER.test(value.requestId)
      || typeof value.bodyDigest !== "string"
      || !SHA256.test(value.bodyDigest)
      || !Number.isSafeInteger(value.issuedAt)
      || !Number.isSafeInteger(value.expiresAt)
      || typeof value.nonce !== "string"
      || !IDENTIFIER.test(value.nonce)
    ) return null;
    return value as unknown as AgentAdapterAttestationPayload;
  } catch {
    return null;
  }
}

export function verifyAgentAdapterAttestation(input: {
  token: string;
  publicKey: string | Buffer | KeyObject;
  route: string;
  requestId: string;
  body: JsonValue;
  now?: Date;
}): AgentAdapterAttestationPayload | null {
  const [encoded, signature, ...rest] = input.token.split(".");
  if (!encoded || !signature || rest.length > 0) return null;
  const payload = parsePayload(encoded);
  if (
    !payload
    || payload.route !== input.route
    || payload.requestId !== input.requestId
    || payload.bodyDigest !== agentAdapterBodyDigest(input.body)
  ) return null;
  const now = (input.now ?? new Date()).getTime();
  if (
    payload.issuedAt > now + 5_000
    || payload.expiresAt <= now
    || payload.expiresAt <= payload.issuedAt
    || payload.expiresAt - payload.issuedAt > 60_000
  ) return null;
  try {
    const publicKey = typeof input.publicKey === "string" || Buffer.isBuffer(input.publicKey)
      ? createPublicKey(input.publicKey)
      : input.publicKey;
    if (publicKey.asymmetricKeyType !== "ed25519") return null;
    return verify(
      null,
      Buffer.from(`${DOMAIN}${encoded}`, "utf8"),
      publicKey,
      Buffer.from(signature, "base64url"),
    ) ? payload : null;
  } catch {
    return null;
  }
}

/** Trusted adapter 전용 helper다. Backoffice와 worker에는 private key를 배포하지 않는다. */
export function signAgentAdapterAttestation(input: {
  privateKey: string | Buffer | KeyObject;
  runtimeIdentity: string;
  route: string;
  requestId: string;
  body: JsonValue;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}): string {
  const payload: AgentAdapterAttestationPayload = {
    version: 1,
    runtimeIdentity: input.runtimeIdentity,
    route: input.route,
    requestId: input.requestId,
    bodyDigest: agentAdapterBodyDigest(input.body),
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
  };
  const encoded = Buffer.from(canonicalJson(payload as unknown as JsonValue), "utf8").toString("base64url");
  if (!parsePayload(encoded) || input.expiresAt <= input.issuedAt || input.expiresAt - input.issuedAt > 60_000) {
    throw new Error("AGENT_ADAPTER_ATTESTATION_PAYLOAD_INVALID");
  }
  const privateKey = typeof input.privateKey === "string" || Buffer.isBuffer(input.privateKey)
    ? createPrivateKey(input.privateKey)
    : input.privateKey;
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("AGENT_ADAPTER_ATTESTATION_KEY_INVALID");
  const signature = sign(null, Buffer.from(`${DOMAIN}${encoded}`, "utf8"), privateKey).toString("base64url");
  return `${encoded}.${signature}`;
}

export function agentAdapterNonceDigest(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}
