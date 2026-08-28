#!/usr/bin/env bash
#
# 배포 kubeconfig의 실제 권한 경계를 live로 확인한다. 아무것도 바꾸지 않는다.
#
# data namespace의 workload mutation 권한은 pod template field를 제한할 수 없어
# 임의 Secret volume(mysql-root-cred 포함)을 붙일 수 있고, 그 자체가 root secret
# export 경로다. 여기서 그런 권한이 없음을 fail-closed로 확인한다.
#
# 이 검증은 배포 kubeconfig가 설치된 뒤에만 의미가 있다. 접근 불가는 skip이 아니라
# 실패다. impersonation(--as)은 ci-deployer에 권한이 없어 쓰지 않는다.

set -euo pipefail

kubectl_bin="${KUBECTL_BIN:-kubectl}"
namespace="${BACKOFFICE_AUDIT_NAMESPACE:-data}"
expected_identity="${CI_DEPLOYER_IDENTITY:-system:serviceaccount:platform:ci-deployer}"

fail() {
  echo "오류: $*" >&2
  exit 1
}

identity="$("$kubectl_bin" auth whoami -o 'jsonpath={.status.userInfo.username}' 2>&1)" \
  || fail "kubeconfig identity를 읽지 못했다: ${identity}"
if [ "$identity" != "$expected_identity" ]; then
  fail "배포 kubeconfig identity가 다르다: expected=${expected_identity} actual=${identity:-unknown}"
fi
echo "identity=${identity}"

# resourceNames로 좁힌 Role이라 리소스 이름 없이 물으면 no가 나온다.
# 정확한 리소스로만 확인한다.
allowed=(
  "get:configmap/backoffice-provider-audit-trigger-state"
  "get:cronjob/vault-indexer"
  "get:cronjob/vault-writer"
)
denied=(
  "create:jobs" "patch:jobs" "update:jobs" "delete:jobs"
  "create:pods" "patch:pods" "update:pods" "delete:pods"
  "create:cronjobs" "delete:cronjobs"
  "patch:cronjob/vault-indexer" "update:cronjob/vault-indexer"
  "patch:cronjob/vault-writer" "update:cronjob/vault-writer"
  "create:deployments" "patch:deployments" "update:deployments"
  "get:secrets" "list:secrets" "watch:secrets"
  "get:secret/mysql-root-cred"
  "create:configmaps" "delete:configmaps"
  "patch:configmap/backoffice-provider-audit-trigger-state"
  "update:configmap/backoffice-provider-audit-trigger-state"
)

can_i() {
  "$kubectl_bin" auth can-i "$1" "$2" -n "$namespace" 2>&1 | head -n1 || true
}

failed=0
for pair in "${allowed[@]}"; do
  verb="${pair%%:*}"
  resource="${pair##*:}"
  result="$(can_i "$verb" "$resource")"
  if [ "$result" != yes ]; then
    echo "FAIL 배포에 필요한 read 권한이 없다: ${verb} ${resource} = ${result}" >&2
    failed=1
  fi
done
for pair in "${denied[@]}"; do
  verb="${pair%%:*}"
  resource="${pair##*:}"
  result="$(can_i "$verb" "$resource")"
  if [ "$result" != no ]; then
    echo "FAIL ${namespace}에서 ${verb} ${resource}가 허용된다: ${result}" >&2
    failed=1
  fi
done

[ "$failed" -eq 0 ] || fail "CI deployer 권한 경계가 깨졌다"
echo "CI deployer는 ${namespace}에서 관측만 하고 workload·secret을 만들거나 바꿀 수 없다"
