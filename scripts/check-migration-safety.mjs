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
const canonicalJson = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
};

const appendOnlyTriggerPattern = /\bCREATE\s+TRIGGER\s+`?([a-z0-9_]+)`?\s+BEFORE\s+(UPDATE|DELETE)\s+ON\s+`?([a-z0-9_]+)`?\s+FOR\s+EACH\s+ROW\s+SIGNAL\s+SQLSTATE\s+'45000'\s+SET\s+MESSAGE_TEXT\s*=\s*'([^']+)'\s*;/gi;
// 이 static gate가 알아야 하는 모든 append-only trigger 계약의 합집합이다. 각 계약은
// 독립 감사 원장을 가질 수 있고(예: provider execution vs P2 auth broker journal
// checkpoint), 살아있는 in-cluster verifier가 아직 관측하지 않는 계약도 포함한다 —
// 그 verifier 편입 여부와 무관하게 이 CI gate는 정의된 append-only DDL을 항상 인식해야
// expand-only 위반으로 오탐하지 않는다.
const appendOnlyTriggerContract = new Map([
  [
    "control_plane_provider_execution_event_no_update",
    {
      event: "UPDATE",
      table: "control_plane_provider_execution_event",
      message: "provider execution audit is append-only",
    },
  ],
  [
    "control_plane_provider_execution_event_no_delete",
    {
      event: "DELETE",
      table: "control_plane_provider_execution_event",
      message: "provider execution audit is append-only",
    },
  ],
  [
    "control_plane_auth_broker_journal_checkpoint_event_no_update",
    {
      event: "UPDATE",
      table: "control_plane_auth_broker_journal_checkpoint_event",
      message: "auth broker journal checkpoint audit is append-only",
    },
  ],
  [
    "control_plane_auth_broker_journal_checkpoint_event_no_delete",
    {
      event: "DELETE",
      table: "control_plane_auth_broker_journal_checkpoint_event",
      message: "auth broker journal checkpoint audit is append-only",
    },
  ],
]);

function stripVerifiedAppendOnlyTriggers(sql) {
  return sql.replace(
    appendOnlyTriggerPattern,
    (statement, triggerName, event, table, message) => {
      const contract = appendOnlyTriggerContract.get(triggerName.toLowerCase());
      if (
        contract
        && contract.event === event.toUpperCase()
        && contract.table === table.toLowerCase()
        && contract.message === message
      ) {
        return " ";
      }
      return statement;
    },
  );
}

/**
 * expand-only 계약의 예외로 승인된 contract migration인가.
 *
 * 폐기된 컬럼·테이블은 결국 지워야 하는데, 게이트가 DROP을 무조건 막으면 스키마에
 * 죽은 정의가 영구히 쌓인다. 대신 이름과 **bytes checksum**과 사유를 manifest에 함께
 * 남긴 migration만 예외로 둔다. 파일을 한 글자라도 고치면 checksum이 어긋나 다시 막힌다.
 *
 * 예외는 여전히 expand → 배포 → contract 순서를 전제한다. 구 Pod가 참조하지 않게 된
 * 뒤에만 등록한다.
 */
function approvedContractMigration(name, sqlPath) {
  const policy = manifest.approvedContractMigrations?.[name];
  if (!policy) return false;
  if (typeof policy.reason !== "string" || !policy.reason.trim()) {
    fail(`승인된 contract migration에 사유가 없다: ${name}`);
    return false;
  }
  if (policy.sha256 !== sha256(sqlPath)) {
    fail(`승인된 contract migration의 checksum이 파일과 다르다: ${name}`);
    return false;
  }
  return true;
}

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

      const previousManifestContents = spawnSync(
        "git",
        ["show", `${frozenBase}:prisma/migration-history.json`],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      let addedRecoveryNames = [];
      if (previousManifestContents.status !== 0) {
        fail("배포 기준의 migration history manifest를 읽을 수 없다");
      } else {
        try {
          const previous = JSON.parse(previousManifestContents.stdout);
          const {
            activeRecovery: previousRecovery = {},
            approvedContractMigrations: previousContract = {},
            ...previousImmutable
          } = previous;
          const {
            activeRecovery: currentRecovery = {},
            approvedContractMigrations: currentContract = {},
            ...currentImmutable
          } = manifest;
          if (canonicalJson(previousImmutable) !== canonicalJson(currentImmutable)) {
            fail("migration history manifest의 frozen 정책이 변경됐다");
          }
          // 새 contract 예외는 새 migration 과 함께 추가된다. 이미 배포된 예외를
          // 뒤에서 고쳐 다른 migration 을 열어 주지는 못하게 기존 항목은 동결한다.
          for (const [name, policy] of Object.entries(previousContract)) {
            if (
              !Object.hasOwn(currentContract, name)
              || canonicalJson(currentContract[name]) !== canonicalJson(policy)
            ) {
              fail(`이미 등록된 contract migration 승인이 변경됐다: ${name}`);
            }
          }
          if (
            !previousRecovery
            || typeof previousRecovery !== "object"
            || Array.isArray(previousRecovery)
            || !currentRecovery
            || typeof currentRecovery !== "object"
            || Array.isArray(currentRecovery)
          ) {
            fail("activeRecovery frozen 비교 정책이 object가 아니다");
          } else {
            for (const [name, policy] of Object.entries(previousRecovery)) {
              if (
                !Object.hasOwn(currentRecovery, name)
                || canonicalJson(currentRecovery[name]) !== canonicalJson(policy)
              ) {
                fail(`이미 등록된 activeRecovery 정책이 변경됐다: ${name}`);
              }
            }
            addedRecoveryNames = Object.keys(currentRecovery)
              .filter((name) => !Object.hasOwn(previousRecovery, name));
          }
        } catch {
          fail("migration history manifest frozen 비교에 실패했다");
        }
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
          for (const name of addedRecoveryNames) {
            if (!previousNames.includes(name)) {
              fail(`activeRecovery는 배포 기준에 존재하는 migration에만 추가할 수 있다: ${name}`);
            }
          }
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
for (const name of Object.keys(manifest.approvedContractMigrations ?? {})) {
  // 이미 지워진 migration의 예외가 manifest에 남아 다음 migration을 조용히 열어 주지 않게 한다.
  if (!migrationDirectories(activeRoot).includes(name)) {
    fail(`승인된 contract migration이 실제로 없다: ${name}`);
  }
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

if (
  !manifest.activeRecovery
  || typeof manifest.activeRecovery !== "object"
  || Array.isArray(manifest.activeRecovery)
) {
  fail("activeRecovery 정책이 object가 아니다");
} else {
  for (const [name, policy] of Object.entries(manifest.activeRecovery)) {
    const keys = policy && typeof policy === "object" && !Array.isArray(policy)
      ? Object.keys(policy).sort()
      : [];
    if (keys.join(",") !== "maxRolledBackAttempts,reason,sha256") {
      fail(`activeRecovery 필드가 올바르지 않다: ${name}`);
      continue;
    }
    if (!activeNames.includes(name) || name === baselineName) {
      fail(`activeRecovery key가 실제 active migration이 아니다: ${name}`);
      continue;
    }
    const sqlPath = join(activeRoot, name, "migration.sql");
    if (!/^[a-f0-9]{64}$/.test(policy.sha256 ?? "") || sha256(sqlPath) !== policy.sha256) {
      fail(`activeRecovery checksum이 migration bytes와 다르다: ${name}`);
    }
    if (!Number.isSafeInteger(policy.maxRolledBackAttempts) || policy.maxRolledBackAttempts < 1) {
      fail(`activeRecovery maxRolledBackAttempts가 양의 정수가 아니다: ${name}`);
    }
    if (typeof policy.reason !== "string" || !policy.reason.trim()) {
      fail(`activeRecovery reason이 비어 있다: ${name}`);
    }
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
  for (const match of normalized.matchAll(
    /\b(?:INDEX|CONSTRAINT|TRIGGER)\s+`([^`]+)`/gi,
  )) {
    if (match[1].length > 64) {
      fail(`MySQL identifier가 64자를 초과한다: ${name}`);
    }
  }
  const mutationScan = stripVerifiedAppendOnlyTriggers(normalized).replace(
    /\bON\s+UPDATE\s+(?:CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL)\b/gi,
    " ",
  );
  if (
    /\b(DROP|TRUNCATE|RENAME|MODIFY|CHANGE)\b|\bDELETE\s+FROM\b|\bBEFORE\s+DELETE\b|\bUPDATE\s+/i.test(
      mutationScan,
    )
    && !approvedContractMigration(name, sqlPath)
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
