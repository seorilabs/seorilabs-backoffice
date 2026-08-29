#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

prepare_case() {
  local name="$1"
  mkdir -p "$tmp/$name"
  cp -R "$root/prisma" "$tmp/$name/prisma"
}

expect_failure() {
  local name="$1"
  if REPOSITORY_ROOT="$tmp/$name" "$here/check-migration-safety.sh" \
    >/dev/null 2>&1; then
    echo "FAIL $name case가 통과했다" >&2
    exit 1
  fi
}

"$here/check-migration-safety.sh" >/dev/null

prepare_case archive_modified
printf '\n-- modified\n' >> \
  "$tmp/archive_modified/prisma/migration-archive/legacy-v1/0_init/migration.sql"
expect_failure archive_modified

prepare_case archive_renamed
mv "$tmp/archive_renamed/prisma/migration-archive/legacy-v1/0_init" \
  "$tmp/archive_renamed/prisma/migration-archive/legacy-v1/0_init_renamed"
expect_failure archive_renamed

prepare_case baseline_modified
printf '\n-- modified\n' >> \
  "$tmp/baseline_modified/prisma/migrations/00000000000000_squashed_migrations/migration.sql"
expect_failure baseline_modified

prepare_case active_recovery_unknown
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.activeRecovery.unknown_migration = {
    sha256: "a".repeat(64), maxRolledBackAttempts: 1, reason: "test",
  };
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$tmp/active_recovery_unknown/prisma/migration-history.json"
expect_failure active_recovery_unknown

prepare_case active_recovery_checksum
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.activeRecovery["20260828230000_provider_execution_queue"].sha256 = "a".repeat(64);
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$tmp/active_recovery_checksum/prisma/migration-history.json"
expect_failure active_recovery_checksum

prepare_case active_recovery_attempts
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.activeRecovery["20260828230000_provider_execution_queue"].maxRolledBackAttempts = 0;
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$tmp/active_recovery_attempts/prisma/migration-history.json"
expect_failure active_recovery_attempts

prepare_case active_recovery_reason
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.activeRecovery["20260828230000_provider_execution_queue"].reason = "  ";
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$tmp/active_recovery_reason/prisma/migration-history.json"
expect_failure active_recovery_reason

prepare_case unpadded
mkdir -p "$tmp/unpadded/prisma/migrations/2026082712000_unpadded"
printf "CREATE TABLE \`new_table\` (\`id\` VARCHAR(32) NOT NULL);\n" > \
  "$tmp/unpadded/prisma/migrations/2026082712000_unpadded/migration.sql"
expect_failure unpadded

prepare_case duplicate_prefix
for suffix in first second; do
  mkdir -p "$tmp/duplicate_prefix/prisma/migrations/20260827120000_${suffix}"
  printf "CREATE TABLE \`%s_table\` (\`id\` VARCHAR(32) NOT NULL);\n" "$suffix" > \
    "$tmp/duplicate_prefix/prisma/migrations/20260827120000_${suffix}/migration.sql"
done
expect_failure duplicate_prefix

prepare_case destructive
mkdir -p "$tmp/destructive/prisma/migrations/20260827120001_drop_legacy"
printf "DROP TABLE \`legacy\`;\n" > \
  "$tmp/destructive/prisma/migrations/20260827120001_drop_legacy/migration.sql"
expect_failure destructive

prepare_case destructive_update
mkdir -p "$tmp/destructive_update/prisma/migrations/20260827120004_update_data"
printf "WITH candidates AS (SELECT 1) UPDATE \`app\` SET \`status\` = 'PAUSED';\n" > \
  "$tmp/destructive_update/prisma/migrations/20260827120004_update_data/migration.sql"
expect_failure destructive_update

prepare_case destructive_update_cascade
mkdir -p "$tmp/destructive_update_cascade/prisma/migrations/20260827120006_update_data"
printf "UPDATE CASCADE SET \`status\` = 'PAUSED';\n" > \
  "$tmp/destructive_update_cascade/prisma/migrations/20260827120006_update_data/migration.sql"
expect_failure destructive_update_cascade

prepare_case unsafe_trigger
mkdir -p "$tmp/unsafe_trigger/prisma/migrations/20260827120007_unsafe_trigger"
printf '%s\n' \
  "CREATE TRIGGER \`control_plane_provider_execution_event_no_delete\`" \
  "BEFORE DELETE ON \`other_table\`" \
  "FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'provider execution audit is append-only';" > \
  "$tmp/unsafe_trigger/prisma/migrations/20260827120007_unsafe_trigger/migration.sql"
expect_failure unsafe_trigger

prepare_case identifier_too_long
mkdir -p "$tmp/identifier_too_long/prisma/migrations/20260827120008_long_identifier"
printf '%s\n' \
  'CREATE TABLE `identifier_test` (`id` VARCHAR(32) NOT NULL,' \
  'INDEX `this_mysql_index_identifier_is_deliberately_longer_than_sixty_four_chars_total` (`id`));' > \
  "$tmp/identifier_too_long/prisma/migrations/20260827120008_long_identifier/migration.sql"
expect_failure identifier_too_long

prepare_case valid_foreign_key
mkdir -p "$tmp/valid_foreign_key/prisma/migrations/20260827120005_add_fk"
printf '%s\n' \
  "CREATE TABLE \`child\` (\`id\` VARCHAR(32) NOT NULL, \`appId\` VARCHAR(191) NOT NULL);" \
  "ALTER TABLE \`child\` ADD CONSTRAINT \`child_appId_fkey\` FOREIGN KEY (\`appId\`) REFERENCES \`app\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;" > \
  "$tmp/valid_foreign_key/prisma/migrations/20260827120005_add_fk/migration.sql"
REPOSITORY_ROOT="$tmp/valid_foreign_key" "$here/check-migration-safety.sh" >/dev/null

prepare_case valid
mkdir -p "$tmp/valid/prisma/migrations/20260827120002_add_observation"
printf "ALTER TABLE \`app\` ADD COLUMN \`observedAt\` DATETIME(3) NULL;\n" > \
  "$tmp/valid/prisma/migrations/20260827120002_add_observation/migration.sql"
REPOSITORY_ROOT="$tmp/valid" "$here/check-migration-safety.sh" >/dev/null

prepare_case frozen_active
git -C "$tmp/frozen_active" init -q
git -C "$tmp/frozen_active" config user.name migration-contract
git -C "$tmp/frozen_active" config user.email migration-contract@localhost
git -C "$tmp/frozen_active" add prisma
git -C "$tmp/frozen_active" commit -qm baseline
frozen_base="$(git -C "$tmp/frozen_active" rev-parse HEAD)"
mkdir -p "$tmp/frozen_active/prisma/migrations/99999999999997_existing_expand"
printf "ALTER TABLE \`app\` ADD COLUMN \`firstObservedAt\` DATETIME(3) NULL;\n" > \
  "$tmp/frozen_active/prisma/migrations/99999999999997_existing_expand/migration.sql"
git -C "$tmp/frozen_active" add prisma
git -C "$tmp/frozen_active" commit -qm additive
MIGRATION_FROZEN_BASE="$frozen_base" REPOSITORY_ROOT="$tmp/frozen_active" \
  "$here/check-migration-safety.sh" >/dev/null

prepare_case frozen_recovery_addition
git -C "$tmp/frozen_recovery_addition" init -q
git -C "$tmp/frozen_recovery_addition" config user.name migration-contract
git -C "$tmp/frozen_recovery_addition" config user.email migration-contract@localhost
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.activeRecovery = {};
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$tmp/frozen_recovery_addition/prisma/migration-history.json"
git -C "$tmp/frozen_recovery_addition" add prisma
git -C "$tmp/frozen_recovery_addition" commit -qm baseline
recovery_base="$(git -C "$tmp/frozen_recovery_addition" rev-parse HEAD)"
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.activeRecovery["20260828230000_provider_execution_queue"] = {
    sha256: "f4e7711ecd3e0c92105640498d17bbc1606801b957febe5c871260f7e7a7cbeb",
    maxRolledBackAttempts: 1,
    reason: "verified production recovery",
  };
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$tmp/frozen_recovery_addition/prisma/migration-history.json"
git -C "$tmp/frozen_recovery_addition" add prisma
git -C "$tmp/frozen_recovery_addition" commit -qm recovery
MIGRATION_FROZEN_BASE="$recovery_base" \
  REPOSITORY_ROOT="$tmp/frozen_recovery_addition" \
  "$here/check-migration-safety.sh" >/dev/null
recovery_deployed_base="$(git -C "$tmp/frozen_recovery_addition" rev-parse HEAD)"

node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.activeRecovery["20260828230000_provider_execution_queue"].reason =
    "rewritten recovery";
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$tmp/frozen_recovery_addition/prisma/migration-history.json"
git -C "$tmp/frozen_recovery_addition" add prisma
git -C "$tmp/frozen_recovery_addition" commit -qm rewritten-recovery
if MIGRATION_FROZEN_BASE="$recovery_deployed_base" \
  REPOSITORY_ROOT="$tmp/frozen_recovery_addition" \
  "$here/check-migration-safety.sh" >/dev/null 2>&1; then
  echo "FAIL 이미 등록된 activeRecovery 변경이 통과했다" >&2
  exit 1
fi

prepare_case frozen_recovery_for_new_migration
git -C "$tmp/frozen_recovery_for_new_migration" init -q
git -C "$tmp/frozen_recovery_for_new_migration" config user.name migration-contract
git -C "$tmp/frozen_recovery_for_new_migration" config user.email migration-contract@localhost
git -C "$tmp/frozen_recovery_for_new_migration" add prisma
git -C "$tmp/frozen_recovery_for_new_migration" commit -qm baseline
new_recovery_base="$(git -C "$tmp/frozen_recovery_for_new_migration" rev-parse HEAD)"
mkdir -p "$tmp/frozen_recovery_for_new_migration/prisma/migrations/99999999999998_new_recovery"
printf "ALTER TABLE \`app\` ADD COLUMN \`secondObservedAt\` DATETIME(3) NULL;\n" > \
  "$tmp/frozen_recovery_for_new_migration/prisma/migrations/99999999999998_new_recovery/migration.sql"
node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const manifestPath = process.argv[1];
  const migrationPath = process.argv[2];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.activeRecovery["99999999999998_new_recovery"] = {
    sha256: crypto.createHash("sha256").update(fs.readFileSync(migrationPath)).digest("hex"),
    maxRolledBackAttempts: 1,
    reason: "must not be preapproved",
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
' \
  "$tmp/frozen_recovery_for_new_migration/prisma/migration-history.json" \
  "$tmp/frozen_recovery_for_new_migration/prisma/migrations/99999999999998_new_recovery/migration.sql"
git -C "$tmp/frozen_recovery_for_new_migration" add prisma
git -C "$tmp/frozen_recovery_for_new_migration" commit -qm invalid-new-recovery
if MIGRATION_FROZEN_BASE="$new_recovery_base" \
  REPOSITORY_ROOT="$tmp/frozen_recovery_for_new_migration" \
  "$here/check-migration-safety.sh" >/dev/null 2>&1; then
  echo "FAIL 같은 변경에서 추가한 migration의 activeRecovery가 통과했다" >&2
  exit 1
fi

prepare_case frozen_out_of_order
git -C "$tmp/frozen_out_of_order" init -q
git -C "$tmp/frozen_out_of_order" config user.name migration-contract
git -C "$tmp/frozen_out_of_order" config user.email migration-contract@localhost
git -C "$tmp/frozen_out_of_order" add prisma
git -C "$tmp/frozen_out_of_order" commit -qm baseline
out_of_order_base="$(git -C "$tmp/frozen_out_of_order" rev-parse HEAD)"
mkdir -p "$tmp/frozen_out_of_order/prisma/migrations/20260828050000_late_merge"
printf "CREATE TABLE \`late_merge\` (\`id\` VARCHAR(32) NOT NULL);\n" > \
  "$tmp/frozen_out_of_order/prisma/migrations/20260828050000_late_merge/migration.sql"
git -C "$tmp/frozen_out_of_order" add prisma
git -C "$tmp/frozen_out_of_order" commit -qm out-of-order
if MIGRATION_FROZEN_BASE="$out_of_order_base" REPOSITORY_ROOT="$tmp/frozen_out_of_order" \
  "$here/check-migration-safety.sh" >/dev/null 2>&1; then
  echo "FAIL 이전 migration보다 작은 이름의 새 migration이 통과했다" >&2
  exit 1
fi

deployed_base="$(git -C "$tmp/frozen_active" rev-parse HEAD)"
printf "ALTER TABLE \`app\` ADD COLUMN \`changedObservedAt\` DATETIME(3) NULL;\n" > \
  "$tmp/frozen_active/prisma/migrations/99999999999997_existing_expand/migration.sql"
git -C "$tmp/frozen_active" add prisma
git -C "$tmp/frozen_active" commit -qm rewritten
if MIGRATION_FROZEN_BASE="$deployed_base" REPOSITORY_ROOT="$tmp/frozen_active" \
  "$here/check-migration-safety.sh" >/dev/null 2>&1; then
  echo "FAIL 이미 배포된 active migration 변경이 통과했다" >&2
  exit 1
fi

# ── 승인된 contract migration 예외 ────────────────────────────────────────────
# 예외는 이름 + bytes checksum + 사유 셋이 모두 맞을 때만 열린다. 하나라도 어긋나면
# expand-only 게이트가 다시 닫혀야 폐기 SQL이 조용히 섞여 들어가지 않는다.
approved_name=20260830010000_drop_retired_teammate_schema

prepare_case contract_unapproved
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  delete manifest.approvedContractMigrations;
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$tmp/contract_unapproved/prisma/migration-history.json"
expect_failure contract_unapproved

prepare_case contract_checksum
printf '\n-- drift\n' >> \
  "$tmp/contract_checksum/prisma/migrations/$approved_name/migration.sql"
expect_failure contract_checksum

prepare_case contract_reason_blank
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const name = process.argv[2];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.approvedContractMigrations[name].reason = "   ";
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$tmp/contract_reason_blank/prisma/migration-history.json" "$approved_name"
expect_failure contract_reason_blank

prepare_case contract_stale_entry
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.approvedContractMigrations["99999999999996_gone"] = {
    sha256: "a".repeat(64), reason: "이미 사라진 migration",
  };
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$tmp/contract_stale_entry/prisma/migration-history.json"
expect_failure contract_stale_entry

# 승인되지 않은 다른 migration은 예외 등록이 있어도 여전히 막힌다.
prepare_case contract_scope_leak
mkdir -p "$tmp/contract_scope_leak/prisma/migrations/99999999999995_other_drop"
printf "DROP TABLE \`app_owner\`;\n" > \
  "$tmp/contract_scope_leak/prisma/migrations/99999999999995_other_drop/migration.sql"
expect_failure contract_scope_leak

# 이미 배포된 contract 예외는 frozen base 비교에서 동결된다. 뒤에서 checksum 만
# 바꿔치면 다른 migration 의 DROP 이 열릴 수 있으므로 변경 자체를 막는다.
prepare_case contract_frozen_mutation
git -C "$tmp/contract_frozen_mutation" init -q
git -C "$tmp/contract_frozen_mutation" add prisma
git -C "$tmp/contract_frozen_mutation" -c user.email=t@t -c user.name=t commit -qm base
contract_base="$(git -C "$tmp/contract_frozen_mutation" rev-parse HEAD)"
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const name = process.argv[2];
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.approvedContractMigrations[name].reason = "사후 변경";
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
' "$tmp/contract_frozen_mutation/prisma/migration-history.json" "$approved_name"
git -C "$tmp/contract_frozen_mutation" add prisma
git -C "$tmp/contract_frozen_mutation" -c user.email=t@t -c user.name=t commit -qm mutate
if MIGRATION_FROZEN_BASE="$contract_base" \
  REPOSITORY_ROOT="$tmp/contract_frozen_mutation" \
  "$here/check-migration-safety.sh" >/dev/null 2>&1; then
  echo "FAIL 이미 등록된 contract 승인 변경이 통과했다" >&2
  exit 1
fi

echo "migration safety 계약 통과"
