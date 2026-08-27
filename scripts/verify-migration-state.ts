import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

type HistoryMode = "fresh" | "legacy" | "cutover" | "predeploy";
type DatabaseRow = Record<string, unknown>;
type Fingerprint = { count: number; sha256: string };
type SchemaContract = {
  version: number;
  mysqlVersionPrefix: string;
  tables: Fingerprint;
  columns: Fingerprint;
  indexes: Fingerprint;
  foreignKeys: Fingerprint;
};

const repositoryRoot = resolve(process.env.REPOSITORY_ROOT ?? process.cwd());
const manifestPath = resolve(
  process.env.MIGRATION_HISTORY_MANIFEST ??
    join(repositoryRoot, "prisma/migration-history.json"),
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  baseline: {
    name: string;
    sha256: string;
    schemaContract: string;
    schemaContractSha256: string;
  };
  currentSchemaContract: string;
  legacy: {
    ledger: string;
    successfulMigrations: number;
    allowedRolledBackAttempts: number;
  };
};
const activeRoot = resolve(
  process.env.MIGRATION_ROOT ?? join(repositoryRoot, "prisma/migrations"),
);
const ledgerPath = resolve(
  process.env.MIGRATION_LEDGER ?? join(repositoryRoot, manifest.legacy.ledger),
);
function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const historyMode = option("history") as HistoryMode | undefined;
const expectedLineage = option("expected-lineage") as
  | "fresh"
  | "cutover"
  | undefined;
const printContract = process.argv.includes("--print-contract");
const printDataFingerprint = process.argv.includes("--print-data-fingerprint");
if (
  !historyMode ||
  !["fresh", "legacy", "cutover", "predeploy"].includes(historyMode)
) {
  throw new Error("--history=fresh|legacy|cutover|predeploy가 필요하다");
}
if (expectedLineage && !["fresh", "cutover"].includes(expectedLineage)) {
  throw new Error("--expected-lineage=fresh|cutover만 허용한다");
}
const contractPath = resolve(
  process.env.SCHEMA_CONTRACT ??
    join(
      repositoryRoot,
      historyMode === "legacy"
        ? manifest.baseline.schemaContract
        : manifest.currentSchemaContract,
    ),
);

function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("hex");
  return value;
}

function fingerprint(rows: DatabaseRow[]): Fingerprint {
  const canonical = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, normalizeValue(value)]),
    ),
  );
  return {
    count: canonical.length,
    sha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function activeMigrations(): Map<string, string> {
  const result = new Map<string, string>();
  for (const name of readdirSync(activeRoot).sort()) {
    const directory = join(activeRoot, name);
    if (!statSync(directory).isDirectory()) continue;
    result.set(name, sha256(join(directory, "migration.sql")));
  }
  return result;
}

type LedgerRow = {
  name: string;
  checksum: string;
  status: "SUCCEEDED" | "ROLLED_BACK";
  steps: number;
  occurrence: number;
};

function legacyLedger(): LedgerRow[] {
  const lines = readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
  const header = lines.shift();
  if (
    header !==
    "migration_name\tchecksum\tstatus\tapplied_steps_count\toccurrence"
  ) {
    throw new Error("legacy ledger header가 올바르지 않다");
  }
  return lines.map((line) => {
    const [name, checksum, status, steps, occurrence] = line.split("\t");
    if (status !== "SUCCEEDED" && status !== "ROLLED_BACK") {
      throw new Error(`legacy ledger status가 올바르지 않다: ${name}`);
    }
    return {
      name,
      checksum,
      status,
      steps: Number(steps),
      occurrence: Number(occurrence),
    };
  });
}

function ledgerKey(row: LedgerRow): string {
  return [row.name, row.checksum, row.status, row.steps, row.occurrence].join("\t");
}

async function readHistory(prisma: PrismaClient): Promise<LedgerRow[]> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      migrationName: string;
      checksum: string;
      finished: number | bigint;
      rolledBack: number | bigint;
      appliedSteps: number | bigint;
      startedAt: Date;
      id: string;
    }>
  >(`
    SELECT
      migration_name AS migrationName,
      checksum,
      (finished_at IS NOT NULL) AS finished,
      (rolled_back_at IS NOT NULL) AS rolledBack,
      applied_steps_count AS appliedSteps,
      started_at AS startedAt,
      id
    FROM _prisma_migrations
    ORDER BY started_at, id
  `);
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const occurrence = (occurrences.get(row.migrationName) ?? 0) + 1;
    occurrences.set(row.migrationName, occurrence);
    const finished = Number(row.finished) === 1;
    const rolledBack = Number(row.rolledBack) === 1;
    if (!finished && !rolledBack) {
      throw new Error(`미해결 migration attempt가 있다: ${row.migrationName}`);
    }
    return {
      name: row.migrationName,
      checksum: row.checksum,
      status: rolledBack ? "ROLLED_BACK" : "SUCCEEDED",
      steps: Number(row.appliedSteps),
      occurrence,
    };
  });
}

function verifyHistory(actual: LedgerRow[]): void {
  const legacy = legacyLedger();
  const active = activeMigrations();
  const baseline = active.get(manifest.baseline.name);
  if (baseline !== manifest.baseline.sha256) {
    throw new Error("active baseline checksum이 manifest와 다르다");
  }

  if (historyMode === "legacy" || historyMode === "cutover") {
    const actualLegacy = actual.filter((row) =>
      legacy.some((expected) => expected.name === row.name),
    );
    const expectedKeys = legacy.map(ledgerKey).sort();
    const actualKeys = actualLegacy.map(ledgerKey).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error("운영 legacy migration ledger가 frozen inventory와 다르다");
    }
  } else if (actual.some((row) => legacy.some((item) => item.name === row.name))) {
    throw new Error("fresh DB에 legacy migration row가 있다");
  }

  const activeRows = actual.filter((row) => active.has(row.name));
  if (historyMode === "legacy") {
    if (activeRows.length !== 0) {
      throw new Error("cutover 전 DB에 active baseline row가 이미 있다");
    }
  } else {
    for (const [name, checksum] of active) {
      const succeeded = activeRows.filter(
        (row) =>
          row.name === name && row.status === "SUCCEEDED" && row.checksum === checksum,
      );
      if (succeeded.length !== 1) {
        throw new Error(`active migration 성공 row가 유일하지 않다: ${name}`);
      }
    }
    if (
      activeRows.some(
        (row) => row.status !== "SUCCEEDED" || row.checksum !== active.get(row.name),
      )
    ) {
      throw new Error("active migration에 rollback 또는 checksum drift가 있다");
    }
  }

  const known = new Set([
    ...legacy.map((row) => row.name),
    ...active.keys(),
  ]);
  const unknown = actual.filter((row) => !known.has(row.name));
  if (unknown.length > 0) {
    throw new Error(`inventory에 없는 migration row가 있다: ${unknown[0].name}`);
  }
}

async function classifyPredeploy(prisma: PrismaClient): Promise<"fresh" | "cutover"> {
  const tables = await prisma.$queryRawUnsafe<Array<{ tableName: string }>>(`
    SELECT TABLE_NAME AS tableName
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME
  `);
  const hasHistory = tables.some(({ tableName }) => tableName === "_prisma_migrations");
  const userTables = tables.filter(({ tableName }) => tableName !== "_prisma_migrations");
  if (!hasHistory && userTables.length === 0) return "fresh";
  if (!hasHistory) {
    throw new Error("migration history 없이 application table이 존재한다");
  }

  const actual = await readHistory(prisma);
  if (userTables.length === 0 && actual.length === 0) return "fresh";
  const legacy = legacyLedger();
  const active = activeMigrations();
  const known = new Set([
    ...legacy.map((row) => row.name),
    ...active.keys(),
  ]);
  const unknown = actual.filter((row) => !known.has(row.name));
  if (unknown.length > 0) {
    throw new Error(`inventory에 없는 migration row가 있다: ${unknown[0].name}`);
  }

  const actualLegacy = actual.filter((row) =>
    legacy.some((expected) => expected.name === row.name),
  );
  const hasFullLegacy =
    JSON.stringify(actualLegacy.map(ledgerKey).sort()) ===
    JSON.stringify(legacy.map(ledgerKey).sort());
  if (actualLegacy.length > 0 && !hasFullLegacy) {
    throw new Error("predeploy legacy ledger가 frozen inventory와 다르다");
  }

  const activeRows = actual.filter((row) => active.has(row.name));
  const activeCounts = new Map<string, number>();
  for (const row of activeRows) {
    if (
      row.status !== "SUCCEEDED" ||
      row.checksum !== active.get(row.name)
    ) {
      throw new Error(`active migration checksum 또는 상태가 올바르지 않다: ${row.name}`);
    }
    activeCounts.set(row.name, (activeCounts.get(row.name) ?? 0) + 1);
  }
  const duplicate = [...activeCounts].find(([, count]) => count !== 1);
  if (duplicate) {
    throw new Error(`active migration 성공 row가 유일하지 않다: ${duplicate[0]}`);
  }

  const activeOrder = [...active.keys()];
  const appliedOrder = activeOrder.filter((name) => activeCounts.has(name));
  const expectedPrefix = activeOrder.slice(0, appliedOrder.length);
  if (JSON.stringify(appliedOrder) !== JSON.stringify(expectedPrefix)) {
    throw new Error("active migration 적용 이력이 사전식 prefix가 아니다");
  }

  if (actualLegacy.length === 0) {
    if (activeRows.length === 0) {
      throw new Error("migration history와 application table의 계보를 확인할 수 없다");
    }
    if (!activeCounts.has(manifest.baseline.name)) {
      throw new Error("fresh 계보에 baseline 성공 row가 없다");
    }
    return "fresh";
  }

  if (activeRows.length === 0) {
    throw new Error("BASELINE_RESOLVE_REQUIRED");
  }
  if (!activeCounts.has(manifest.baseline.name)) {
    throw new Error("cutover 계보에 baseline 성공 row가 없다");
  }
  return "cutover";
}

async function readSchemaContract(prisma: PrismaClient): Promise<SchemaContract> {
  const [versionRow] = await prisma.$queryRawUnsafe<Array<{ version: string }>>(
    "SELECT VERSION() AS version",
  );
  const tables = await prisma.$queryRawUnsafe<DatabaseRow[]>(`
    SELECT TABLE_NAME AS tableName, ENGINE AS engine, TABLE_COLLATION AS tableCollation
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_TYPE = 'BASE TABLE'
      AND TABLE_NAME <> '_prisma_migrations'
    ORDER BY TABLE_NAME
  `);
  const columns = await prisma.$queryRawUnsafe<DatabaseRow[]>(`
    SELECT
      TABLE_NAME AS tableName,
      COLUMN_NAME AS columnName,
      COLUMN_TYPE AS columnType,
      IS_NULLABLE AS isNullable,
      COLUMN_DEFAULT AS columnDefault,
      EXTRA AS extra,
      GENERATION_EXPRESSION AS generationExpression
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME <> '_prisma_migrations'
    ORDER BY TABLE_NAME, COLUMN_NAME
  `);
  const indexes = await prisma.$queryRawUnsafe<DatabaseRow[]>(`
    SELECT
      TABLE_NAME AS tableName,
      INDEX_NAME AS indexName,
      NON_UNIQUE AS nonUnique,
      SEQ_IN_INDEX AS seqInIndex,
      COLUMN_NAME AS columnName,
      SUB_PART AS subPart,
      INDEX_TYPE AS indexType,
      COLLATION AS collation,
      NULLABLE AS nullable,
      EXPRESSION AS expression
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME <> '_prisma_migrations'
    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
  `);
  const foreignKeys = await prisma.$queryRawUnsafe<DatabaseRow[]>(`
    SELECT
      k.TABLE_NAME AS tableName,
      k.CONSTRAINT_NAME AS constraintName,
      k.ORDINAL_POSITION AS ordinalPosition,
      k.COLUMN_NAME AS columnName,
      k.REFERENCED_TABLE_NAME AS referencedTableName,
      k.REFERENCED_COLUMN_NAME AS referencedColumnName,
      r.UPDATE_RULE AS updateRule,
      r.DELETE_RULE AS deleteRule
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
     AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
     AND r.TABLE_NAME = k.TABLE_NAME
    WHERE k.CONSTRAINT_SCHEMA = DATABASE()
      AND k.REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION
  `);
  return {
    version: 1,
    mysqlVersionPrefix: versionRow.version.split(".").slice(0, 2).join(".") + ".",
    tables: fingerprint(tables),
    columns: fingerprint(columns),
    indexes: fingerprint(indexes),
    foreignKeys: fingerprint(foreignKeys),
  };
}

function verifyContract(actual: SchemaContract): void {
  const expected = JSON.parse(readFileSync(contractPath, "utf8")) as SchemaContract;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `schema contract 불일치: tables=${actual.tables.count} columns=${actual.columns.count} indexes=${actual.indexes.count} foreignKeys=${actual.foreignKeys.count}`,
    );
  }
}

async function dataFingerprint(prisma: PrismaClient): Promise<Fingerprint> {
  const tables = await prisma.$queryRawUnsafe<Array<{ tableName: string }>>(`
    SELECT TABLE_NAME AS tableName
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_TYPE = 'BASE TABLE'
      AND TABLE_NAME <> '_prisma_migrations'
    ORDER BY TABLE_NAME
  `);
  const counts: DatabaseRow[] = [];
  for (const { tableName } of tables) {
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
      throw new Error("안전하지 않은 table name을 발견했다");
    }
    const [row] = await prisma.$queryRawUnsafe<Array<{ rowCount: bigint }>>(
      `SELECT COUNT(*) AS rowCount FROM \`${tableName}\``,
    );
    counts.push({ tableName, rowCount: row.rowCount });
  }
  return fingerprint(counts);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    if (historyMode === "predeploy") {
      const lineage = await classifyPredeploy(prisma);
      if (expectedLineage && lineage !== expectedLineage) {
        throw new Error(
          `migration lineage 불일치: expected=${expectedLineage} actual=${lineage}`,
        );
      }
      console.log(lineage);
      return;
    }
    const history = await readHistory(prisma);
    verifyHistory(history);
    const contract = await readSchemaContract(prisma);
    if (printContract) {
      process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
    } else {
      verifyContract(contract);
      console.log(
        `migration/schema 계약 통과: mode=${historyMode} rows=${history.length} tables=${contract.tables.count} columns=${contract.columns.count} indexes=${contract.indexes.count} foreignKeys=${contract.foreignKeys.count}`,
      );
    }
    if (printDataFingerprint) {
      const data = await dataFingerprint(prisma);
      console.log(`application data fingerprint: tables=${data.count} sha256=${data.sha256}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    "migration/schema 계약 실패:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exit(1);
});
