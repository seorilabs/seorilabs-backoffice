import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import {
  REQUIRED_APPEND_ONLY_TRIGGERS,
  appendOnlyContractDigest,
  appendOnlyCreateTriggerStatement,
  triggerVisibilityFromGrants,
  verifyAppendOnlyTriggers,
  type ObservedTrigger,
} from "@/lib/control-plane/append-only-triggers";
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
    || (
      database !== "backoffice_rehearsal"
      && !/^backoffice_[a-z0-9_]+_contract_test$/.test(database)
    )
  ) {
    throw new Error("REHEARSAL_DATABASE_NOT_ISOLATED");
  }
}

interface RehearsalTriggerClient {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export type RestoredAppendOnlyTriggerEvidence = {
  mode: "PRESERVED_FROM_DUMP" | "RECONSTRUCTED_FROM_SOURCE_CONTRACT";
  verified: number;
  contractDigest: string;
};

async function observedProtectedTriggers(
  client: RehearsalTriggerClient,
): Promise<ObservedTrigger[]> {
  const protectedTables = [...new Set(
    REQUIRED_APPEND_ONLY_TRIGGERS.map((requirement) => requirement.table),
  )];
  const placeholders = protectedTables.map(() => "?").join(", ");
  const rows = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT
      TRIGGER_NAME AS name,
      EVENT_OBJECT_TABLE AS tableName,
      EVENT_MANIPULATION AS event,
      ACTION_TIMING AS timing,
      ACTION_STATEMENT AS statement
    FROM information_schema.TRIGGERS
    WHERE TRIGGER_SCHEMA = DATABASE()
      AND EVENT_OBJECT_TABLE IN (${placeholders})
    ORDER BY TRIGGER_NAME
  `, ...protectedTables);
  return rows.map((row) => ({
    name: String(row.name ?? ""),
    table: String(row.tableName ?? ""),
    event: String(row.event ?? ""),
    timing: String(row.timing ?? ""),
    statement: String(row.statement ?? ""),
  }));
}

/**
 * production backup principal에는 의도적으로 TRIGGER 권한이 없어 logical dump가
 * trigger DDL을 포함하지 않는다. 복원 시 source SHA에 포함된 exact 계약만 Pod-scoped
 * ephemeral MySQL에 재구성한다. 부분 설치·변형·추가 trigger는 고치지 않고 실패한다.
 */
export async function ensureRestoredAppendOnlyTriggers(
  input: {
    client: RehearsalTriggerClient;
    databaseUrl: string;
  },
): Promise<RestoredAppendOnlyTriggerEvidence> {
  assertIsolatedRehearsalDatabaseUrl(input.databaseUrl);
  const [schemaRow] = await input.client.$queryRawUnsafe<Array<{ schemaName: string }>>(
    "SELECT DATABASE() AS schemaName",
  );
  const grantRows = await input.client.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "SHOW GRANTS FOR CURRENT_USER()",
  );
  const grants = grantRows.map((row) => String(Object.values(row)[0] ?? ""));
  if (
    !schemaRow?.schemaName
    || triggerVisibilityFromGrants(grants, schemaRow.schemaName) !== "VISIBLE"
  ) {
    throw new Error("RESTORE_TRIGGER_VISIBILITY_FORBIDDEN");
  }

  const before = await observedProtectedTriggers(input.client);
  if (before.length > 0) {
    return {
      mode: "PRESERVED_FROM_DUMP",
      verified: verifyAppendOnlyTriggers(before),
      contractDigest: appendOnlyContractDigest(),
    };
  }

  for (const requirement of REQUIRED_APPEND_ONLY_TRIGGERS) {
    await input.client.$executeRawUnsafe(appendOnlyCreateTriggerStatement(requirement));
  }
  const after = await observedProtectedTriggers(input.client);
  return {
    mode: "RECONSTRUCTED_FROM_SOURCE_CONTRACT",
    verified: verifyAppendOnlyTriggers(after),
    contractDigest: appendOnlyContractDigest(),
  };
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
