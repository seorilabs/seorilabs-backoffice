#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
migration_root="${MIGRATION_ROOT:-$root/prisma/migrations}"
policy_floor="${MIGRATION_POLICY_FLOOR:-37}"

if [[ ! "$policy_floor" =~ ^[0-9]+$ ]]; then
  echo "오류: MIGRATION_POLICY_FLOOR는 정수여야 한다" >&2
  exit 2
fi

failed=0
checked=0
for directory in "$migration_root"/*; do
  [ -d "$directory" ] || continue
  name="${directory##*/}"
  prefix="${name%%_*}"
  if [[ ! "$prefix" =~ ^[0-9]+$ ]]; then
    echo "오류: 숫자 prefix가 없는 migration 디렉터리다: $name" >&2
    failed=1
    continue
  fi
  number=$((10#$prefix))
  if [ "$number" -lt "$policy_floor" ]; then
    count=0
    for candidate in "$migration_root"/*; do
      [ -d "$candidate" ] || continue
      candidate_name="${candidate##*/}"
      candidate_prefix="${candidate_name%%_*}"
      [[ "$candidate_prefix" =~ ^[0-9]+$ ]] || continue
      [ "$((10#$candidate_prefix))" -eq "$number" ] && count=$((count + 1))
    done
    expected=1
    case "$number" in
      10|18) expected=2 ;;
    esac
    if [ "$count" -ne "$expected" ]; then
      echo "오류: legacy prefix $number 개수가 변경됐다: expected=$expected actual=$count" >&2
      failed=1
    fi
    continue
  fi
  checked=$((checked + 1))

  if [[ ! "$name" =~ ^[0-9]{3}_[a-z0-9_]+$ ]]; then
    echo "오류: 신규 migration 이름은 3자리 prefix여야 한다: $name" >&2
    failed=1
  fi

  sql="$directory/migration.sql"
  if [ ! -f "$sql" ]; then
    echo "오류: migration.sql이 없다: $name" >&2
    failed=1
    continue
  fi

  normalized="$(sed -E 's/--.*$//' "$sql" | tr '\n' ' ')"
  if printf '%s\n' "$normalized" | grep -Eqi \
    '\b(DROP|TRUNCATE|RENAME|MODIFY|CHANGE|DELETE[[:space:]]+FROM|UPDATE[[:space:]])\b'; then
    echo "오류: expand-only 금지 SQL이 있다: $name" >&2
    failed=1
  fi
  if printf '%s\n' "$normalized" | grep -Eqi \
    'ALTER[[:space:]]+TABLE[^;]*ADD([[:space:]]+COLUMN)?[^;]*NOT[[:space:]]+NULL'; then
    echo "오류: 기존 writer와 호환되지 않는 NOT NULL column 추가가 있다: $name" >&2
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "destructive contract 변경은 expand/backfill/contract 단계로 분리하고 별도 승인해야 한다." >&2
  exit 1
fi
echo "migration expand-only 계약 통과: checked=$checked floor=$policy_floor"
