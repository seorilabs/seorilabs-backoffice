import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

function validHex(value: string, bytes: number): boolean {
  return value.length === bytes * 2 && /^[0-9a-f]+$/i.test(value);
}

export function verifyDiscordSignature(input: {
  body: string;
  signature: string | null;
  timestamp: string | null;
  publicKey: string;
  now?: Date;
}): boolean {
  const signature = input.signature ?? "";
  const timestamp = input.timestamp ?? "";
  if (!validHex(signature, 64) || !validHex(input.publicKey, 32) || !/^\d{10,13}$/.test(timestamp)) {
    return false;
  }
  const timestampMs = Number(timestamp) * (timestamp.length === 10 ? 1_000 : 1);
  if (!Number.isFinite(timestampMs)) return false;
  if (Math.abs((input.now ?? new Date()).getTime() - timestampMs) > MAX_CLOCK_SKEW_SECONDS * 1_000) {
    return false;
  }
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(input.publicKey, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(timestamp + input.body),
      key,
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

export function verifyHmacHex(actual: string | null, expected: string): boolean {
  if (!actual || !/^[0-9a-f]+$/i.test(actual) || !/^[0-9a-f]+$/i.test(expected)) return false;
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyGrafanaSignature(input: {
  body: string;
  signature: string | null;
  timestamp: string | null;
  secret: string;
  now?: Date;
}): boolean {
  if (!input.secret || !input.timestamp || !/^\d{10}$/.test(input.timestamp)) return false;
  const timestamp = Number(input.timestamp);
  const now = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_SECONDS) return false;
  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}:${input.body}`)
    .digest("hex");
  return verifyHmacHex(input.signature, expected);
}
