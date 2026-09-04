import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

import { jsonDigest, type JsonValue, verifySnapshot } from "@/lib/control-plane/json";
import { createFleetMigrationKubernetesCapabilitySink } from "@/lib/control-plane/fleet-migration-kubernetes-capability-sink";
import {
  fleetMigrationAttestationDigest,
  signFleetMigrationPublicAttestation,
  verifyFleetMigrationPublicAttestation,
} from "@/lib/control-plane/fleet-migration-public-attestation";
import { parseFleetMigrationRuntimePayload } from "@/lib/control-plane/fleet-migration-runtime-capability";
import {
  evaluateFleetMigrationShadowReadiness,
  readFleetMigrationBackoffice,
} from "@/lib/control-plane/fleet-migration-shadow-readiness";
import {
  listInstallationRepositorySeeds,
  readInstalledRepositoryVector,
} from "@/lib/control-plane/repository-discovery-backfill";
import { readBoundSecretFile } from "@/lib/control-plane/seori-auth-agent-transport";
import {
  getFleetScopedGithubTokenIssuer,
  getInstallationContext,
  readFleetGitHubAppPublicSource,
} from "@/lib/github/app";
import { issueFleetMigrationGithubCapabilityToSink } from "@/lib/github/scoped-installation-client";
import { prisma } from "@/lib/prisma";

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const DNS = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]{1,512}$/u;
const RELATIVE_PATH = /^[A-Za-z0-9._/-]{1,191}$/u;
const APP_ID = "4124446";
const ORGANIZATION_ID = "283115031";
const INSTALLATION_ID = "142120077";

function required(name: string, pattern: RegExp): string {
  const value = process.env[name]?.trim() ?? "";
  if (!pattern.test(value)) throw new Error(`FLEET_MIGRATION_${name}_INVALID`);
  return value;
}

function requiredPort(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`FLEET_MIGRATION_${name}_INVALID`);
  }
  return value;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^FLEET_MIGRATION_[A-Z0-9_:,-]+$/u.test(message)
    ? message
    : /^GITHUB_APP_[A-Z0-9_]+$/u.test(message)
      ? message
      : /^REPOSITORY_BACKFILL_[A-Z0-9_]+$/u.test(message)
        ? message
        : "FLEET_MIGRATION_RUNTIME_CAPABILITY_ISSUANCE_FAILED";
}

async function main(): Promise<void> {
  const sourceSha = required("BACKOFFICE_SOURCE_SHA", SHA);
  const detectorSourceSha = required("FLEET_MIGRATION_DETECTOR_SOURCE_SHA", SHA);
  const executionId = required("FLEET_MIGRATION_EXECUTION_ID", ID);
  const keyId = required("FLEET_MIGRATION_RUNTIME_ATTESTATION_KEY_ID", ID);
  const keyFingerprint = required("FLEET_MIGRATION_RUNTIME_ATTESTATION_KEY_FINGERPRINT", SHA256);
  const policyRevision = required("FLEET_MIGRATION_RUNTIME_ATTESTATION_POLICY_REVISION", ID);
  const snapshotSigningKeyId = required("CONTROL_PLANE_SNAPSHOT_SIGNING_KEY_ID", ID);
  const snapshotPolicyRevision = required("CONTROL_PLANE_SNAPSHOT_SIGNATURE_POLICY_REVISION", ID);
  const snapshotSigningKey = process.env.CONTROL_PLANE_SNAPSHOT_SIGNING_KEY ?? "";
  if (snapshotSigningKey.length < 32 || snapshotSigningKey.length > 4096) {
    throw new Error("FLEET_MIGRATION_CONTROL_PLANE_SNAPSHOT_SIGNING_KEY_INVALID");
  }

  let runtimePrivateKeyBytes: Buffer | undefined;
  let runtimePublicKeyBytes: Buffer | undefined;
  try {
    const runtimeKeyRoot = required("FLEET_MIGRATION_RUNTIME_SIGNING_ROOT", ABSOLUTE_PATH);
    [runtimePrivateKeyBytes, runtimePublicKeyBytes] = await Promise.all([
      readBoundSecretFile({
        root: runtimeKeyRoot,
        relativePath: required("FLEET_MIGRATION_RUNTIME_SIGNING_PRIVATE_KEY_FILE", RELATIVE_PATH),
        allowGroupRead: true,
        maxBytes: 64 * 1024,
      }),
      readBoundSecretFile({
        root: runtimeKeyRoot,
        relativePath: required("FLEET_MIGRATION_RUNTIME_SIGNING_PUBLIC_KEY_FILE", RELATIVE_PATH),
        allowGroupRead: true,
        maxBytes: 64 * 1024,
      }),
    ]);
    const privateKey = createPrivateKey(runtimePrivateKeyBytes);
    const publicKey = createPublicKey(runtimePublicKeyBytes);
    if (
      privateKey.asymmetricKeyType !== "ed25519"
      || publicKey.asymmetricKeyType !== "ed25519"
      || !createPublicKey(privateKey).equals(publicKey)
      || sha256(publicKey.export({ type: "spki", format: "der" })) !== keyFingerprint
    ) throw new Error("FLEET_MIGRATION_RUNTIME_SIGNING_IDENTITY_INVALID");

    const context = await getInstallationContext({ forceRefresh: true });
    const publicIdentity = {
      appId: context.publicState.appId,
      installationId: context.publicState.installationId,
      targetId: context.publicState.targetId,
      accountLogin: context.publicState.accountLogin,
      targetType: context.publicState.targetType,
      repositorySelection: context.publicState.repositorySelection,
      suspended: context.publicState.suspended,
    };
    if (
      publicIdentity.appId !== APP_ID
      || publicIdentity.installationId !== INSTALLATION_ID
      || publicIdentity.targetId !== ORGANIZATION_ID
      || publicIdentity.accountLogin !== "seorilabs"
      || publicIdentity.targetType !== "Organization"
      || publicIdentity.repositorySelection !== "all"
      || publicIdentity.suspended
    ) throw new Error("FLEET_MIGRATION_RUNTIME_GITHUB_IDENTITY_INVALID");
    const readiness = await evaluateFleetMigrationShadowReadiness({
      getInstallationContext: async () => ({ client: context.octokit, publicIdentity }),
      listRepositories: (client) => listInstallationRepositorySeeds(client),
      readRepository: readInstalledRepositoryVector,
      readBackoffice: (repositoryIds) => readFleetMigrationBackoffice(repositoryIds),
      verifyConfigSnapshot: ({ snapshot, digest, signature }) => verifySnapshot(
        snapshot,
        snapshotSigningKey,
        digest,
        signature,
      ),
      now: () => new Date(),
    });
    if (readiness.state !== "READY") {
      const reasonDigest = jsonDigest(readiness.reasonCounts as unknown as JsonValue);
      throw new Error(`FLEET_MIGRATION_SHADOW_READINESS_BLOCKED:${reasonDigest}`);
    }
    const repositories = readiness.repositories.map((repository) => ({
      id: repository.repoId,
      fullName: repository.repoFullName,
    }));
    if (repositories.length < 1) throw new Error("FLEET_MIGRATION_RUNTIME_COHORT_INVALID");
    const backoffice = await readFleetMigrationBackoffice(
      repositories.map(({ id }) => BigInt(id)),
    );
    const currentSources = new Map(readiness.repositories.map((repository) => [
      repository.repoId,
      repository.sourceSha,
    ]));
    const configSnapshots = backoffice.apps.map((app) => {
      const config = app.activeConfigs[0];
      const sourceSha = currentSources.get(app.repoId);
      if (
        app.activeConfigs.length !== 1
        || !config
        || typeof sourceSha !== "string"
        || !SHA.test(sourceSha)
        || !config.snapshotDigest
        || !config.snapshotSignature
        || config.activatedSnapshot === null
        || !verifySnapshot(
          config.activatedSnapshot,
          snapshotSigningKey,
          config.snapshotDigest,
          config.snapshotSignature,
        )
      ) throw new Error("FLEET_MIGRATION_RUNTIME_SNAPSHOT_INVALID");
      return {
        repositoryId: app.repoId,
        appId: app.id,
        configRevisionId: config.id,
        sourceSha,
        snapshotDigest: config.snapshotDigest,
        snapshotSignatureDigest: sha256(config.snapshotSignature),
      };
    }).sort((left, right) => {
      const leftId = BigInt(left.repositoryId);
      const rightId = BigInt(right.repositoryId);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    const proofs = await prisma.fleetMigrationProofSnapshot.findMany({
      where: {
        detectorSourceSha,
        readinessEvidenceDigest: readiness.evidenceDigest,
        readinessCohortDigest: readiness.cohortDigest,
      },
      orderBy: [{ repositoryId: "asc" }, { observedAt: "desc" }, { id: "desc" }],
      take: 501,
      select: {
        repositoryId: true,
        repositoryFullName: true,
        sourceSha: true,
        proofDigest: true,
      },
    });
    if (proofs.length > 500) throw new Error("FLEET_MIGRATION_RUNTIME_PROOF_LIMIT_EXCEEDED");
    const cohort = new Map(readiness.repositories.map((repository) => [repository.repoId, repository]));
    const approvedProofDigests = [...new Set(proofs.map((proof) => {
      const repository = cohort.get(proof.repositoryId.toString());
      if (
        !repository
        || repository.repoFullName !== proof.repositoryFullName
        || repository.sourceSha !== proof.sourceSha
        || !SHA256.test(proof.proofDigest)
      ) throw new Error("FLEET_MIGRATION_RUNTIME_PROOF_BINDING_INVALID");
      return proof.proofDigest;
    }))].sort();
    const [publicSource, webhookAcceptance, scoped] = await Promise.all([
      readFleetGitHubAppPublicSource(),
      prisma.webhookDelivery.findFirst({
        where: { event: "repository" },
        orderBy: { receivedAt: "desc" },
        select: { deliveryId: true, receivedAt: true },
      }),
      getFleetScopedGithubTokenIssuer(),
    ]);
    if (!webhookAcceptance) throw new Error("FLEET_MIGRATION_RUNTIME_WEBHOOK_ACCEPTANCE_MISSING");
    if (
      scoped.installationId !== INSTALLATION_ID
      || publicSource.app.id !== APP_ID
      || publicSource.app.ownerId !== ORGANIZATION_ID
      || publicSource.app.ownerLogin !== "seorilabs"
      || publicSource.installation.appId !== APP_ID
      || publicSource.installation.installationId !== INSTALLATION_ID
      || publicSource.installation.targetId !== ORGANIZATION_ID
      || publicSource.installation.accountLogin !== "seorilabs"
    ) throw new Error("FLEET_MIGRATION_RUNTIME_GITHUB_IDENTITY_INVALID");
    const sink = createFleetMigrationKubernetesCapabilitySink({
      namespace: required("FLEET_MIGRATION_RUNTIME_NAMESPACE", DNS),
      secretName: required("FLEET_MIGRATION_GITHUB_TOKEN_SECRET", DNS),
      configMapName: required("FLEET_MIGRATION_RUNTIME_CONFIG_MAP", DNS),
      executionId,
      sourceSha,
      authRoot: required("FLEET_MIGRATION_KUBERNETES_AUTH_ROOT", ABSOLUTE_PATH),
      tokenFile: required("FLEET_MIGRATION_KUBERNETES_TOKEN_FILE", RELATIVE_PATH),
      caFile: required("FLEET_MIGRATION_KUBERNETES_CA_FILE", RELATIVE_PATH),
      host: required("KUBERNETES_SERVICE_HOST", /^(?:[1-9][0-9]{0,2}\.){3}[1-9][0-9]{0,2}$/u),
      port: requiredPort("KUBERNETES_SERVICE_PORT_HTTPS"),
    });
    let attestationDigest = "";
    let expiresAt = "";
    const receipt = await issueFleetMigrationGithubCapabilityToSink({
      issuer: scoped.issuer,
      installationId: scoped.installationId,
      executionId,
      repositories: repositories as [typeof repositories[number], ...Array<typeof repositories[number]>],
      deliver: async ({ token, receipt: github }) => {
        const issuedAt = new Date().toISOString();
        const payload = parseFleetMigrationRuntimePayload({
          schemaVersion: 1,
          contract: "seorilabs-fleet-migration-shadow-runtime-capability-v1",
          executionId,
          organizationId: ORGANIZATION_ID,
          installationId: INSTALLATION_ID,
          backofficeSourceSha: sourceSha,
          detectorSourceSha,
          readinessEvidenceDigest: readiness.evidenceDigest,
          readinessCohortDigest: readiness.cohortDigest,
          snapshotSigningKeyId,
          snapshotPolicyRevision,
          approvedProofDigests,
          github: {
            tokenSha256: github.tokenSha256,
            tokenExpiresAt: github.tokenExpiresAt,
            permissions: github.permissions,
            repositories: github.repositories,
            publicSource,
            webhookAcceptance: {
              deliveryId: webhookAcceptance.deliveryId,
              acceptedAt: webhookAcceptance.receivedAt.toISOString(),
            },
          },
          configSnapshots,
        });
        const attestation = signFleetMigrationPublicAttestation({
          privateKey,
          purpose: "SHADOW_RUNTIME",
          keyId,
          policyRevision,
          issuedAt,
          expiresAt: github.tokenExpiresAt,
          nonce: `fleet-runtime-${sha256(`${executionId}:${issuedAt}`).slice(0, 32)}`,
          payload: payload as unknown as Record<string, JsonValue>,
        });
        if (attestation.keyFingerprint !== keyFingerprint) {
          throw new Error("FLEET_MIGRATION_RUNTIME_SIGNING_IDENTITY_INVALID");
        }
        verifyFleetMigrationPublicAttestation({
          value: attestation,
          publicKey,
          purpose: "SHADOW_RUNTIME",
          expectedKeyId: keyId,
          expectedKeyFingerprint: keyFingerprint,
          expectedPolicyRevision: policyRevision,
          maxTtlMs: 65 * 60_000,
          now: new Date(),
        });
        await sink({
          token,
          attestation,
          publicKeyPem: runtimePublicKeyBytes!.toString("utf8"),
        });
        attestationDigest = fleetMigrationAttestationDigest(attestation);
        expiresAt = attestation.expiresAt;
      },
    });
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      contract: "fleet-migration-runtime-capability-issuance/v1",
      state: "PRESERVED",
      executionId,
      sourceSha,
      detectorSourceSha,
      readinessEvidenceDigest: readiness.evidenceDigest,
      readinessCohortDigest: readiness.cohortDigest,
      repositoryCount: receipt.repositories.length,
      approvedProofCount: approvedProofDigests.length,
      configSnapshotCount: configSnapshots.length,
      attestationDigest,
      keyId,
      keyFingerprint,
      expiresAt,
      configMapName: required("FLEET_MIGRATION_RUNTIME_CONFIG_MAP", DNS),
      secretName: required("FLEET_MIGRATION_GITHUB_TOKEN_SECRET", DNS),
      githubMutations: 1,
      domainMutations: 0,
      secretValuesReturned: false,
    })}\n`);
  } finally {
    runtimePrivateKeyBytes?.fill(0);
    runtimePublicKeyBytes?.fill(0);
  }
}

main()
  .catch((error: unknown) => {
    console.error(`Fleet migration runtime capability 발급 실패: ${publicError(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
