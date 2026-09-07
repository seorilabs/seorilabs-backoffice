import assert from "node:assert/strict";
import test from "node:test";

import { fleetMigrationPublicError } from "@/lib/control-plane/fleet-migration-public-error";

const FALLBACK = "FLEET_MIGRATION_RUNTIME_CAPABILITY_ISSUANCE_FAILED";

test("scoped GitHub capability code는 그대로 공개된다", () => {
  const codes = [
    "FLEET_GITHUB_CAPABILITY_UNSUPPORTED",
    "FLEET_GITHUB_EXECUTION_ID_INVALID",
    "FLEET_GITHUB_INSTALLATION_ID_INVALID",
    "FLEET_GITHUB_INSTALLATION_IDENTITY_INVALID",
    "FLEET_GITHUB_REPOSITORY_ID_INVALID",
    "FLEET_GITHUB_REPOSITORY_IDENTITY_MISMATCH",
    "FLEET_GITHUB_REPOSITORY_INVALID",
    "FLEET_GITHUB_TOKEN_PERMISSION_MISMATCH",
    "FLEET_GITHUB_TOKEN_REVOKE_FAILED",
    "FLEET_GITHUB_TOKEN_SCOPE_MISMATCH",
  ];
  for (const code of codes) {
    assert.equal(fleetMigrationPublicError(new Error(code), FALLBACK), code);
  }
});

test("기존에 공개하던 세 계열은 그대로 유지된다", () => {
  for (const code of [
    "FLEET_MIGRATION_RUNTIME_SNAPSHOT_INVALID",
    "GITHUB_APP_INSTALLATION_MISSING",
    "REPOSITORY_BACKFILL_VECTOR_INVALID",
  ]) {
    assert.equal(fleetMigrationPublicError(new Error(code), FALLBACK), code);
  }
});

test("실제로 쓰이는 두 접미사 형태가 공개된다", () => {
  // readiness 차단 사유 digest. 종전 패턴은 소문자를 받지 않아 이게 통째로 가려졌다.
  const digest = "0".repeat(32) + "abcdef0123456789abcdef0123456789";
  assert.equal(
    fleetMigrationPublicError(new Error(`FLEET_MIGRATION_SHADOW_READINESS_BLOCKED:${digest}`), FALLBACK),
    `FLEET_MIGRATION_SHADOW_READINESS_BLOCKED:${digest}`,
  );
  assert.equal(
    fleetMigrationPublicError(new Error("FLEET_MIGRATION_KUBERNETES_REQUEST_FAILED:404"), FALLBACK),
    "FLEET_MIGRATION_KUBERNETES_REQUEST_FAILED:404",
  );
});

test("hex가 아닌 접미사는 덮인다", () => {
  for (const message of [
    "FLEET_MIGRATION_SHADOW_READINESS_BLOCKED:/var/run/secrets/token",
    "FLEET_MIGRATION_SHADOW_READINESS_BLOCKED:ghs_exampletokenvalue",
    "FLEET_MIGRATION_X:aa:bb",
    `FLEET_MIGRATION_X:${"a".repeat(65)}`,
  ]) {
    assert.equal(fleetMigrationPublicError(new Error(message), FALLBACK), FALLBACK, message);
  }
});

test("code 형식이 아닌 message는 fallback으로 덮인다", () => {
  const leaky = [
    "connect ECONNREFUSED 10.152.183.1:443",
    "Cannot read properties of undefined (reading 'token')",
    "PrismaClientKnownRequestError: Invalid `prisma.app.findMany()` invocation",
    "Bad credentials - https://docs.github.com/rest",
    "FLEET_GITHUB_TOKEN_SCOPE_MISMATCH: ghs_exampletokenvalue",
    "prefix FLEET_MIGRATION_X",
    "fleet_github_token_scope_mismatch",
    "",
  ];
  for (const message of leaky) {
    assert.equal(
      fleetMigrationPublicError(new Error(message), FALLBACK),
      FALLBACK,
      `누출 후보가 그대로 나갔다: ${message}`,
    );
  }
});

test("Error가 아닌 값도 fallback으로 덮인다", () => {
  for (const value of ["FLEET_GITHUB_TOKEN_SCOPE_MISMATCH", 42, null, undefined, { message: "FLEET_GITHUB_X" }]) {
    assert.equal(fleetMigrationPublicError(value, FALLBACK), FALLBACK);
  }
});

test("fallback 문구는 caller가 정한다", () => {
  assert.equal(
    fleetMigrationPublicError(new Error("boom"), "FLEET_MIGRATION_BOOTSTRAP_SHADOW_FAILED"),
    "FLEET_MIGRATION_BOOTSTRAP_SHADOW_FAILED",
  );
});
