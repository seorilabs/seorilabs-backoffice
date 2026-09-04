#!/usr/bin/env bash

set -euo pipefail

output="${1:-}"
if [ -z "$output" ] || [ "$output" = "/" ]; then
  echo "usage: $0 OUTPUT_NODE_MODULES" >&2
  exit 2
fi
if [ "$(basename "$output")" != "node_modules" ]; then
  echo "출력 경로는 Node ESM 탐색 경계를 보존하도록 node_modules여야 한다" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_root="$root/node_modules/seorilabs-org-contracts"
if [ ! -f "$package_root/package.json" ]; then
  echo "seorilabs-org-contracts package가 설치되지 않았다" >&2
  exit 1
fi

contract_store_root="$(dirname "$(realpath "$package_root")")"
ajv_root="$(realpath "$contract_store_root/ajv")"
ajv_store_root="$(dirname "$ajv_root")"

if [ -e "$output" ]; then
  echo "runtime contract dependency 출력 경로가 이미 존재한다" >&2
  exit 1
fi
mkdir -p "$output"

copy_package() {
  local source="$1"
  local name="$2"
  if [ ! -f "$source/package.json" ]; then
    echo "runtime dependency가 설치되지 않았다: $name" >&2
    exit 1
  fi
  cp -RL "$source" "$output/$name"
}

copy_package "$package_root" seorilabs-org-contracts
copy_package "$contract_store_root/ajv" ajv
copy_package "$contract_store_root/yaml" yaml
copy_package "$ajv_store_root/fast-deep-equal" fast-deep-equal
copy_package "$ajv_store_root/fast-uri" fast-uri
copy_package "$ajv_store_root/json-schema-traverse" json-schema-traverse
copy_package "$ajv_store_root/require-from-string" require-from-string

if find "$output" -type l -print -quit | grep -q .; then
  echo "runtime contract dependency에 symlink가 남았다" >&2
  exit 1
fi

node --input-type=module - "$output" <<'NODE'
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(process.argv[2]);
await Promise.all([
  "fleet-migration.mjs",
  "fleet-migration-collector.mjs",
  "fleet-migration-legacy-validator.mjs",
  "trusted-cleanup-executor.mjs",
  "trusted-inventory-issuer.mjs",
].map((name) => import(pathToFileURL(resolve(
  root,
  "seorilabs-org-contracts/packages/repo-contract/src",
  name,
)).href)));
await import(pathToFileURL(resolve(
  root,
  "seorilabs-org-contracts/scripts/fleet/github-settings-readback.mjs",
)).href);
NODE
