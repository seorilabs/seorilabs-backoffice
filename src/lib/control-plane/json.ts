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

/**
 * WorkflowBundle v5 계약의 정규화(`recursive-key-sort-json-utf8-no-newline`)다.
 * 중앙 구현이 기본 `Array.prototype.sort`(UTF-16 code unit)를 쓰므로 여기서도 같은 순서를
 * 써야 digest와 서명이 바이트까지 일치한다. `canonicalJson`의 `localeCompare`는 ICU 데이터에
 * 따라 결과가 달라져(`buildProfile`과 `builderImage`의 순서가 뒤집힌다) 이 용도에 쓸 수 없다.
 * 기존 서명·해시 데이터를 바꾸지 않기 위해 `canonicalJson`은 그대로 둔다.
 */
export function contractCanonicalJson(value: JsonValue): string {
  const sortByCodeUnit = (nested: JsonValue): JsonValue => {
    if (Array.isArray(nested)) return nested.map(sortByCodeUnit);
    if (nested && typeof nested === "object") {
      return Object.fromEntries(
        Object.keys(nested).sort().map((key) => [key, sortByCodeUnit(nested[key]!)]),
      );
    }
    if (typeof nested === "number" && !Number.isFinite(nested)) {
      throw new Error("JSON에는 유한한 숫자만 사용할 수 있습니다.");
    }
    return nested;
  };
  return JSON.stringify(sortByCodeUnit(value));
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
