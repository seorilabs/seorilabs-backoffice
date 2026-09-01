#!/usr/bin/env bash

# Trusted operator only. P6 egress proxy를 replicas=0 support state로 먼저
# 수렴시키고, exact source/image canary 한 건을 통과한 경우에만 replica 1을 남긴다.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
kubectl_bin="${KUBECTL_BIN:-kubectl}"
image="${BACKOFFICE_IMAGE:-}"
source_sha="${BACKOFFICE_SOURCE_SHA:-}"
confirmation="${SEORI_EGRESS_CANARY_CONFIRM_SHA:-}"
namespace=auth-broker
deployment=seori-auth-egress-proxy
expected_log='{"state":"CANARY_OK","secretExposed":false,"positive":1,"rejected":5,"redirectRejected":1}'

if [[ ! "$image" =~ ^.+@sha256:[0-9a-f]{64}$ ]] || [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "오류: immutable BACKOFFICE_IMAGE와 40자리 BACKOFFICE_SOURCE_SHA가 필요하다" >&2
  exit 2
fi
if [ "$confirmation" != "$source_sha" ]; then
  echo "오류: SEORI_EGRESS_CANARY_CONFIRM_SHA가 exact source SHA와 같아야 한다" >&2
  exit 2
fi

tmp="$(mktemp -d)"
activated=false
complete=false
cleanup() {
  if [ "$activated" = true ] && [ "$complete" != true ]; then
    "$kubectl_bin" -n "$namespace" scale deployment "$deployment" --replicas=0 >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

"$here/render-manifest.sh" "$root/k8s/seori-auth-egress-proxy.yaml" "$image" "$source_sha" > "$tmp/proxy.yaml"
"$here/render-manifest.sh" "$root/k8s/seori-auth-egress-canary-job.yaml" "$image" "$source_sha" > "$tmp/canary.yaml"
"$kubectl_bin" apply --dry-run=server -f "$tmp/proxy.yaml" >/dev/null
"$kubectl_bin" apply --dry-run=server -f "$tmp/canary.yaml" >/dev/null

if "$kubectl_bin" -n "$namespace" get deployment "$deployment" >/dev/null 2>&1; then
  replicas="$($kubectl_bin -n "$namespace" get deployment "$deployment" -o 'jsonpath={.spec.replicas}')"
  if [ "${replicas:-0}" != 0 ]; then
    echo "오류: 기존 egress proxy가 replicas=0이 아니므로 자동 변경하지 않는다" >&2
    exit 1
  fi
fi

"$kubectl_bin" apply -f "$tmp/proxy.yaml" >/dev/null
for certificate in \
  seori-auth-egress-proxy-tls \
  seori-auth-agent-egress-tls \
  workflow-bundle-candidate-egress-tls \
  seori-auth-egress-canary-tls; do
  "$kubectl_bin" -n "$namespace" wait --for=condition=Ready "certificate/$certificate" --timeout=120s >/dev/null
done

"$kubectl_bin" -n "$namespace" scale deployment "$deployment" --replicas=1 >/dev/null
activated=true
"$kubectl_bin" -n "$namespace" rollout status "deployment/$deployment" --timeout=180s >/dev/null
state="$($kubectl_bin -n "$namespace" get deployment "$deployment" -o json | jq -r '
  [(.spec.replicas // 0),(.status.readyReplicas // 0),.spec.template.spec.serviceAccountName,
   .spec.template.spec.automountServiceAccountToken,.spec.template.spec.containers[0].image] | @tsv')"
if [ "$state" != $'1\t1\tseori-auth-egress-proxy\tfalse\t'"$image" ]; then
  echo "오류: egress proxy exact runtime readback 불일치" >&2
  exit 1
fi

"$kubectl_bin" apply -f "$tmp/canary.yaml" >/dev/null
job="seori-auth-egress-canary-${source_sha:0:12}"
if ! "$kubectl_bin" -n "$namespace" wait --for=condition=Complete "job/$job" --timeout=180s >/dev/null; then
  echo "오류: egress canary Job이 완료되지 않았다" >&2
  exit 1
fi
pod="$($kubectl_bin -n "$namespace" get pod -l "job-name=$job" -o json | jq -r '
  if (.items | length) == 1 then .items[0].metadata.name else empty end')"
if [ -z "$pod" ]; then
  echo "오류: egress canary Pod exact readback 실패" >&2
  exit 1
fi
pod_state="$($kubectl_bin -n "$namespace" get pod "$pod" -o json | jq -r '
  [.spec.nodeName,.spec.serviceAccountName,.spec.automountServiceAccountToken,
   .spec.containers[0].image,.status.containerStatuses[0].state.terminated.exitCode] | @tsv')"
if [ "$pod_state" != $'rpi5\tseori-auth-egress-canary\tfalse\t'"$image"$'\t0' ]; then
  echo "오류: egress canary admitted Pod identity 불일치" >&2
  exit 1
fi
observed_log="$($kubectl_bin -n "$namespace" logs "$pod" --container=canary)"
if [ "$observed_log" != "$expected_log" ]; then
  echo "오류: egress canary 공개 결과가 exact 계약과 다르다" >&2
  exit 1
fi

complete=true
printf 'egress_proxy=READY source_sha=%s job=%s\n' "$source_sha" "$job"
