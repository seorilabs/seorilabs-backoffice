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

# can-i는 이름 없는 질문이 no로 나와도 named 권한이 남아 있을 수 있어 "0건"을 증명하지
# 못한다. 그래서 현재 identity의 data namespace 전체 규칙을 SelfSubjectRulesReview로 읽어
# 금지 조합이 하나도 없음을 확인한다. 이 review는 read-only이며 지속 리소스를 만들지 않는다.
rules="$(printf '%s' \
  '{"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectRulesReview","spec":{"namespace":"'"$namespace"'"}}' \
  | "$kubectl_bin" create -f - -o 'jsonpath={.status.incomplete}{"\n"}{range .status.resourceRules[*]}{.verbs}|{.apiGroups}|{.resources}{"\n"}{end}' 2>&1)" \
  || fail "SelfSubjectRulesReview를 읽지 못했다: ${rules}"

incomplete="$(printf '%s\n' "$rules" | head -n1)"
if [ "$incomplete" = true ]; then
  fail "권한 목록이 불완전해 금지 조합 부재를 증명할 수 없다"
fi

# awk가 [a b c] 형태의 배열을 토큰으로 풀어 금지 조합을 찾는다.
forbidden="$(printf '%s\n' "$rules" | tail -n +2 | awk -F'|' '
  function tokens(field,   cleaned) {
    cleaned = field
    gsub(/[][",]/, " ", cleaned)
    return " " cleaned " "
  }
  function has(field, want,   t) {
    t = tokens(field)
    return (index(t, " " want " ") > 0 || index(t, " * ") > 0)
  }
  NF < 3 { next }
  {
    verbs = $1; groups = $2; resources = $3
    core = has(groups, "")
    if (index(tokens(groups), " * ") > 0) core = 1
    # secret 읽기는 named 권한이라도 허용하지 않는다.
    if (core && has(resources, "secrets")) {
      for (i = 1; i <= 3; i++) {
        v = (i == 1 ? "get" : (i == 2 ? "list" : "watch"))
        if (has(verbs, v)) { print "secrets:" v; }
      }
    }
    # workload를 바꿀 수 있으면 pod template에 임의 Secret volume을 붙일 수 있다.
    split("pods jobs cronjobs deployments", wl, " ")
    split("create patch update delete deletecollection", mv, " ")
    for (i in wl) {
      if (!has(resources, wl[i])) continue
      for (j in mv) {
        if (has(verbs, mv[j])) { print wl[i] ":" mv[j]; }
      }
    }
  }
' | sort -u)"

if [ -n "$forbidden" ]; then
  echo "FAIL ${namespace}에 금지된 권한 조합이 있다:" >&2
  printf '  %s\n' $forbidden >&2
  fail "CI deployer 권한 경계가 깨졌다"
fi
echo "rules_review=clean"

# 배포에 필요한 read 권한은 정확한 리소스 이름으로 확인한다.
allowed=(
  "get:configmap/backoffice-provider-audit-trigger-state"
  "get:cronjob/vault-indexer"
  "get:cronjob/vault-writer"
)
# 아래 can-i는 exact 이름 경로의 회귀를 잡는 보조 검증이다. "0건" 증명은 위 rules review가 한다.
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
