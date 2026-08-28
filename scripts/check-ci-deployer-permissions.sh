#!/usr/bin/env bash
#
# CI deployer가 data namespace에서 workload를 만들거나 바꿀 수 없음을 live로 확인한다.
# workload mutation 권한은 Pod template에 임의 Secret volume을 붙일 수 있어 그 자체가
# root secret export 경로다.
#
# 클러스터에 닿지 않으면 조용히 skip한다. 이 스크립트는 검증용이며 아무것도 바꾸지 않는다.

set -euo pipefail

kubectl_bin="${KUBECTL_BIN:-kubectl}"
namespace="${BACKOFFICE_AUDIT_NAMESPACE:-data}"
subject="${CI_DEPLOYER_SUBJECT:-system:serviceaccount:platform:ci-deployer}"

if ! "$kubectl_bin" auth can-i get configmaps -n "$namespace" >/dev/null 2>&1; then
  echo "클러스터에 닿지 않아 can-i 검증을 skip한다"
  exit 0
fi

denied=(
  "create:jobs" "patch:jobs" "update:jobs" "delete:jobs"
  "create:pods" "patch:pods" "update:pods" "delete:pods"
  "create:cronjobs" "patch:cronjobs" "update:cronjobs" "delete:cronjobs"
  "create:deployments" "patch:deployments" "update:deployments"
  "get:secrets" "list:secrets" "watch:secrets"
  "patch:configmaps" "update:configmaps" "create:configmaps" "delete:configmaps"
)

failed=0
for pair in "${denied[@]}"; do
  verb="${pair%%:*}"
  resource="${pair##*:}"
  result="$("$kubectl_bin" auth can-i "$verb" "$resource" -n "$namespace" --as="$subject" 2>&1 | head -n1 || true)"
  if [ "$result" != no ]; then
    echo "FAIL ${subject}가 ${namespace}에서 ${verb} ${resource}를 할 수 있다: ${result}" >&2
    failed=1
  fi
done

allowed=(
  "get:cronjobs"
  "get:configmaps"
)
for pair in "${allowed[@]}"; do
  verb="${pair%%:*}"
  resource="${pair##*:}"
  result="$("$kubectl_bin" auth can-i "$verb" "$resource" -n "$namespace" --as="$subject" 2>&1 | head -n1 || true)"
  echo "  info ${verb} ${resource} = ${result} (resourceName 제한 Role이면 리소스 이름 없이는 no로 보일 수 있다)"
done

if [ "$failed" -ne 0 ]; then
  echo "CI deployer 권한 경계가 깨졌다" >&2
  exit 1
fi
echo "CI deployer는 ${namespace}에서 workload를 만들거나 바꿀 수 없다"
