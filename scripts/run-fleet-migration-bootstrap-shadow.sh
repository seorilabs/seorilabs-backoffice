#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
kubectl_bin="${KUBECTL_BIN:-kubectl}"
namespace="${BACKOFFICE_NAMESPACE:-platform}"
image="${BACKOFFICE_IMAGE:-}"
source_sha="${BACKOFFICE_SOURCE_SHA:-}"
detector_sha="${FLEET_MIGRATION_DETECTOR_SOURCE_SHA:-}"
timeout="${BACKOFFICE_FLEET_BOOTSTRAP_TIMEOUT_SECONDS:-3600}"

if [[ ! "$image" =~ ^.+@sha256:[0-9a-f]{64}$ ]]; then
  echo "오류: BACKOFFICE_IMAGE는 immutable sha256 digest여야 한다" >&2
  exit 2
fi
if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "오류: BACKOFFICE_SOURCE_SHA는 40자리 git SHA여야 한다" >&2
  exit 2
fi
if [[ ! "$detector_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "오류: FLEET_MIGRATION_DETECTOR_SOURCE_SHA는 40자리 git SHA여야 한다" >&2
  exit 2
fi
if [[ ! "$timeout" =~ ^[1-9][0-9]*$ ]]; then
  echo "오류: BACKOFFICE_FLEET_BOOTSTRAP_TIMEOUT_SECONDS는 양의 정수여야 한다" >&2
  exit 2
fi

job_ref="$($here/render-manifest.sh "$root/k8s/fleet-migration-bootstrap-shadow-job.yaml" "$image" "$source_sha" \
  | sed "s|__FLEET_MIGRATION_DETECTOR_SOURCE_SHA__|$detector_sha|g" \
  | "$kubectl_bin" create -f - -o name)"
job_name="${job_ref##*/}"
test -n "$job_name"
echo "fleet_bootstrap_job=$job_name source_sha=$source_sha detector_sha=$detector_sha"

job_image="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.spec.template.spec.containers[0].image}')"
job_sha="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.metadata.labels.seorilabs\.dev/source-sha}')"
job_detector="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="FLEET_MIGRATION_DETECTOR_SOURCE_SHA")].value}')"
job_memory="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.spec.template.spec.containers[0].resources.limits.memory}')"
job_suspended="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.spec.suspend}')"
if [ "$job_image" != "$image" ] || [ "$job_sha" != "$source_sha" ] || [ "$job_detector" != "$detector_sha" ] || [ "$job_memory" != "2Gi" ] || [ "$job_suspended" != "true" ]; then
  echo "오류: BOOTSTRAP Job image/source/detector/memory binding 불일치" >&2
  exit 1
fi
if [ -n "$($kubectl_bin -n "$namespace" get pods -l "job-name=$job_name" -o 'jsonpath={.items[0].metadata.name}')" ]; then
  echo "오류: binding 검증 전 suspended BOOTSTRAP Job에 Pod가 생겼다" >&2
  exit 1
fi
$kubectl_bin -n "$namespace" patch "job/$job_name" --type=merge -p '{"spec":{"suspend":false}}' >/dev/null
if [ "$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.spec.suspend}')" != "false" ]; then
  echo "오류: 검증된 BOOTSTRAP Job을 시작하지 못했다" >&2
  exit 1
fi

deadline=$(( $(date +%s) + timeout ))
terminal=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  complete="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.status.conditions[?(@.type=="Complete")].status}')"
  failed="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.status.conditions[?(@.type=="Failed")].status}')"
  if [ "$complete" = "True" ]; then terminal="complete"; break; fi
  if [ "$failed" = "True" ]; then terminal="failed"; break; fi
  sleep 5
done
if [ -z "$terminal" ]; then
  echo "오류: BOOTSTRAP shadow terminal 상태 timeout. 자동 재실행하지 않는다." >&2
  exit 1
fi
if [ "$terminal" = "failed" ]; then
  pod_name="$($kubectl_bin -n "$namespace" get pods -l "job-name=$job_name" -o 'jsonpath={.items[0].metadata.name}')"
  reason="$($kubectl_bin -n "$namespace" get "pod/$pod_name" -o 'jsonpath={.status.containerStatuses[0].state.terminated.reason}')"
  exit_code="$($kubectl_bin -n "$namespace" get "pod/$pod_name" -o 'jsonpath={.status.containerStatuses[0].state.terminated.exitCode}')"
  echo "오류: BOOTSTRAP shadow failed reason=$reason exit_code=$exit_code. 동일 Job을 반복하지 않는다." >&2
  exit 1
fi

evidence="$($kubectl_bin -n "$namespace" logs "job/$job_name" -c bootstrap-shadow --tail=1)"
if ! printf '%s\n' "$evidence" | grep -q '"state":"SHADOW_COMPLETE"'; then
  echo "오류: durable occurrence terminal readback을 확인하지 못했다" >&2
  exit 1
fi
printf '%s\n' "$evidence"
