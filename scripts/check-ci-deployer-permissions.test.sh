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

echo "check-ci-deployer-permissions 계약 통과"
