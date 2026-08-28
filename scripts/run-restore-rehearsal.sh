#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
kubectl_bin="${KUBECTL_BIN:-kubectl}"
namespace="${BACKOFFICE_NAMESPACE:-platform}"
image="${BACKOFFICE_IMAGE:-}"
source_sha="${BACKOFFICE_SOURCE_SHA:-}"
dump_basename="${BACKOFFICE_RESTORE_DUMP_BASENAME:-}"
timeout="${BACKOFFICE_RESTORE_TIMEOUT_SECONDS:-1800}"
poll="${BACKOFFICE_RESTORE_POLL_SECONDS:-2}"

if [[ ! "$image" =~ ^.+@sha256:[0-9a-f]{64}$ ]]; then
  echo "오류: BACKOFFICE_IMAGE는 immutable sha256 digest여야 한다" >&2
  exit 2
fi
if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "오류: BACKOFFICE_SOURCE_SHA는 40자리 git SHA여야 한다" >&2
  exit 2
fi
if [[ ! "$dump_basename" =~ ^backoffice-[0-9]{8}T[0-9]{6}Z\.sql\.gz$ ]]; then
  echo "오류: BACKOFFICE_RESTORE_DUMP_BASENAME 형식이 올바르지 않다" >&2
  exit 2
fi
if [[ ! "$timeout" =~ ^[1-9][0-9]*$ ]] || [[ ! "$poll" =~ ^[1-9][0-9]*$ ]]; then
  echo "오류: restore timeout과 poll은 양의 정수여야 한다" >&2
  exit 2
fi

rendered="$($here/render-restore-rehearsal.sh \
  "$root/k8s/restore-rehearsal-job.yaml" "$image" "$source_sha" "$dump_basename")"
job_ref="$(printf '%s\n' "$rendered" | "$kubectl_bin" create -f - -o name)"
job_name="${job_ref##*/}"
test -n "$job_name"
echo "restore_rehearsal_job=$job_name source_sha=$source_sha dump=$dump_basename"

deadline=$((SECONDS + timeout))
conditions=""
while (( SECONDS < deadline )); do
  conditions="$($kubectl_bin -n "$namespace" get "job/$job_name" \
    -o 'jsonpath={range .status.conditions[*]}{.type}={.status}{"\n"}{end}')"
  if [[ "$conditions" == *"Complete=True"* ]]; then
    break
  fi
  if [[ "$conditions" == *"Failed=True"* ]]; then
    "$kubectl_bin" -n "$namespace" get "job/$job_name" -o wide >&2 || true
    echo "오류: restore rehearsal Job 실패. secret 보호를 위해 자동 로그 출력은 하지 않는다." >&2
    exit 1
  fi
  sleep "$poll"
done
if [[ "$conditions" != *"Complete=True"* ]]; then
  "$kubectl_bin" -n "$namespace" get "job/$job_name" -o wide >&2 || true
  echo "오류: restore rehearsal Job timeout: ${timeout}s" >&2
  exit 1
fi

job_image="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.spec.template.spec.containers[2].image}')"
job_sha="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.metadata.labels.seorilabs\.dev/source-sha}')"
if [ "$job_image" != "$image" ] || [ "$job_sha" != "$source_sha" ]; then
  echo "오류: restore rehearsal Job digest 또는 source SHA 불일치" >&2
  exit 1
fi

# verify container는 고정 코드만 출력하며 DB URL·password·signing key를 출력하지 않는다.
evidence="$($kubectl_bin -n "$namespace" logs "job/$job_name" -c verify --tail=1)"
if ! printf '%s\n' "$evidence" | grep -q '"status":"PASSED"'; then
  echo "오류: sanitized restore evidence를 확인하지 못했다" >&2
  exit 1
fi
printf '%s\n' "$evidence"
