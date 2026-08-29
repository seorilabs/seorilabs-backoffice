#!/bin/sh

set -eu

standalone_dir="${1:-.next/standalone}"
expected_engine="libquery_engine-linux-arm64-openssl-3.0.x.so.node"
client_path='*/.prisma/client/*'

fail() {
  echo "오류: $*" >&2
  exit 1
}

[ -d "$standalone_dir" ] || fail "Next standalone 디렉터리가 없다: $standalone_dir"

# 삭제 전에 target engine이 정확히 하나 있는지 확인한다. generate/trace가 바뀌었을 때
# host engine만 지운 채 불완전한 runtime 이미지를 만들지 않고 fail-closed한다.
expected_count="$(find "$standalone_dir" \
  -type f \
  -path "$client_path" \
  -name "$expected_engine" \
  -print \
  | wc -l \
  | tr -d '[:space:]')"
[ "$expected_count" = 1 ] \
  || fail "ARM64 Prisma query engine은 정확히 하나여야 한다: count=$expected_count"

expected_path="$(find "$standalone_dir" \
  -type f \
  -path "$client_path" \
  -name "$expected_engine" \
  -print)"
[ -s "$expected_path" ] || fail "ARM64 Prisma query engine이 비어 있다"

# Prisma Client가 만든 query/schema engine만 대상으로 한다. sharp나 다른 native
# addon까지 포괄하는 확장자 glob은 사용하지 않는다. 승인된 target은 보존한다.
non_regular_engine="$(find "$standalone_dir" \
  -path "$client_path" \
  \( -name 'libquery_engine-*' -o -name 'query-engine-*' -o -name 'schema-engine-*' \) \
  ! -type f \
  -print \
  -quit)"
[ -z "$non_regular_engine" ] \
  || fail "일반 파일이 아닌 Prisma engine을 발견했다: $non_regular_engine"

find "$standalone_dir" \
  -type f \
  -path "$client_path" \
  \( -name 'libquery_engine-*' -o -name 'query-engine-*' -o -name 'schema-engine-*' \) \
  ! -name "$expected_engine" \
  -delete

unexpected_engine="$(find "$standalone_dir" \
  -path "$client_path" \
  \( -name 'libquery_engine-*' -o -name 'query-engine-*' -o -name 'schema-engine-*' \) \
  ! -name "$expected_engine" \
  -print \
  -quit)"
[ -z "$unexpected_engine" ] \
  || fail "승인되지 않은 Prisma query/schema engine이 남았다: $unexpected_engine"

remaining_count="$(find "$standalone_dir" \
  -type f \
  -path "$client_path" \
  -name "$expected_engine" \
  -print \
  | wc -l \
  | tr -d '[:space:]')"
[ "$remaining_count" = 1 ] \
  || fail "정리 후 ARM64 Prisma query engine이 보존되지 않았다: count=$remaining_count"

echo "prisma_runtime_engine=$expected_engine"
