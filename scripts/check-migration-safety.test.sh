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

echo "migration safety 계약 통과"
