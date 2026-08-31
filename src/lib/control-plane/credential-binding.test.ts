import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  credentialBindingImportSchema,
  type CredentialBindingImport,
} from "@/lib/control-plane/contracts";
import {
  decideCredentialBindingWrite,
  normalizeCredentialBindingImport,
} from "@/lib/control-plane/credential-binding";
import { ControlPlaneError } from "@/lib/control-plane/service";

function request(): CredentialBindingImport {
  return credentialBindingImportSchema.parse({
    schemaVersion: 1,
    repoId: "1265192029",
    expectedRevision: 0,
    binding: {
      logicalCredentialId: "shared/gcp/provisioner-session",
      provider: "gcp",
      capability: "gcp-project-provision",
      environment: "production",
      publicIdentity: "serviceAccount:provisioner@seorilabs-ci.iam.gserviceaccount.com",
      fingerprint: "A".repeat(64),
      consumer: "seorilabs/lizard-tycoon",
      scope: ["projects/lizard-tycoon", "organizations/123456789"],
      status: "ACTIVE",
      credentialGeneration: 3,
      policyGeneration: 7,
      adapterId: "gcp-provisioner-v1",
      origin: "https://cloudresourcemanager.googleapis.com",
      authFactors: ["oidc"],
    },
    provenance: {
      catalogEntryDigest: "b".repeat(64),
      catalogSnapshotDigest: "c".repeat(64),
      catalogContractVersion: "credential-catalog-v1",
      observedAt: "2026-08-31T05:00:00.000Z",
    },
  });
}

function current(desired = normalizeCredentialBindingImport(request())) {
  return {
    id: "binding-1",
    revision: 1,
    logicalCredentialId: desired.binding.logicalCredentialId,
    provider: desired.binding.provider,
    capability: desired.binding.capability,
    environment: desired.binding.environment,
    publicIdentity: desired.binding.publicIdentity,
    fingerprint: desired.binding.fingerprint,
    consumer: desired.binding.consumer,
    scope: desired.binding.scope,
    status: desired.binding.status,
    credentialGeneration: desired.binding.credentialGeneration,
    policyGeneration: desired.binding.policyGeneration,
    adapterId: desired.binding.adapterId,
    origin: desired.binding.origin,
    authFactors: desired.binding.authFactors,
    observedAt: desired.provenance.observedAt,
    catalogEntryDigest: desired.provenance.catalogEntryDigest,
    catalogSnapshotDigest: desired.provenance.catalogSnapshotDigest,
    catalogContractVersion: desired.provenance.catalogContractVersion,
    observedBy: "catalog-importer",
    createdAt: new Date("2026-08-31T05:00:01.000Z"),
    updatedAt: new Date("2026-08-31T05:00:01.000Z"),
  };
}

test("CredentialBinding import는 공개 catalog projection만 허용한다", () => {
  const valid = request();
  assert.equal(valid.repoId, 1265192029n);
  assert.equal(normalizeCredentialBindingImport(valid).binding.fingerprint, `sha256:${"a".repeat(64)}`);

  const raw = {
    ...valid,
    repoId: valid.repoId.toString(),
    provenance: { ...valid.provenance, observedAt: valid.provenance.observedAt.toISOString() },
  };
  assert.equal(credentialBindingImportSchema.safeParse({ ...raw, password: "never" }).success, false);
  assert.equal(credentialBindingImportSchema.safeParse({
    ...raw,
    binding: { ...raw.binding, publicIdentity: "api_key=not-public-credential-value" },
  }).success, false);
  assert.equal(credentialBindingImportSchema.safeParse({
    ...raw,
    binding: { ...raw.binding, origin: "https://cloudresourcemanager.googleapis.com/login" },
  }).success, false);
  assert.equal(credentialBindingImportSchema.safeParse({
    ...raw,
    binding: { ...raw.binding, scope: ["projects/lizard-tycoon", "projects/lizard-tycoon"] },
  }).success, false);
});

test("CredentialBinding은 expectedRevision과 generation으로 fail-closed 갱신한다", () => {
  const desired = normalizeCredentialBindingImport(request());
  assert.equal(decideCredentialBindingWrite({ current: null, desired }), "CREATE");

  const stored = current(desired);
  assert.equal(decideCredentialBindingWrite({
    current: stored,
    desired: { ...desired, expectedRevision: 1 },
  }), "UNCHANGED");
  assert.throws(
    () => decideCredentialBindingWrite({ current: stored, desired }),
    (error) => error instanceof ControlPlaneError
      && error.code === "CREDENTIAL_BINDING_REVISION_CONFLICT",
  );

  const metadataDrift = {
    ...desired,
    expectedRevision: 1,
    binding: { ...desired.binding, adapterId: "gcp-provisioner-v2" },
  };
  assert.throws(
    () => decideCredentialBindingWrite({ current: stored, desired: metadataDrift }),
    (error) => error instanceof ControlPlaneError
      && error.code === "CREDENTIAL_BINDING_GENERATION_NOT_ADVANCED",
  );
  assert.equal(decideCredentialBindingWrite({
    current: stored,
    desired: {
      ...metadataDrift,
      binding: { ...metadataDrift.binding, policyGeneration: 8 },
    },
  }), "UPDATE");
});

test("새 catalog snapshot 관측은 실행 metadata를 바꾸지 않고 revision만 전진할 수 있다", () => {
  const desired = normalizeCredentialBindingImport(request());
  const stored = current(desired);
  assert.equal(decideCredentialBindingWrite({
    current: stored,
    desired: {
      ...desired,
      expectedRevision: 1,
      provenance: {
        ...desired.provenance,
        catalogSnapshotDigest: "d".repeat(64),
        observedAt: new Date(desired.provenance.observedAt.getTime() + 60_000),
      },
    },
  }), "UPDATE");
  assert.throws(
    () => decideCredentialBindingWrite({
      current: stored,
      desired: {
        ...desired,
        expectedRevision: 1,
        provenance: {
          ...desired.provenance,
          observedAt: new Date(desired.provenance.observedAt.getTime() - 1),
        },
      },
    }),
    (error) => error instanceof ControlPlaneError
      && error.code === "CREDENTIAL_BINDING_OBSERVATION_STALE",
  );
  assert.throws(
    () => decideCredentialBindingWrite({
      current: stored,
      desired: {
        ...desired,
        expectedRevision: 1,
        binding: { ...desired.binding, credentialGeneration: 2 },
      },
    }),
    (error) => error instanceof ControlPlaneError
      && error.code === "CREDENTIAL_BINDING_GENERATION_REGRESSION",
  );

  assert.throws(
    () => decideCredentialBindingWrite({
      current: { ...stored, revision: null },
      desired: { ...desired, expectedRevision: 0 },
    }),
    (error) => error instanceof ControlPlaneError
      && error.code === "CREDENTIAL_BINDING_PROVENANCE_UNVERIFIED",
  );
});

test("CredentialBinding API는 public read/import만 제공하고 mutation 원장과 audit를 같은 transaction에 묶는다", () => {
  const route = readFileSync(
    join(process.cwd(), "src/app/api/control-plane/credential-bindings/route.ts"),
    "utf8",
  );
  const service = readFileSync(
    join(process.cwd(), "src/lib/control-plane/credential-binding.ts"),
    "utf8",
  );
  const migration = readFileSync(
    join(process.cwd(), "prisma/migrations/20260831150000_credential_binding_catalog_import/migration.sql"),
    "utf8",
  );
  assert.match(route, /authenticateInternalRequest\(request, "control-plane"\)/);
  assert.match(route, /requireIdempotencyKey/);
  assert.doesNotMatch(route, /get-secret|print-secret|copy-password|leaseToken/);
  assert.match(service, /Prisma\.TransactionIsolationLevel\.Serializable/);
  assert.match(service, /automationMutationRequest\.updateMany/);
  assert.match(service, /auditLog\.create/);
  assert.match(service, /revision: \{ increment: 1 \}/);
  assert.doesNotMatch(migration, /\b(?:DROP|MODIFY|CHANGE|TRUNCATE|RENAME)\b/i);
});
