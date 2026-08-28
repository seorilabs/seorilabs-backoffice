#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fake="$tmp/kubectl"
cat > "$fake" <<'FAKE'
#!/usr/bin/env bash
set -uo pipefail

args="$*"

if [[ "$args" == *"auth whoami"* ]]; then
  if [ "${FAKE_UNREACHABLE:-false}" = true ]; then
    printf 'Unable to connect to the server: dial tcp: i/o timeout\n' >&2
    exit 1
  fi
  printf '%s' "${FAKE_IDENTITY-system:serviceaccount:platform:ci-deployer}"
  exit 0
fi

if [[ "$args" == *"create --validate=false -f -"* ]]; then
  cat >/dev/null
  if [ "${FAKE_RULES_UNREADABLE:-false}" = true ]; then
    printf 'Error from server: selfsubjectrulesreviews.authorization.k8s.io is forbidden\n' >&2
    exit 1
  fi
  printf '%s\n' "${FAKE_RULES_INCOMPLETE:-false}"
  # 기본은 이 PR이 남기는 read-only 권한이다.
  printf '["get"]|[""]|["configmaps"]\n'
  printf '["get"]|["batch"]|["cronjobs"]\n'
  [ -z "${FAKE_EXTRA_RULE:-}" ] || printf '%s\n' "$FAKE_EXTRA_RULE"
  exit 0
fi

if [[ "$args" == *"auth can-i"* ]]; then
  read -r _ _ verb resource _ <<< "$args"
  case "${verb}:${resource}" in
    get:configmap/backoffice-provider-audit-trigger-state|get:cronjob/vault-indexer|get:cronjob/vault-writer)
      answer=yes ;;
    *) answer=no ;;
  esac
  if [ -n "${FAKE_ALLOW_PAIR:-}" ] && [ "${verb}:${resource}" = "$FAKE_ALLOW_PAIR" ]; then
    answer=yes
  fi
  if [ -n "${FAKE_DENY_PAIR:-}" ] && [ "${verb}:${resource}" = "$FAKE_DENY_PAIR" ]; then
    answer=no
  fi
  printf '%s\n' "$answer"
  [ "$answer" = yes ] || exit 1
  exit 0
fi

printf '지원하지 않는 fake kubectl 호출: %s\n' "$args" >&2
exit 1
FAKE
chmod +x "$fake"

run_check() {
  env KUBECTL_BIN="$fake" "$@" bash "$here/check-ci-deployer-permissions.sh"
}

echo "== 정상 경계는 통과한다 =="
run_check >/dev/null
echo "  ok   read 허용 + mutation 거부"

echo "== 클러스터 접근 불가는 skip이 아니라 실패다 =="
if run_check FAKE_UNREACHABLE=true >/dev/null 2>&1; then
  echo "FAIL 접근 불가가 통과로 처리됐다" >&2
  exit 1
fi
echo "  ok   fail-closed"

echo "== identity가 다르면 실패한다 =="
for identity in "system:serviceaccount:platform:backoffice" "kubernetes-admin" ""; do
  if run_check FAKE_IDENTITY="$identity" >/dev/null 2>&1; then
    echo "FAIL identity '$identity' 가 통과로 처리됐다" >&2
    exit 1
  fi
done
echo "  ok   정확한 ci-deployer identity만 통과"

echo "== workload·secret mutation이 허용되면 실패한다 =="
for pair in create:jobs patch:pods patch:cronjob/vault-indexer update:cronjob/vault-writer \
            get:secrets get:secret/mysql-root-cred \
            patch:configmap/backoffice-provider-audit-trigger-state; do
  if run_check FAKE_ALLOW_PAIR="$pair" >/dev/null 2>&1; then
    echo "FAIL $pair 허용이 통과로 처리됐다" >&2
    exit 1
  fi
done
echo "  ok   mutation·secret 허용은 fail-closed"

echo "== 필요한 read 권한이 없으면 실패한다 =="
for pair in get:configmap/backoffice-provider-audit-trigger-state get:cronjob/vault-indexer; do
  if run_check FAKE_DENY_PAIR="$pair" >/dev/null 2>&1; then
    echo "FAIL $pair 거부가 통과로 처리됐다" >&2
    exit 1
  fi
done
echo "  ok   read 권한 부재도 fail-closed"

echo "== rules review에 섞인 named secret·workload 권한을 잡는다 =="
# can-i는 이름 없는 질문에 no를 돌려주므로 named 권한을 놓친다. rules review가 잡아야 한다.
while IFS='#' read -r label rule; do
  [ -n "$label" ] || continue
  if run_check FAKE_EXTRA_RULE="$rule" >/dev/null 2>&1; then
    echo "FAIL $label 이 통과로 처리됐다" >&2
    exit 1
  fi
  echo "  ok   $label fail-closed"
done <<'CASES'
named secret get#["get"]|[""]|["secrets"]
named secret watch#["watch"]|[""]|["secrets"]
named cronjob patch#["patch"]|["batch"]|["cronjobs"]
named job create#["create"]|["batch"]|["jobs"]
pod update#["update"]|[""]|["pods"]
deployment delete#["delete"]|["apps"]|["deployments"]
wildcard verb on cronjobs#["*"]|["batch"]|["cronjobs"]
wildcard resource in core group#["get"]|[""]|["*"]
wildcard group and resource#["create"]|["*"]|["*"]
CASES

echo "== rules review를 읽지 못하거나 불완전하면 실패한다 =="
if run_check FAKE_RULES_UNREADABLE=true >/dev/null 2>&1; then
  echo "FAIL rules review 조회 실패가 통과로 처리됐다" >&2
  exit 1
fi
if run_check FAKE_RULES_INCOMPLETE=true >/dev/null 2>&1; then
  echo "FAIL 불완전한 권한 목록이 통과로 처리됐다" >&2
  exit 1
fi
echo "  ok   fail-closed"

echo "== 무해한 추가 read 권한은 통과한다 =="
for rule in '["get"]|[""]|["configmaps"]' '["get","list"]|["batch"]|["cronjobs"]'; do
  run_check FAKE_EXTRA_RULE="$rule" >/dev/null
done
echo "  ok   read-only 규칙은 허용"

echo "check-ci-deployer-permissions 계약 통과"
