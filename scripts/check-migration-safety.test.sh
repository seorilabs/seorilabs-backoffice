#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/037_add_observation"
printf "ALTER TABLE \`app\` ADD COLUMN \`observedAt\` DATETIME(3) NULL;\n" \
  > "$tmp/037_add_observation/migration.sql"
MIGRATION_ROOT="$tmp" "$here/check-migration-safety.sh" >/dev/null

mkdir -p "$tmp/038_drop_legacy"
printf "DROP TABLE \`legacy\`;\n" > "$tmp/038_drop_legacy/migration.sql"
if MIGRATION_ROOT="$tmp" "$here/check-migration-safety.sh" >/dev/null 2>&1; then
  echo "FAIL destructive migration이 통과했다" >&2
  exit 1
fi

rm -rf "$tmp/038_drop_legacy"
mkdir -p "$tmp/39_unpadded"
printf "CREATE TABLE \`new_table\` (\`id\` VARCHAR(32) NOT NULL);\n" \
  > "$tmp/39_unpadded/migration.sql"
if MIGRATION_ROOT="$tmp" "$here/check-migration-safety.sh" >/dev/null 2>&1; then
  echo "FAIL unpadded migration이 통과했다" >&2
  exit 1
fi

rm -rf "$tmp/39_unpadded"
mkdir -p "$tmp/custom_migration"
printf "CREATE TABLE \`custom\` (\`id\` VARCHAR(32) NOT NULL);\n" \
  > "$tmp/custom_migration/migration.sql"
if MIGRATION_ROOT="$tmp" "$here/check-migration-safety.sh" >/dev/null 2>&1; then
  echo "FAIL 숫자 prefix 없는 migration이 통과했다" >&2
  exit 1
fi

echo "migration safety 계약 통과"
