import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { legacyShadowImportRequestSchema } from "@/lib/control-plane/contracts";
import {
  hashLegacyShadowIdempotencyKey,
  legacyShadowRequestHash,
} from "@/lib/control-plane/legacy-shadow-request";

test("shadow import 요청은 exact SHA와 server-owned source vector만 받는다", () => {
  const valid = {
    repoId: "123",
    sourceSha: "a".repeat(40),
  };
  assert.deepEqual(legacyShadowImportRequestSchema.parse(valid), {
    ...valid,
    repoId: 123n,
  });
  assert.equal(legacyShadowImportRequestSchema.safeParse({
    ...valid,
    sourceSha: "main",
  }).success, false);
  assert.equal(legacyShadowImportRequestSchema.safeParse({
    ...valid,
    repoId: (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(),
  }).success, false);
  assert.equal(legacyShadowImportRequestSchema.safeParse({
    ...valid,
    sourceRef: "refs/heads/main",
  }).success, false);
  assert.equal(legacyShadowImportRequestSchema.safeParse({
    ...valid,
    sources: [{ path: "arbitrary.json", content: "never" }],
  }).success, false);
});

test("shadow import idempotency key는 원문 대신 scope hash로 저장한다", () => {
  const key = "request-visible-key-123";
  const digest = hashLegacyShadowIdempotencyKey(key);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(digest, new RegExp(key));
  assert.equal(digest, hashLegacyShadowIdempotencyKey(key));
  assert.notEqual(digest, hashLegacyShadowIdempotencyKey(`${key}-other`));
});

test("shadow import request hash는 actor와 exact SHA를 결합하고 source vector는 server-owned다", () => {
  const base = {
    repoId: 123n,
    sourceSha: "a".repeat(40),
    observedBy: "worker-1",
  };
  const hash = legacyShadowRequestHash(base);
  assert.notEqual(hash, legacyShadowRequestHash({ ...base, sourceSha: "b".repeat(40) }));
  assert.notEqual(hash, legacyShadowRequestHash({ ...base, observedBy: "worker-2" }));
});

test("shadow import 저장 경계에는 raw content나 secret export interface가 없다", () => {
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  const service = readFileSync(
    join(process.cwd(), "src/lib/control-plane/legacy-shadow-service.ts"),
    "utf8",
  );
  const importModel = schema.match(/model LegacyConfigImport \{[\s\S]*?\n\}/)?.[0] ?? "";
  const sourceModel = schema.match(/model LegacyConfigSource \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.doesNotMatch(importModel, /^\s*(content|rawContent|secret|password|credential)\s+/m);
  assert.doesNotMatch(sourceModel, /^\s*(content|rawContent|secret|password|credential)\s+/m);
  assert.match(service, /Import가 생성한 DRAFT 자체와 비교하면 tautological MATCH가 되므로 금지/);
  assert.match(service, /SOURCE_SHA_NOT_CURRENT/);
  assert.match(service, /\? \"DRAFT_CREATED\" : \"NEEDS_INPUT\"/);
  assert.match(service, /scope: FULL_PARITY_SCOPE/);
  assert.equal(existsSync(join(
    process.cwd(),
    "src/app/api/control-plane/legacy-shadow-imports/route.ts",
  )), false);
});
