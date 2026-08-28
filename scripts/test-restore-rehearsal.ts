import assert from "node:assert/strict";

import { PrismaClient } from "@prisma/client";

import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import {
  ensureRestoredAppendOnlyTriggers,
  verifyRestoredControlPlane,
} from "@/lib/control-plane/restore-rehearsal";
import { REQUIRED_APPEND_ONLY_TRIGGERS } from "@/lib/control-plane/append-only-triggers";
import { activateConfigRevision } from "@/lib/control-plane/service";

const APP_ID = "restore-rehearsal-integration-app";
const REPO_ID = 9_999_971n;
const SOURCE_SHA = "6".repeat(40);
const SIGNING_KEY = "restore-rehearsal-integration-signing-key";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) {
  throw new Error("restore rehearsal integration fixture는 loopback MySQL에서만 허용한다");
}
if (!databaseUrl.pathname.slice(1).endsWith("_contract_test")) {
  throw new Error("restore rehearsal integration fixture DB 이름은 _contract_test로 끝나야 한다");
}

async function main(): Promise<void> {
  const client = new PrismaClient();
  const keepFixture = process.env.RESTORE_REHEARSAL_KEEP_FIXTURE === "LOCAL_CONTRACT_ONLY";
  const triggerEvidence = await ensureRestoredAppendOnlyTriggers({
    client,
    databaseUrl: databaseUrl.toString(),
  });
  assert.equal(triggerEvidence.mode, "PRESERVED_FROM_DUMP");
  assert.equal(triggerEvidence.verified, REQUIRED_APPEND_ONLY_TRIGGERS.length);
  await client.app.deleteMany({ where: { id: APP_ID } });
  try {
    const payload = { schemaVersion: 1, markets: [] };
    await client.app.create({
      data: {
        id: APP_ID,
        slug: "restore-rehearsal-integration",
        displayName: "Restore Rehearsal Integration",
        repoFullName: "seorilabs/restore-rehearsal-integration",
        repoId: REPO_ID,
        type: "APP",
        engine: "RN",
        status: "ACTIVE",
        marketTargets: [],
      },
    });
    await client.discoveryObservation.create({
      data: {
        appId: APP_ID,
        sourceSha: SOURCE_SHA,
        sourceRef: "refs/heads/main",
        workflowProfile: "react-native",
        workflowPackageManager: "pnpm",
        workflowWorkingDirectory: ".",
        payload: {},
        payloadHash: jsonDigest({}),
        requestHash: jsonDigest({ scope: "restore-rehearsal" } as JsonValue),
        idempotencyKey: "restore-rehearsal-integration-discovery",
        observedBy: "integration-worker",
        observedAt: new Date("2026-08-28T03:00:00.000Z"),
      },
    });
    await client.configRevision.create({
      data: {
        appId: APP_ID,
        revision: 1,
        status: "DRAFT",
        payload,
        payloadHash: jsonDigest(payload as JsonValue),
        createdBy: "integration-human",
        idempotencyKey: "restore-rehearsal-integration-config",
      },
    });
    await activateConfigRevision({
      repoId: REPO_ID,
      revision: 1,
      expectedActiveRevision: 0,
      actor: "integration-human",
      idempotencyKey: "restore-rehearsal-integration-activate",
      signingKey: SIGNING_KEY,
    });
    const result = await verifyRestoredControlPlane({ client, signingKey: SIGNING_KEY });
    assert.equal(result.activeSnapshotCount, 1);
    assert.equal(result.resolvedManifestCount, 1);
    assert.equal(result.invalidSignatureRejected, true);
    assert.equal(result.draftRejected, true);
    assert.match(result.manifestDigest, /^[0-9a-f]{64}$/);
    assert.match(result.evidenceDigest, /^[0-9a-f]{64}$/);
  } finally {
    if (!keepFixture) {
      await client.app.deleteMany({ where: { id: APP_ID } });
      await client.auditLog.deleteMany({
        where: { actorLogin: { in: ["integration-human", "integration-worker"] } },
      });
    }
    await client.$disconnect();
  }
  console.log("restore rehearsal control-plane integration 계약 통과");
}

main().catch((error: unknown) => {
  console.error("restore rehearsal integration 실패:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
