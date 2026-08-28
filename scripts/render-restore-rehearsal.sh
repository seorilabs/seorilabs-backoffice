#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "사용법: $0 <매니페스트> <immutable-image> <source-sha> <dump-basename>" >&2
  exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
manifest="$1"
image="$2"
source_sha="$3"
dump_basename="$4"

if [[ ! "$dump_basename" =~ ^backoffice-[0-9]{8}T[0-9]{6}Z\.sql\.gz$ ]]; then
  echo "오류: dump basename 형식이 올바르지 않다" >&2
  exit 2
fi
if ! grep -q '__BACKOFFICE_RESTORE_DUMP_BASENAME__' "$manifest"; then
  echo "오류: restore dump placeholder가 없다" >&2
  exit 1
fi

"$here/render-manifest.sh" "$manifest" "$image" "$source_sha" \
  | sed "s|__BACKOFFICE_RESTORE_DUMP_BASENAME__|${dump_basename}|g"
