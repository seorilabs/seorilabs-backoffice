import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(process.env.REPOSITORY_ROOT ?? scriptRoot);
const manifestPath = resolve(
  process.env.MIGRATION_HISTORY_MANIFEST ??
    join(repositoryRoot, "prisma/migration-history.json"),
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const activeRoot = resolve(
  process.env.MIGRATION_ROOT ?? join(repositoryRoot, "prisma/migrations"),
);
const legacyRoot = resolve(
  process.env.MIGRATION_LEGACY_ROOT ??
    join(repositoryRoot, manifest.legacy.directory),
);
const ledgerPath = resolve(
  process.env.MIGRATION_LEDGER ?? join(repositoryRoot, manifest.legacy.ledger),
);

const failures = [];
const fail = (message) => failures.push(message);
const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const migrationDirectories = (root) =>
  readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort();

const frozenBase = process.env.MIGRATION_FROZEN_BASE;
if (frozenBase) {
  const commit = spawnSync("git", ["cat-file", "-e", `${frozenBase}^{commit}`], {
    cwd: repositoryRoot,
  });
  if (commit.status !== 0) {
    fail("frozen migration 비교 기준 commit을 읽을 수 없다");
  } else {
    const previousManifest = spawnSync(
      "git",
      ["cat-file", "-e", `${frozenBase}:prisma/migration-history.json`],
      { cwd: repositoryRoot },
    );
    if (previousManifest.status === 0) {
      const frozenPaths = [
        "prisma/migration-history.json",
        "prisma/migration-archive/legacy-v1",
        "prisma/migration-archive/production-ledger-v1.tsv",
        "prisma/migrations/00000000000000_squashed_migrations",
        "prisma/schema-contract-v1.json",
      ];
      const changed = spawnSync(
        "git",
        ["diff", "--name-only", frozenBase, "HEAD", "--", ...frozenPaths],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      if (changed.status !== 0) {
        fail("frozen migration 파일의 base diff를 계산할 수 없다");
      } else if (changed.stdout.trim()) {
        fail(`이미 배포된 frozen migration 파일이 변경됐다: ${changed.stdout.trim()}`);
      }

      const activeChanges = spawnSync(
        "git",
        ["diff", "--name-status", frozenBase, "HEAD", "--", "prisma/migrations"],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      if (activeChanges.status !== 0) {
        fail("active migration의 base diff를 계산할 수 없다");
      } else {
        const nonAdditive = activeChanges.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .filter((line) => !line.startsWith("A\t"));
        if (nonAdditive.length > 0) {
          fail(`이미 배포된 active migration이 변경됐다: ${nonAdditive.join(", ")}`);
        }

        const baseMigrations = spawnSync(
          "git",
          ["ls-tree", "--name-only", `${frozenBase}:prisma/migrations`],
          { cwd: repositoryRoot, encoding: "utf8" },
        );
        if (baseMigrations.status !== 0) {
          fail("배포 기준의 active migration 순서를 읽을 수 없다");
        } else {
          const previousNames = baseMigrations.stdout
            .trim()
            .split("\n")
            .filter((name) => /^\d+_[a-z0-9_]+$/.test(name))
            .sort();
          const lastPrevious = previousNames.at(-1);
          const addedNames = activeChanges.stdout
            .trim()
            .split("\n")
            .filter((line) => line.startsWith("A\t"))
            .map((line) => line.split("\t")[1] ?? "")
            .map((path) => path.match(/^prisma\/migrations\/([^/]+)\/migration\.sql$/)?.[1])
            .filter((name) => name !== undefined);
          if (lastPrevious) {
            for (const name of addedNames) {
              if (name <= lastPrevious) {
                fail(`새 migration은 배포 기준 마지막 migration 뒤에만 추가할 수 있다: ${name} <= ${lastPrevious}`);
              }
            }
          }
        }
      }
    }
  }
}

if (manifest.version !== 1 || manifest.provider !== "mysql") {
  fail("migration history manifest version 또는 provider가 올바르지 않다");
}
const migrationLock = readFileSync(join(activeRoot, "migration_lock.toml"), "utf8");
if (!/^provider\s*=\s*"mysql"\s*$/m.test(migrationLock)) {
  fail("migration_lock.toml provider가 mysql이 아니다");
}

const ledgerSha = sha256(ledgerPath);
if (ledgerSha !== manifest.legacy.ledgerSha256) {
  fail("production legacy ledger checksum이 변경됐다");
}

const baselineContractPath = resolve(
  repositoryRoot,
  manifest.baseline.schemaContract,
);
if (sha256(baselineContractPath) !== manifest.baseline.schemaContractSha256) {
  fail("baseline schema contract checksum이 변경됐다");
}
const currentContractPath = resolve(
  repositoryRoot,
  manifest.currentSchemaContract,
);
try {
  JSON.parse(readFileSync(currentContractPath, "utf8"));
} catch {
  fail("current schema contract를 읽을 수 없다");
}

const ledgerLines = readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
const expectedHeader =
  "migration_name\tchecksum\tstatus\tapplied_steps_count\toccurrence";
if (ledgerLines.shift() !== expectedHeader) {
  fail("production legacy ledger header가 올바르지 않다");
}

const ledgerRows = ledgerLines.map((line, index) => {
  const fields = line.split("\t");
  if (fields.length !== 5) {
    fail(`legacy ledger ${index + 2}행의 column 수가 올바르지 않다`);
  }
  const [name, checksum, status, steps, occurrence] = fields;
  if (!/^[a-f0-9]{64}$/.test(checksum ?? "")) {
    fail(`legacy ledger checksum 형식이 올바르지 않다: ${name}`);
  }
  if (!/^(SUCCEEDED|ROLLED_BACK)$/.test(status ?? "")) {
    fail(`legacy ledger status가 올바르지 않다: ${name}`);
  }
  if (!/^\d+$/.test(steps ?? "") || !/^[1-9]\d*$/.test(occurrence ?? "")) {
    fail(`legacy ledger count가 올바르지 않다: ${name}`);
  }
  return { name, checksum, status, steps, occurrence };
});

const successfulRows = ledgerRows.filter((row) => row.status === "SUCCEEDED");
const rolledBackRows = ledgerRows.filter((row) => row.status === "ROLLED_BACK");
if (successfulRows.length !== manifest.legacy.successfulMigrations) {
  fail(
    `legacy 성공 migration 수가 변경됐다: expected=${manifest.legacy.successfulMigrations} actual=${successfulRows.length}`,
  );
}
if (rolledBackRows.length !== manifest.legacy.allowedRolledBackAttempts) {
  fail(
    `legacy rollback attempt 수가 변경됐다: expected=${manifest.legacy.allowedRolledBackAttempts} actual=${rolledBackRows.length}`,
  );
}

const successfulNames = new Set();
for (const row of successfulRows) {
  if (successfulNames.has(row.name)) {
    fail(`legacy 성공 migration이 중복됐다: ${row.name}`);
  }
  successfulNames.add(row.name);
}

const archivedNames = migrationDirectories(legacyRoot);
for (const name of archivedNames) {
  if (!successfulNames.has(name)) {
    fail(`ledger에 없는 legacy migration 디렉터리다: ${name}`);
  }
}
for (const row of successfulRows) {
  if (!archivedNames.includes(row.name)) {
    fail(`legacy migration 디렉터리가 사라지거나 rename됐다: ${row.name}`);
    continue;
  }
  const sqlPath = join(legacyRoot, row.name, "migration.sql");
  if (sha256(sqlPath) !== row.checksum) {
    fail(`legacy migration checksum이 변경됐다: ${row.name}`);
  }
}

const activeNames = migrationDirectories(activeRoot);
const baselineName = manifest.baseline.name;
if (!activeNames.includes(baselineName)) {
  fail(`baseline migration이 없다: ${baselineName}`);
} else {
  const baselinePath = join(activeRoot, baselineName, "migration.sql");
  if (sha256(baselinePath) !== manifest.baseline.sha256) {
    fail(`baseline migration checksum이 변경됐다: ${baselineName}`);
  }
}

const width = manifest.naming.width;
const notBefore = manifest.naming.notBefore;
const namePattern = new RegExp(`^\\d{${width}}_[a-z0-9_]+$`);
const prefixes = new Set();
let checked = 0;
for (const name of activeNames) {
  if (!namePattern.test(name)) {
    fail(`${width}자리 numeric prefix가 아닌 migration 디렉터리다: ${name}`);
    continue;
  }
  const prefix = name.slice(0, width);
  if (prefixes.has(prefix)) {
    fail(`numeric prefix가 중복됐다: ${prefix}`);
  }
  prefixes.add(prefix);

  const sqlPath = join(activeRoot, name, "migration.sql");
  let sql;
  try {
    sql = readFileSync(sqlPath, "utf8");
  } catch {
    fail(`migration.sql이 없다: ${name}`);
    continue;
  }
  if (name === baselineName) {
    continue;
  }
  if (prefix < notBefore) {
    fail(`baseline 이후 migration timestamp가 정책 시작보다 이르다: ${name}`);
  }
  checked += 1;
  const normalized = sql.replace(/--.*$/gm, " ").replace(/\s+/g, " ");
  const mutationScan = normalized.replace(
    /\bON\s+UPDATE\s+(?:CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL)\b/gi,
    " ",
  );
  if (
    /\b(DROP|TRUNCATE|RENAME|MODIFY|CHANGE)\b|\bDELETE\s+FROM\b|\bUPDATE\s+/i.test(
      mutationScan,
    )
  ) {
    fail(`expand-only 금지 SQL이 있다: ${name}`);
  }
  if (/ALTER\s+TABLE[^;]*ADD(?:\s+COLUMN)?[^;]*NOT\s+NULL/i.test(normalized)) {
    fail(`기존 writer와 호환되지 않는 NOT NULL column 추가가 있다: ${name}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`오류: ${failure}`);
  }
  console.error(
    "destructive contract 변경은 expand/backfill/contract 단계로 분리하고 별도 승인해야 한다.",
  );
  process.exit(1);
}

console.log(
  `migration history 계약 통과: baseline=${baselineName} legacy=${successfulRows.length} future=${checked}`,
);
