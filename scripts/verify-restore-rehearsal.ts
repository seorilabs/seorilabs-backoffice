import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

import {
  assertIsolatedRehearsalDatabaseUrl,
  ensureRestoredAppendOnlyTriggers,
  isolatedRehearsalDatabaseUrl,
  verifyRestoredControlPlane,
} from "@/lib/control-plane/restore-rehearsal";

class RehearsalFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new RehearsalFailure(`${name}_MISSING`);
  return value;
}

function secretFile(name: string): string {
  const value = readFileSync(required(name), "utf8").trim();
  if (!value) throw new RehearsalFailure(`${name}_EMPTY`);
  return value;
}

function classifiedRunFailure(baseCode: string, output: string): string {
  const classifications: Array<[RegExp, string]> = [
    [/Can't reach database server|connect ECONNREFUSED/, "DATABASE_UNREACHABLE"],
    [/Access denied for user/, "DATABASE_ACCESS_DENIED"],
    [/운영 legacy migration ledger가 frozen inventory와 다르다/, "LEGACY_LEDGER_DRIFT"],
    [/active migration 성공 row가 유일하지 않다/, "ACTIVE_MIGRATION_DRIFT"],
    [/schema contract 불일치/, "SCHEMA_CONTRACT_DRIFT"],
    [/append-only trigger 계약 실패/, "APPEND_ONLY_TRIGGER_DRIFT"],
    [/application data fingerprint/, "DATA_FINGERPRINT_INVALID"],
    [/unknown database|does not exist/i, "DATABASE_MISSING"],
  ];
  const classification = classifications.find(([pattern]) => pattern.test(output));
  return classification ? `${baseCode}_${classification[1]}` : baseCode;
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  failureCode: string,
  input?: string,
): string {
  const result = spawnSync(command, args, {
    cwd: required("REHEARSAL_APP_ROOT"),
    env,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new RehearsalFailure(classifiedRunFailure(
      failureCode,
      `${result.stdout}\n${result.stderr}`,
    ));
  }
  return result.stdout.trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rehearsalStep<T>(
  failureCode: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof RehearsalFailure) throw error;
    if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) throw error;
    throw new RehearsalFailure(failureCode);
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function bootAndReplayManifest(input: {
  childEnv: NodeJS.ProcessEnv;
  signingKey: string;
  repoId: bigint;
  sourceSha: string;
  expectedSnapshotDigest: string;
  serverEntry: string;
}) {
  const port = 3100;
  const adminToken = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [input.serverEntry], {
    cwd: dirname(input.serverEntry),
    env: {
      ...input.childEnv,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      AUTH_SECRET: randomBytes(32).toString("hex"),
      CONTROL_PLANE_ADMIN_TOKEN: adminToken,
      CONTROL_PLANE_SNAPSHOT_SIGNING_KEY: input.signingKey,
    },
    stdio: "ignore",
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new RehearsalFailure("RESTORED_APP_BOOT_FAILED");
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // 서버가 listen하기 전의 연결 거부는 제한된 횟수 안에서만 재시도한다.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new RehearsalFailure("RESTORED_APP_NOT_READY");
    let manifest: Response;
    try {
      manifest = await fetch(
        `http://127.0.0.1:${port}/api/control-plane/apps/${input.repoId.toString()}/resolved-manifest?ref=${input.sourceSha}`,
        {
          headers: {
            authorization: `Bearer ${adminToken}`,
            "x-seori-principal": "restore-rehearsal",
          },
        },
      );
    } catch {
      throw new RehearsalFailure("RESTORED_MANIFEST_REQUEST_FAILED");
    }
    if (!manifest.ok) throw new RehearsalFailure("RESTORED_MANIFEST_REPLAY_FAILED");
    let body: {
      source?: { sha?: unknown };
      config?: { digest?: unknown };
    };
    try {
      body = await manifest.json() as {
        source?: { sha?: unknown };
        config?: { digest?: unknown };
      };
    } catch {
      throw new RehearsalFailure("RESTORED_MANIFEST_RESPONSE_INVALID");
    }
    if (
      body.source?.sha !== input.sourceSha
      || body.config?.digest !== input.expectedSnapshotDigest
    ) {
      throw new RehearsalFailure("RESTORED_MANIFEST_IDENTITY_MISMATCH");
    }
    return { bootReady: true, httpManifestReplay: true };
  } finally {
    await stopChild(child);
  }
}

async function main(): Promise<void> {
  if (required("REHEARSAL_ISOLATION_MODE") !== "POD_SCOPED_EMPTYDIR") {
    throw new RehearsalFailure("REHEARSAL_ISOLATION_MODE_INVALID");
  }
  const appRoot = resolve(required("REHEARSAL_APP_ROOT"));
  const serverEntry = resolve(process.env.REHEARSAL_SERVER_ENTRY ?? join(appRoot, "server.js"));
  const dumpBasename = required("REHEARSAL_DUMP_BASENAME");
  const sourceSha = required("BACKOFFICE_SOURCE_SHA");
  const dumpSha256 = secretFile("REHEARSAL_DUMP_SHA256_FILE");
  if (!/^backoffice-\d{8}T\d{6}Z\.sql\.gz$/.test(dumpBasename)) {
    throw new RehearsalFailure("DUMP_BASENAME_INVALID");
  }
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new RehearsalFailure("SOURCE_SHA_INVALID");
  if (!/^[0-9a-f]{64}$/.test(dumpSha256)) throw new RehearsalFailure("DUMP_SHA256_INVALID");

  const databaseUrl = isolatedRehearsalDatabaseUrl({
    host: required("REHEARSAL_MYSQL_HOST"),
    password: secretFile("REHEARSAL_DB_PASSWORD_FILE"),
    port: Number(process.env.REHEARSAL_MYSQL_PORT ?? "3306"),
  });
  assertIsolatedRehearsalDatabaseUrl(databaseUrl);
  const childEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    HOME: "/tmp",
    CHECKPOINT_DISABLE: "1",
  };
  const localPrisma = join(appRoot, "node_modules/.bin/prisma");
  const prismaCommand = existsSync(localPrisma) ? localPrisma : "prisma";
  const verifier = join(appRoot, "scripts-dist/verify-migration-state.cjs");
  const verifyArgs = [verifier, "--history=cutover", "--print-data-fingerprint"];
  const triggerClient = new PrismaClient({ datasourceUrl: databaseUrl });
  const appendOnlyTriggers = await rehearsalStep(
    "APPEND_ONLY_TRIGGER_RECONSTRUCTION_FAILED",
    async () => {
      try {
        return await ensureRestoredAppendOnlyTriggers({
          client: triggerClient,
          databaseUrl,
          executeTriggerDdl: async (statement) => {
            run(
              prismaCommand,
              ["db", "execute", "--stdin", "--schema", join(appRoot, "prisma/schema.prisma")],
              { ...childEnv, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
              "APPEND_ONLY_TRIGGER_DDL_FAILED",
              `${statement};\n`,
            );
          },
        });
      } finally {
        await triggerClient.$disconnect();
      }
    },
  );
  const before = run(process.execPath, verifyArgs, childEnv, "MIGRATION_PRECHECK_FAILED");
  run(
    prismaCommand,
    ["migrate", "deploy", "--schema", join(appRoot, "prisma/schema.prisma")],
    childEnv,
    "MIGRATION_DEPLOY_FAILED",
  );
  const secondDeploy = run(
    prismaCommand,
    ["migrate", "deploy", "--schema", join(appRoot, "prisma/schema.prisma")],
    childEnv,
    "MIGRATION_SECOND_DEPLOY_FAILED",
  );
  if (!secondDeploy.includes("No pending migrations to apply.")) {
    throw new RehearsalFailure("MIGRATION_SECOND_DEPLOY_NOT_NOOP");
  }
  run(
    prismaCommand,
    ["migrate", "status", "--schema", join(appRoot, "prisma/schema.prisma")],
    childEnv,
    "MIGRATION_STATUS_FAILED",
  );
  run(prismaCommand, [
    "migrate", "diff",
    "--from-schema-datasource", join(appRoot, "prisma/schema.prisma"),
    "--to-schema-datamodel", join(appRoot, "prisma/schema.prisma"),
    "--exit-code",
  ], childEnv, "MIGRATION_SCHEMA_DIFF_FAILED");
  const after = run(process.execPath, verifyArgs, childEnv, "MIGRATION_POSTCHECK_FAILED");
  if (before !== after) throw new RehearsalFailure("DATA_FINGERPRINT_CHANGED");
  const summary = before.match(
    /rows=(\d+) tables=(\d+) columns=(\d+) indexes=(\d+) foreignKeys=(\d+)[\s\S]*application data fingerprint: tables=(\d+) sha256=([0-9a-f]{64})/,
  );
  if (!summary) throw new RehearsalFailure("MIGRATION_EVIDENCE_INVALID");

  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const signingKey = secretFile("CONTROL_PLANE_SNAPSHOT_SIGNING_KEY_FILE");
    const controlPlane = await rehearsalStep(
      "RESTORED_CONTROL_PLANE_CHECK_FAILED",
      () => verifyRestoredControlPlane({ client, signingKey }),
    );
    const replayTarget = await rehearsalStep(
      "RESTORED_MANIFEST_TARGET_QUERY_FAILED",
      () => client.configRevision.findFirstOrThrow({
        where: { status: "ACTIVE", snapshotDigest: { not: null } },
        orderBy: [{ appId: "asc" }, { revision: "asc" }],
        select: {
          snapshotDigest: true,
          app: {
            select: {
              repoId: true,
              discoveryObservations: {
                orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
                take: 1,
                select: { sourceSha: true },
              },
            },
          },
        },
      }),
    );
    if (!replayTarget.snapshotDigest || !replayTarget.app.repoId || !replayTarget.app.discoveryObservations[0]) {
      throw new RehearsalFailure("RESTORED_MANIFEST_TARGET_MISSING");
    }
    const boot = await rehearsalStep(
      "RESTORED_APP_REPLAY_CHECK_FAILED",
      () => bootAndReplayManifest({
        childEnv,
        signingKey,
        repoId: replayTarget.app.repoId!,
        sourceSha: replayTarget.app.discoveryObservations[0]!.sourceSha,
        expectedSnapshotDigest: replayTarget.snapshotDigest!,
        serverEntry,
      }),
    );
    const evidence = {
      schemaVersion: 1,
      status: "PASSED",
      sourceSha,
      dumpBasename,
      dumpSha256,
      migration: {
        historyRows: Number(summary[1]),
        tables: Number(summary[2]),
        columns: Number(summary[3]),
        indexes: Number(summary[4]),
        foreignKeys: Number(summary[5]),
        dataTables: Number(summary[6]),
        dataFingerprint: summary[7],
        evidenceDigest: sha256(before),
        secondDeployNoop: true,
      },
      appendOnlyTriggers,
      controlPlane,
      boot,
      productionDatabaseWrite: false,
      cleanupMode: "POD_SCOPED_EMPTYDIR",
    };
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    await client.$disconnect();
  }
}

main().catch((error: unknown) => {
  const code = error instanceof RehearsalFailure
    ? error.code
    : error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "RESTORE_REHEARSAL_INTERNAL_ERROR";
  console.error(`Restore rehearsal 실패: ${code}`);
  process.exitCode = 1;
});
