#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
kubectl_bin="${KUBECTL_BIN:-kubectl}"
namespace="${BACKOFFICE_NAMESPACE:-platform}"
image="${BACKOFFICE_IMAGE:-}"
source_sha="${BACKOFFICE_SOURCE_SHA:-}"
timeout="${BACKOFFICE_FLEET_PARITY_TIMEOUT_SECONDS:-1800}"
poll="${BACKOFFICE_FLEET_PARITY_POLL_SECONDS:-2}"

if [[ ! "$image" =~ ^.+@sha256:[0-9a-f]{64}$ ]]; then
  echo "오류: BACKOFFICE_IMAGE는 immutable sha256 digest여야 한다" >&2
  exit 2
fi
if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "오류: BACKOFFICE_SOURCE_SHA는 40자리 git SHA여야 한다" >&2
  exit 2
fi
if [[ ! "$timeout" =~ ^[1-9][0-9]*$ ]] || [[ ! "$poll" =~ ^[1-9][0-9]*$ ]]; then
  echo "오류: Fleet parity timeout과 poll은 양의 정수여야 한다" >&2
  exit 2
fi

job_ref="$($here/render-manifest.sh "$root/k8s/fleet-parity-wave-job.yaml" "$image" "$source_sha" \
  | "$kubectl_bin" create -f - -o name)"
job_name="${job_ref##*/}"
test -n "$job_name"
echo "fleet_parity_job=$job_name source_sha=$source_sha"

job_image="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.spec.template.spec.containers[0].image}')"
job_sha="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.metadata.labels.seorilabs\.dev/source-sha}')"
if [ "$job_image" != "$image" ] || [ "$job_sha" != "$source_sha" ]; then
  echo "오류: Fleet parity Job digest 또는 source SHA 불일치" >&2
  exit 1
fi

deadline=$((SECONDS + timeout))
conditions=""
while (( SECONDS < deadline )); do
  conditions="$($kubectl_bin -n "$namespace" get "job/$job_name" \
    -o 'jsonpath={range .status.conditions[*]}{.type}={.status}{"\n"}{end}')"
  if [[ "$conditions" == *"Complete=True"* ]]; then
    break
  fi
  if [[ "$conditions" == *"Failed=True"* ]]; then
    evidence="$($kubectl_bin -n "$namespace" logs "job/$job_name" -c parity-wave --tail=1 2>/dev/null || true)"
    if [[ "$evidence" == *'"schemaVersion":1'* && "$evidence" == *'"status":"BLOCKED"'* ]]; then
      printf '%s\n' "$evidence"
    fi
    "$kubectl_bin" -n "$namespace" get "job/$job_name" -o wide >&2 || true
    echo "오류: Fleet parity wave가 BLOCKED 또는 실패했다. 자동 재실행하지 않는다." >&2
    exit 1
  fi
  sleep "$poll"
done
if [[ "$conditions" != *"Complete=True"* ]]; then
  "$kubectl_bin" -n "$namespace" get "job/$job_name" -o wide >&2 || true
  echo "오류: Fleet parity wave timeout: ${timeout}s" >&2
  exit 1
fi
evidence="$($kubectl_bin -n "$namespace" logs "job/$job_name" -c parity-wave --tail=1)"
if ! printf '%s\n' "$evidence" | grep -q '"status":"PASSED"'; then
  echo "오류: sanitized Fleet parity evidence를 확인하지 못했다" >&2
  exit 1
fi
printf '%s\n' "$evidence"
