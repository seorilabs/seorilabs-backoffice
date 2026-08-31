import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import {
  findApplicableLegacyConfigResolution,
  recordLegacyConfigResolution,
} from "@/lib/control-plane/legacy-config-resolution-service";
import { legacyResolutionReasonCodesDigest } from "@/lib/control-plane/legacy-config-resolution";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { ControlPlaneError } from "@/lib/control-plane/service";

const FIXTURE_SUFFIX = randomUUID();
const APP_ID = `legacy-resolution-integration-${FIXTURE_SUFFIX}`;
const REPO_ID = BigInt(8_000_000_000 + randomInt(1_000_000));
const SOURCE_SHA = "7".repeat(40);
const INPUT_DIGEST = "8".repeat(64);
const CONFIG_ID = `legacy-resolution-config-${FIXTURE_SUFFIX}`;
const IMPORT_ID = `legacy-resolution-import-${FIXTURE_SUFFIX}`;
const REASON_CODES = ["SECRET_LIKE_KEY"] as const;
const REASON_CODES_DIGEST = legacyResolutionReasonCodesDigest(REASON_CODES);

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("legacy resolution integration fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("legacy resolution integration fixture DB 이름은 _contract_test로 끝나야 한다");
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const payload = { schemaVersion: 1, markets: [] };
    await prisma.app.create({
      data: {
        id: APP_ID,
        slug: `legacy-resolution-${FIXTURE_SUFFIX}`,
        displayName: "Legacy Resolution Integration",
        repoFullName: `seorilabs/legacy-resolution-${FIXTURE_SUFFIX}`,
        repoId: REPO_ID,
        type: "APP",
        engine: "RN",
        marketTargets: [],
      },
    });
    await prisma.configRevision.create({
      data: {
        id: CONFIG_ID,
        appId: APP_ID,
        revision: 1,
        status: "ACTIVE",
        activeSlot: APP_ID,
        payload,
        payloadHash: jsonDigest(payload as JsonValue),
        createdBy: "integration-human",
        idempotencyKey: `legacy-resolution-config:${FIXTURE_SUFFIX}`,
      },
    });
    await prisma.legacyConfigImport.create({
      data: {
        id: IMPORT_ID,
        appId: APP_ID,
        sourceSha: SOURCE_SHA,
        sourceRef: "refs/heads/main",
        transformVersion: "legacy-config-v1",
        requestHash: "1".repeat(64),
        inputDigest: INPUT_DIGEST,
        reasonCodes: [...REASON_CODES],
        reasonCodesDigest: REASON_CODES_DIGEST,
        status: "DRAFT_CREATED_WITH_INPUT",
        idempotencyKey: jsonDigest({ fixture: FIXTURE_SUFFIX, kind: "legacy-import" } as JsonValue),
        observedBy: "integration-worker",
        observedAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    const credential = await prisma.credentialBinding.create({
      data: {
        appId: APP_ID,
        logicalCredentialId: `app/test/reviewer-login/${FIXTURE_SUFFIX}`,
        provider: "apple",
        capability: "review-login",
        environment: "production",
        publicIdentity: "reviewer@example.invalid",
        fingerprint: "3".repeat(64),
        consumer: "legacy-resolution-integration",
        status: "ACTIVE",
        observedAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });

    const request = {
      schemaVersion: 1 as const,
      repoId: REPO_ID,
      legacyImportId: IMPORT_ID,
      expectedResolutionRevision: 0,
      expectedActiveConfigRevision: 1,
      dispositions: [{ reasonCode: "SECRET_LIKE_KEY" as const, targets: ["CREDENTIAL_BINDING" as const] }],
      justification: "CENTRAL_STATE_REVIEWED" as const,
    };
    const first = await recordLegacyConfigResolution({
      request,
      actor: "integration-human",
      approvalKind: "HUMAN",
      idempotencyKey: `legacy-resolution-first:${FIXTURE_SUFFIX}`,
    });
    assert.equal(first.duplicate, false);
    assert.equal(first.resolution.revision, 1);
    assert.deepEqual(first.resolution.reasonCodes, [...REASON_CODES]);
    assert.doesNotMatch(JSON.stringify(first), /password|credentialValue|rawContent/i);

    const replay = await recordLegacyConfigResolution({
      request,
      actor: "integration-human",
      approvalKind: "HUMAN",
      idempotencyKey: `legacy-resolution-first:${FIXTURE_SUFFIX}`,
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.resolution.id, first.resolution.id);

    const applicable = await prisma.$transaction((tx) => findApplicableLegacyConfigResolution(tx, {
      appId: APP_ID,
      sourceSha: SOURCE_SHA,
      transformVersion: "legacy-config-v1",
      inputDigest: INPUT_DIGEST,
      reasonCodesDigest: REASON_CODES_DIGEST,
      configRevisionId: CONFIG_ID,
    }));
    assert.equal(applicable.resolution?.id, first.resolution.id);

    // 승인에 연결되지 않은 provider readback은 credential-only resolution을 무효화하지 않는다.
    await prisma.providerObservation.create({
      data: {
        appId: APP_ID,
        provider: "google-play",
        resourceType: "track",
        resourceId: "internal",
        payload: { status: "active" },
        payloadHash: jsonDigest({ status: "active" } as JsonValue),
        idempotencyKey: `legacy-resolution-provider:${FIXTURE_SUFFIX}`,
        observedBy: "integration-worker",
        observedAt: new Date("2026-09-01T00:01:00.000Z"),
      },
    });
    const afterUnrelatedReadback = await prisma.$transaction((tx) => findApplicableLegacyConfigResolution(tx, {
      appId: APP_ID,
      sourceSha: SOURCE_SHA,
      transformVersion: "legacy-config-v1",
      inputDigest: INPUT_DIGEST,
      reasonCodesDigest: REASON_CODES_DIGEST,
      configRevisionId: CONFIG_ID,
    }));
    assert.equal(afterUnrelatedReadback.resolution?.id, first.resolution.id);

    // 실제로 연결된 credential 공개 상태가 바뀌면 exact digest 승인은 무효다.
    await prisma.credentialBinding.update({
      where: { id: credential.id },
      data: { fingerprint: "4".repeat(64) },
    });
    const afterCredentialDrift = await prisma.$transaction((tx) => findApplicableLegacyConfigResolution(tx, {
      appId: APP_ID,
      sourceSha: SOURCE_SHA,
      transformVersion: "legacy-config-v1",
      inputDigest: INPUT_DIGEST,
      reasonCodesDigest: REASON_CODES_DIGEST,
      configRevisionId: CONFIG_ID,
    }));
    assert.equal(afterCredentialDrift.resolution, null);

    await assert.rejects(
      recordLegacyConfigResolution({
        request: { ...request, expectedResolutionRevision: 1 },
        actor: "integration-worker",
        approvalKind: "AUTOMATION",
        idempotencyKey: `legacy-resolution-automation-rejected:${FIXTURE_SUFFIX}`,
      }),
      (error: unknown) => error instanceof ControlPlaneError
        && error.code === "LEGACY_RESOLUTION_HUMAN_APPROVAL_REQUIRED",
    );

    const audits = await prisma.auditLog.findMany({
      where: { entityType: "LegacyConfigResolution", entityId: first.resolution.id },
    });
    assert.equal(audits.length, 1);
    assert.doesNotMatch(JSON.stringify(audits), /password|credentialValue|rawContent/i);
    await assert.rejects(prisma.legacyConfigResolution.update({
      where: { id: first.resolution.id },
      data: { createdBy: "tampered" },
    }));
    await assert.rejects(prisma.legacyConfigResolution.delete({
      where: { id: first.resolution.id },
    }));
    console.log("legacy config resolution integration 계약 통과");
  } finally {
    // resolution 원장은 지우지 않는다. 대신 다른 통합 계약이 이 fixture를 운영 중
    // ACTIVE revision으로 읽지 않도록 가변 projection만 비활성화한다.
    await prisma.configRevision.updateMany({
      where: { id: CONFIG_ID },
      data: { status: "SUPERSEDED", activeSlot: null },
    });
    await prisma.app.updateMany({
      where: { id: APP_ID },
      data: { status: "PAUSED" },
    });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("legacy config resolution integration 실패:", error instanceof Error ? error.message : "unknown");
  process.exit(1);
});
