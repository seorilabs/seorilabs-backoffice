#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "오류: DATABASE_URL이 필요하다" >&2
  exit 2
fi

# 이 계약은 신규 DB 전용이다. 일부 table이 있는 DB를 baseline으로 덮지 않는다.
pnpm prisma migrate diff \
  --from-empty \
  --to-schema-datasource prisma/schema.prisma \
  --exit-code >/dev/null

pnpm prisma migrate deploy

if [ "$(pnpm tsx scripts/verify-migration-state.ts --history=predeploy)" != "fresh" ]; then
  echo "오류: baseline 적용 뒤 predeploy가 fresh 계보를 인식하지 못했다" >&2
  exit 1
fi

second_output="$(pnpm prisma migrate deploy)"
if [[ "$second_output" != *"No pending migrations to apply."* ]]; then
  echo "오류: 두 번째 migrate deploy가 no-op이 아니다" >&2
  printf '%s\n' "$second_output" >&2
  exit 1
fi

pnpm prisma migrate status >/dev/null
pnpm prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code >/dev/null
pnpm tsx scripts/verify-migration-state.ts --history=fresh
MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY \
  pnpm tsx scripts/test-fleet-agent-automation.ts
MIGRATION_FIXTURE_ACK=LOCAL_SCHEMA_ONLY \
  pnpm tsx scripts/test-migration-classifier.ts
pnpm tsx scripts/test-legacy-shadow-import.ts
pnpm tsx scripts/test-fleet-parity-wave.ts
pnpm tsx scripts/test-restore-rehearsal.ts
pnpm tsx scripts/test-repository-discovery.ts
pnpm tsx scripts/test-platform-fleet-reconciler.ts
pnpm tsx scripts/verify-migration-state.ts --history=fresh
