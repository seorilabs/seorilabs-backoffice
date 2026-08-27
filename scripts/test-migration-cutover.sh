#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "오류: DATABASE_URL이 필요하다" >&2
  exit 2
fi

pnpm prisma db execute \
  --file prisma/migrations/00000000000000_squashed_migrations/migration.sql \
  --schema prisma/schema.prisma
MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY \
  pnpm tsx scripts/seed-legacy-migration-fixture.ts

before="$(pnpm tsx scripts/verify-migration-state.ts \
  --history=legacy --print-data-fingerprint | tail -n 1)"
preflight_log="$(mktemp)"
trap 'rm -f "$preflight_log"' EXIT
if pnpm tsx scripts/verify-migration-state.ts --history=predeploy \
  >"$preflight_log" 2>&1; then
  echo "오류: baseline resolve 전 predeploy가 통과했다" >&2
  exit 1
fi
if ! grep -q 'BASELINE_RESOLVE_REQUIRED' "$preflight_log"; then
  echo "오류: resolve 전 실패 원인이 예상과 다르다" >&2
  exit 1
fi

pnpm prisma migrate resolve \
  --applied 00000000000000_squashed_migrations
if [ "$(pnpm tsx scripts/verify-migration-state.ts --history=predeploy)" != "cutover" ]; then
  echo "오류: resolve 뒤 predeploy가 cutover로 분류되지 않았다" >&2
  exit 1
fi

pnpm prisma migrate deploy
pnpm prisma migrate deploy
pnpm prisma migrate status >/dev/null
after="$(pnpm tsx scripts/verify-migration-state.ts \
  --history=cutover --print-data-fingerprint | tail -n 1)"
if [ "$before" != "$after" ]; then
  echo "오류: baseline resolve 과정에서 application row count가 바뀌었다" >&2
  exit 1
fi
pnpm prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code >/dev/null
MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY \
  pnpm tsx scripts/test-migration-lineage-loss.ts

echo "legacy → baseline cutover 계약 통과"
