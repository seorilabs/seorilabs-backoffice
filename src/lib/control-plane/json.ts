import crypto from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function normalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("JSON에는 유한한 숫자만 사용할 수 있습니다.");
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(normalize(value));
}

export function jsonDigest(value: JsonValue): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function signSnapshot(value: JsonValue, signingKey: string): {
  digest: string;
  signature: string;
} {
  if (!signingKey) throw new Error("CONTROL_PLANE_SNAPSHOT_SIGNING_KEY가 필요합니다.");
  const encoded = canonicalJson(value);
  return {
    digest: crypto.createHash("sha256").update(encoded).digest("hex"),
    signature: crypto.createHmac("sha256", signingKey).update(encoded).digest("hex"),
  };
}

export function verifySnapshot(
  value: JsonValue,
  signingKey: string,
  expectedDigest: string | null,
  expectedSignature: string | null,
): boolean {
  if (!signingKey || !expectedDigest || !expectedSignature) return false;
  const actual = signSnapshot(value, signingKey);
  if (expectedDigest.length !== actual.digest.length || expectedSignature.length !== actual.signature.length) {
    return false;
  }
  const digestMatches = crypto.timingSafeEqual(Buffer.from(actual.digest), Buffer.from(expectedDigest));
  const signatureMatches = crypto.timingSafeEqual(Buffer.from(actual.signature), Buffer.from(expectedSignature));
  return digestMatches && signatureMatches;
}
