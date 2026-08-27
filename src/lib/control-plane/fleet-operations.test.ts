import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  configRevisionPayloadSchema,
  humanOnlyConfigFields,
  reauthRequestSchema,
  trustedLocalPendingSchema,
} from "@/lib/control-plane/contracts";
import {
  assertConfigRevisionPayload,
  ControlPlaneError,
} from "@/lib/control-plane/service";
import { redactFleetError, redactFleetJson } from "@/lib/control-plane/fleet-view";

test("비민감 Config payload는 UI와 API 공용 validator를 통과한다", () => {
  const payload = {
    markets: { play: { locales: ["ko-KR", "en-US"] } },
    assets: { iconRevision: "2026-08-27" },
    policies: { minimumSdk: 35, taxonomy: "games", contractRevision: "v2" },
  };
  assert.deepEqual(configRevisionPayloadSchema.parse(payload), payload);
  assert.doesNotThrow(() => assertConfigRevisionPayload(payload));
});

test("중첩된 사람 전용 필드는 DRAFT 생성과 기존 DRAFT activation 모두 fail-closed한다", () => {
  const payload = {
    markets: [{ name: "play", publicReleaseApproval: true }],
    account: { ownershipVerification: "approved" },
    provider: { apiKeyRotation: true },
    store: { reviewSubmission: { enabled: true } },
  };
  assert.deepEqual(
    humanOnlyConfigFields(payload).map((finding) => finding.path),
    [
      "markets.0.publicReleaseApproval",
      "account.ownershipVerification",
      "provider.apiKeyRotation",
      "store.reviewSubmission",
    ],
  );
  const validation = configRevisionPayloadSchema.safeParse(payload);
  assert.equal(validation.success, false);
  if (!validation.success) {
    assert.equal(
      validation.error.issues.some((issue) =>
        issue.code === "custom"
        && issue.params?.controlPlaneCode === "HUMAN_APPROVAL_REQUIRED"),
      true,
    );
  }
  assert.throws(
    () => assertConfigRevisionPayload(payload),
    (error) => error instanceof ControlPlaneError
      && error.code === "HUMAN_APPROVAL_REQUIRED"
      && error.status === 403,
  );
});

test("ReauthRequest는 정확한 HTTPS origin과 공개 필드만 허용한다", () => {
  const valid = {
    repoId: "123",
    provider: "google-play",
    origin: "https://play.google.com",
    publicAccountId: "publisher-team-1",
    capability: "build.status.read",
    gate: "PASSKEY",
    reason: "사람 소유 MFA가 필요합니다.",
  };
  assert.equal(reauthRequestSchema.safeParse(valid).success, true);
  assert.equal(reauthRequestSchema.safeParse({ ...valid, origin: "http://play.google.com" }).success, false);
  assert.equal(reauthRequestSchema.safeParse({ ...valid, origin: "https://play.google.com/login" }).success, false);
  assert.equal(reauthRequestSchema.safeParse({ ...valid, password: "never" }).success, false);
  assert.equal(reauthRequestSchema.safeParse({ ...valid, totp: "000000" }).success, false);
  assert.equal(reauthRequestSchema.safeParse({ ...valid, cookie: "never" }).success, false);
});

test("trusted-local 대기 전환은 repo scope와 generation CAS를 요구한다", () => {
  assert.equal(trustedLocalPendingSchema.safeParse({
    repoId: "123",
    reauthRequestId: "reauth-1",
    expectedGeneration: 0,
  }).success, true);
  assert.equal(trustedLocalPendingSchema.safeParse({
    reauthRequestId: "reauth-1",
    expectedGeneration: 0,
  }).success, false);
  assert.equal(trustedLocalPendingSchema.safeParse({
    repoId: "123",
    reauthRequestId: "reauth-1",
    expectedGeneration: -1,
  }).success, false);
});

test("Fleet run 오류를 화면에 내보내기 전에 credential 후보를 제거한다", () => {
  const redacted = redactFleetError(
    "failed Bearer abc.def.ghi password=hunter2 totp:123456 cookie=session-value "
      + "a".repeat(90),
  );
  assert.doesNotMatch(redacted ?? "", /abc\.def|hunter2|123456|session-value/);
  assert.match(redacted ?? "", /\[REDACTED\]/);
  assert.deepEqual(redactFleetJson({
    publicAccountId: "team-1",
    nested: { apiKey: "never", note: "Bearer token-value" },
  }), {
    publicAccountId: "team-1",
    nested: { apiKey: "[REDACTED]", note: "Bearer [REDACTED]" },
  });
});

test("Prisma 모델과 UI에는 raw authentication secret 필드가 없다", () => {
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  const migration = readFileSync(
    join(process.cwd(), "prisma/migrations/36_fleet_operations_ui/migration.sql"),
    "utf8",
  );
  const editor = readFileSync(
    join(process.cwd(), "src/components/fleet/FleetConfigEditor.tsx"),
    "utf8",
  );
  const actions = readFileSync(
    join(process.cwd(), "src/lib/actions/fleet-control-plane.ts"),
    "utf8",
  );
  const reauthModel = schema.match(/model ReauthRequest \{[\s\S]*?\n\}/)?.[0] ?? "";
  const credentialModel = schema.match(/model CredentialBinding \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.doesNotMatch(reauthModel, /^\s*(password|totp|cookie|recoveryCode|secret)\s+/m);
  assert.doesNotMatch(credentialModel, /^\s*(value|secret|privateKey|password)\s+/m);
  assert.doesNotMatch(editor, /type=["']password["']/);
  assert.match(actions, /requirePlatformReadAccess\(\)/);
  assert.match(actions, /requirePlatformWriteAccess\(app\.slug\)/);
  assert.match(actions, /uiRequestIdSchema\.parse\(input\.requestId\)/);
  assert.doesNotMatch(actions, /randomUUID/);
  assert.match(migration, /UNIQUE INDEX `control_plane_reauth_request_idempotencyKey_key`/);
  assert.match(migration, /UNIQUE INDEX `control_plane_reauth_request_trustedLocalIdempotencyKey_key`/);
});
