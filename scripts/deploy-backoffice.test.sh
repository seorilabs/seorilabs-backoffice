#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fake="$tmp/kubectl"
log="$tmp/kubectl.log"
state="$tmp/job.state"
counter="$tmp/job.counter"
source_sha="0123456789abcdef0123456789abcdef01234567"
digest="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
image="registry.vzyx.xyz/seorilabs/seorilabs-backoffice@sha256:${digest}"

cat > "$fake" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail

: "${FAKE_KUBECTL_LOG:?}"
: "${FAKE_KUBECTL_STATE:?}"
: "${FAKE_KUBECTL_COUNTER:?}"
: "${BACKOFFICE_IMAGE:?}"
: "${BACKOFFICE_SOURCE_SHA:?}"
: "${FAKE_CATCHUP_CREATE_UNKNOWN:=false}"
: "${FAKE_CATCHUP_RESULT:=Complete}"

args="$*"

if [[ "$args" == *"create -f - -o name"* ]]; then
  payload="$(cat)"
  count=0
  [ ! -f "$FAKE_KUBECTL_COUNTER" ] || count="$(cat "$FAKE_KUBECTL_COUNTER")"
  count=$((count + 1))
  printf '%s' "$count" > "$FAKE_KUBECTL_COUNTER"
  prefix="$(printf '%s\n' "$payload" | awk '/generateName:/ { print $2; exit }')"
  job="${prefix}fake${count}"
  manifest_image="$(printf '%s\n' "$payload" | awk '/image: registry\.vzyx\.xyz\/seorilabs\/seorilabs-backoffice(@sha256:|:)/ { print $2; exit }')"
  condition="${FAKE_MIGRATION_RESULT:-Complete}"
  [[ "$prefix" != backoffice-scheduler-catchup-* ]] || condition="$FAKE_CATCHUP_RESULT"
  job_sha="$BACKOFFICE_SOURCE_SHA"
  if [[ "$prefix" == backoffice-provider-audit-trigger-verify-* ]]; then
    condition="${FAKE_TRIGGER_VERIFY_RESULT:-Complete}"
    manifest_image="$(printf '%s\n' "$payload" | awk '/^          image: mysql@sha256:/ { print $2; exit }')"
    [ "${FAKE_TRIGGER_VERIFY_SHA_MISMATCH:-false}" != true ] || job_sha="ffffffffffffffffffffffffffffffffffffffff"
    [ "${FAKE_TRIGGER_VERIFY_IMAGE_MISMATCH:-false}" != true ] || manifest_image="mysql@sha256:$(printf 'b%.0s' {1..64})"
    printf 'CREATE_VERIFY_JOB %s %s\n' "$job" "$manifest_image" >> "$FAKE_KUBECTL_LOG"
  fi
  printf '%s|%s|%s|%s\n' "$condition" "$manifest_image" "$job" "$job_sha" > "$FAKE_KUBECTL_STATE"
  printf 'CREATE_JOB %s %s\n' "$job" "$manifest_image" >> "$FAKE_KUBECTL_LOG"
  if [[ "$prefix" == backoffice-scheduler-catchup-* && "$FAKE_CATCHUP_CREATE_UNKNOWN" == true ]]; then
    printf 'injected create response loss\n' >&2
    exit 1
  fi
  printf 'job.batch/%s\n' "$job"
  exit 0
fi

if [[ "$args" == *" get job "* ]]; then
  IFS='|' read -r condition job_image job_name job_sha < "$FAKE_KUBECTL_STATE"
  if [[ "$args" == *"status.conditions"* ]]; then
    printf '%s=True\n' "$condition"
  elif [[ "$args" == *"spec.template.spec.containers[0].image"* ]]; then
    printf '%s' "$job_image"
  elif [[ "$args" == *"metadata.labels.seorilabs"* ]]; then
    printf '%s' "$job_sha"
  else
    printf 'job.batch/%s\n' "$job_name"
  fi
  exit 0
fi

if [[ "$args" == *" get pods -l job-name="* ]]; then
  printf '%s' "$BACKOFFICE_IMAGE"
  exit 0
fi

if [[ "$args" == *" rollout status deployment/"* ]]; then
  deployment="${args##*deployment/}"
  deployment="${deployment%% *}"
  printf 'ROLLOUT %s\n' "$deployment" >> "$FAKE_KUBECTL_LOG"
  [ "${FAKE_ROLLOUT_RESULT:-success}" = success ]
  exit
fi

if [[ "$args" == *" get deployment/"* && "$args" == *"jsonpath="* ]]; then
  printf '1|1|1|1|1|1|1||%s,' "$BACKOFFICE_IMAGE"
  exit 0
fi

if [[ "$args" == *" get cronjob vault-indexer -o name"* ]]; then
  printf 'cronjob.batch/vault-indexer\n'
  exit 0
fi
if [[ "$args" == *" get cronjob vault-writer -o name"* ]]; then
  printf 'cronjob.batch/vault-writer\n'
  exit 0
fi
if [[ "$args" == *" get cronjob/backoffice-"* && "$args" == *"spec.suspend"* ]]; then
  printf 'false'
  exit 0
fi
if [[ "$args" == *" get cronjob "* && "$args" == *"jsonpath="* ]]; then
  printf '%s' "$BACKOFFICE_IMAGE"
  exit 0
fi

if [[ "$args" == *" logs job/"* ]]; then
  printf 'fake migration failure\n' >&2
  exit 0
fi

if [[ "$args" == *"apply -f -"* ]]; then
  payload="$(cat)"
  names="$(printf '%s\n' "$payload" | awk '/^  name:/ { printf "%s,", $2 } /^  generateName:/ { printf "%s,", $2 }')"
  printf 'APPLY_STDIN %s\n' "$names" >> "$FAKE_KUBECTL_LOG"
  exit 0
fi

if [[ "$args" == *"apply -f "* ]]; then
  manifest="${args##*apply -f }"
  printf 'APPLY_FILE %s\n' "${manifest##*/}" >> "$FAKE_KUBECTL_LOG"
  exit 0
fi

printf '지원하지 않는 fake kubectl 호출: %s\n' "$args" >&2
exit 1
FAKE
chmod +x "$fake"

run_deploy() {
  local run_image="${2:-$image}"
  FAKE_KUBECTL_LOG="$log" \
  FAKE_KUBECTL_STATE="$state" \
  FAKE_KUBECTL_COUNTER="$counter" \
  FAKE_MIGRATION_RESULT="$1" \
  FAKE_CATCHUP_CREATE_UNKNOWN="${FAKE_CATCHUP_CREATE_UNKNOWN:-false}" \
  FAKE_CATCHUP_RESULT="${FAKE_CATCHUP_RESULT:-Complete}" \
  FAKE_TRIGGER_VERIFY_RESULT="${FAKE_TRIGGER_VERIFY_RESULT:-Complete}" \
  FAKE_TRIGGER_VERIFY_SHA_MISMATCH="${FAKE_TRIGGER_VERIFY_SHA_MISMATCH:-false}" \
  FAKE_TRIGGER_VERIFY_IMAGE_MISMATCH="${FAKE_TRIGGER_VERIFY_IMAGE_MISMATCH:-false}" \
  KUBECTL_BIN="$fake" \
  BACKOFFICE_IMAGE="$run_image" \
  BACKOFFICE_SOURCE_SHA="$source_sha" \
  BACKOFFICE_MIGRATION_TIMEOUT_SECONDS=2 \
  BACKOFFICE_MIGRATION_POLL_SECONDS=0 \
  BACKOFFICE_CATCHUP_TIMEOUT_SECONDS=2400 \
  BACKOFFICE_TRIGGER_VERIFY_TIMEOUT_SECONDS=2 \
  "$here/deploy-backoffice.sh"
}

line_of() {
  local pattern="$1"
  grep -n "$pattern" "$log" | head -n1 | cut -d: -f1
}

echo "== migration 실패는 workload를 바꾸지 않는다 =="
: > "$log"
if run_deploy Failed >/dev/null 2>&1; then
  echo "FAIL migration 실패가 deploy 성공으로 처리됐다" >&2
  exit 1
fi
grep -q '^CREATE_JOB ' "$log"
if grep -q '^APPLY_' "$log"; then
  echo "FAIL migration 실패 뒤 manifest apply가 실행됐다" >&2
  exit 1
fi
echo "  ok   fail-closed"

echo "== 성공 순서와 동일 SHA 재실행 =="
: > "$log"
run_deploy Complete >/dev/null
run_deploy Complete >/dev/null

[ "$(grep -c '^CREATE_JOB ' "$log")" -eq 6 ]
[ "$(grep -c '^CREATE_VERIFY_JOB ' "$log")" -eq 2 ]
[ "$(grep -c '^APPLY_STDIN backoffice,' "$log")" -eq 2 ]
[ "$(grep -c '^APPLY_STDIN vault-indexer,vault-writer,' "$log")" -eq 2 ]
[ "$(grep -c '^APPLY_FILE backup-cronjob.yaml$' "$log")" -eq 2 ]
if grep -q '^APPLY_FILE backup-pvc.yaml$' "$log"; then
  echo "FAIL CI deployer가 stateful PVC를 변경했다" >&2
  exit 1
fi

migration_line="$(line_of '^CREATE_JOB ')"
verify_line="$(line_of '^CREATE_VERIFY_JOB ')"
web_line="$(line_of '^APPLY_STDIN backoffice,')"
web_rollout_line="$(line_of '^ROLLOUT backoffice$')"
scheduler_line="$(line_of '^APPLY_FILE scheduler-cronjobs.yaml$')"
worker_line="$(line_of '^APPLY_STDIN backoffice-app-ops-worker,')"
catchup_line="$(line_of '^CREATE_JOB backoffice-scheduler-catchup-')"

if ! [ "$migration_line" -lt "$verify_line" ] ||
   ! [ "$verify_line" -lt "$web_line" ] ||
   ! [ "$web_line" -lt "$web_rollout_line" ] ||
   ! [ "$web_rollout_line" -lt "$worker_line" ] ||
   ! [ "$worker_line" -lt "$scheduler_line" ] ||
   ! [ "$scheduler_line" -lt "$catchup_line" ]; then
  echo "FAIL migration → trigger-verify → web → worker → scheduler → catch-up 순서가 깨졌다" >&2
  cat "$log" >&2
  exit 1
fi
echo "  ok   migration → trigger-verify → web → worker → scheduler → catch-up"
echo "  ok   동일 SHA 재실행은 새 migration/catch-up attempt로 감사 가능"

echo "== catch-up create 결과 불명에도 scheduler는 계속 동작한다 =="
: > "$log"
FAKE_CATCHUP_CREATE_UNKNOWN=true
if run_deploy Complete "$image" true >/dev/null 2>&1; then
  echo "FAIL catch-up create 결과 불명이 deploy 성공으로 처리됐다" >&2
  exit 1
fi
unset FAKE_CATCHUP_CREATE_UNKNOWN
unknown_scheduler_line="$(line_of '^APPLY_FILE scheduler-cronjobs.yaml$')"
unknown_catchup_line="$(line_of '^CREATE_JOB backoffice-scheduler-catchup-')"
if [ "$unknown_scheduler_line" -lt "$unknown_catchup_line" ] &&
   ! grep -q '^PATCH_CRONJOB\|^DELETE_CRONJOBS' "$log"; then
  echo "  ok   결과 불명 전에 scheduler desired state를 복구하고 중단"
else
  echo "FAIL catch-up create 결과 불명 계약이 깨졌다" >&2
  cat "$log" >&2
  exit 1
fi

echo "== terminal catch-up 실패도 scheduler를 중단하지 않는다 =="
: > "$log"
FAKE_CATCHUP_RESULT=Failed
if run_deploy Complete "$image" true >/dev/null 2>&1; then
  echo "FAIL terminal catch-up 실패가 deploy 성공으로 처리됐다" >&2
  exit 1
fi
unset FAKE_CATCHUP_RESULT
if grep -q '^CREATE_JOB backoffice-scheduler-catchup-' "$log" &&
   grep -q '^APPLY_FILE scheduler-cronjobs.yaml$' "$log" &&
   ! grep -q '^PATCH_CRONJOB\|^DELETE_CRONJOBS' "$log"; then
  echo "  ok   terminal 실패를 배포 실패로 기록하되 정기 scheduler 유지"
else
  echo "FAIL terminal catch-up 복구 계약이 깨졌다" >&2
  cat "$log" >&2
  exit 1
fi

echo "== trigger verify 실패는 rollout 전에 배포를 멈춘다 =="
for scenario in Failed sha-mismatch image-mismatch; do
  : > "$log"
  case "$scenario" in
    Failed) FAKE_TRIGGER_VERIFY_RESULT=Failed ;;
    sha-mismatch) FAKE_TRIGGER_VERIFY_SHA_MISMATCH=true ;;
    image-mismatch) FAKE_TRIGGER_VERIFY_IMAGE_MISMATCH=true ;;
  esac
  if run_deploy Complete >/dev/null 2>&1; then
    echo "FAIL trigger verify $scenario 가 deploy 성공으로 처리됐다" >&2
    exit 1
  fi
  unset FAKE_TRIGGER_VERIFY_RESULT FAKE_TRIGGER_VERIFY_SHA_MISMATCH FAKE_TRIGGER_VERIFY_IMAGE_MISMATCH
  if ! grep -q '^CREATE_VERIFY_JOB ' "$log"; then
    echo "FAIL trigger verify Job이 생성되지 않았다: $scenario" >&2
    exit 1
  fi
  if grep -q '^ROLLOUT \|^APPLY_STDIN backoffice,' "$log"; then
    echo "FAIL trigger verify $scenario 뒤에도 rollout이 진행됐다" >&2
    cat "$log" >&2
    exit 1
  fi
  echo "  ok   $scenario fail-closed"
done

echo "deploy-backoffice 계약 통과"
