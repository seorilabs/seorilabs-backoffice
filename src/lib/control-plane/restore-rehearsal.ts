import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import {
  assertResolvableConfigRevision,
  ControlPlaneError,
  resolvedWorkflowCaller,
} from "@/lib/control-plane/service";
import { jsonDigest, type JsonValue } from "@/lib/control-plane/json";
import { latestDiscoveryObservationOrder } from "@/lib/control-plane/discovery-order";

export function isolatedRehearsalDatabaseUrl(input: {
  host: string;
  password: string;
  port?: number;
}): string {
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(input.host)) {
    throw new Error("REHEARSAL_DATABASE_NOT_ISOLATED");
  }
  if (!input.password || /[\r\n\0]/.test(input.password)) {
    throw new Error("REHEARSAL_DATABASE_PASSWORD_INVALID");
  }
  const port = input.port ?? 3306;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("REHEARSAL_DATABASE_PORT_INVALID");
  }
  return `mysql://root:${encodeURIComponent(input.password)}@${input.host}:${port}/backoffice_rehearsal?connection_limit=2`;
}

export function assertIsolatedRehearsalDatabaseUrl(value: string): void {
  const url = new URL(value);
  const database = url.pathname.replace(/^\//, "");
  if (
    url.protocol !== "mysql:"
    || !new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)
    || database !== "backoffice_rehearsal"
  ) {
    throw new Error("REHEARSAL_DATABASE_NOT_ISOLATED");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function verifyRestoredControlPlane(input: {
  client: PrismaClient;
  signingKey: string;
}) {
  if (!input.signingKey) throw new Error("SIGNING_KEY_MISSING");
  const active = await input.client.configRevision.findMany({
    where: { status: "ACTIVE" },
    orderBy: [{ appId: "asc" }, { revision: "asc" }],
    select: {
      id: true,
      appId: true,
      revision: true,
      status: true,
      activatedSnapshot: true,
      snapshotDigest: true,
      snapshotSignature: true,
      app: {
        select: {
          repoId: true,
          repoFullName: true,
          discoveryObservations: {
            orderBy: latestDiscoveryObservationOrder(),
            take: 1,
            select: {
              id: true,
              sourceSha: true,
              payloadHash: true,
              workflowProfile: true,
              workflowPackageManager: true,
              workflowWorkingDirectory: true,
            },
          },
        },
      },
    },
  });
  if (active.length === 0) throw new Error("ACTIVE_SNAPSHOT_MISSING");

  const recovered = active.map((revision) => {
    assertResolvableConfigRevision(revision, input.signingKey);
    try {
      assertResolvableConfigRevision(revision, `${input.signingKey}:wrong-key`);
      throw new Error("INVALID_SIGNATURE_ACCEPTED");
    } catch (error) {
      if (!(error instanceof ControlPlaneError) || error.code !== "INVALID_CONFIG_SIGNATURE") throw error;
    }
    const discovery = revision.app.discoveryObservations[0];
    if (!revision.app.repoId || !discovery) throw new Error("ACTIVE_MANIFEST_SOURCE_MISSING");
    const workflowCaller = resolvedWorkflowCaller({
      profile: discovery.workflowProfile,
      packageManager: discovery.workflowPackageManager,
      workingDirectory: discovery.workflowWorkingDirectory,
    });
    return {
      appId: revision.appId,
      repoId: revision.app.repoId.toString(),
      repoFullName: revision.app.repoFullName,
      revision: revision.revision,
      sourceSha: discovery.sourceSha,
      discoveryObservationId: discovery.id,
      discoveryPayloadHash: discovery.payloadHash,
      workflowCaller,
      snapshotDigest: revision.snapshotDigest,
      snapshotSignature: revision.snapshotSignature,
    };
  });

  try {
    assertResolvableConfigRevision({
      status: "DRAFT",
      activatedSnapshot: null,
      snapshotDigest: null,
      snapshotSignature: null,
    }, input.signingKey);
    throw new Error("DRAFT_CONFIG_RESOLVED");
  } catch (error) {
    if (!(error instanceof ControlPlaneError) || error.code !== "NO_ACTIVE_CONFIG") throw error;
  }

  const manifestDigest = jsonDigest(recovered as JsonValue);
  return {
    activeSnapshotCount: active.length,
    resolvedManifestCount: recovered.length,
    manifestDigest,
    invalidSignatureRejected: true,
    draftRejected: true,
    evidenceDigest: sha256(JSON.stringify({
      activeSnapshotCount: active.length,
      resolvedManifestCount: recovered.length,
      manifestDigest,
      invalidSignatureRejected: true,
      draftRejected: true,
    })),
  };
}
