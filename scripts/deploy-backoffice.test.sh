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
: "${FAKE_SCHEDULERS_PRESENT:=false}"
: "${FAKE_PATCH_FAIL_ON:=}"
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
  printf '%s|%s|%s|%s\n' "$condition" "$manifest_image" "$job" "$BACKOFFICE_SOURCE_SHA" > "$FAKE_KUBECTL_STATE"
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
if [[ "$args" == *" get cronjob/backoffice-"* && "$args" == *" -o name"* ]]; then
  if [ "$FAKE_SCHEDULERS_PRESENT" = true ]; then
    cronjob="${args##*cronjob/}"
    cronjob="${cronjob%% *}"
    printf 'cronjob.batch/%s\n' "$cronjob"
    exit 0
  fi
  printf 'Error from server (NotFound): cronjobs.batch not found\n' >&2
  exit 1
fi
if [[ "$args" == *" get cronjob/backoffice-"* && "$args" == *"status.active"* ]]; then
  exit 0
fi
if [[ "$args" == *" get cronjob/backoffice-"* && "$args" == *"spec.suspend"* ]]; then
  printf 'false'
  exit 0
fi
if [[ "$args" == *" patch cronjob/backoffice-"* ]]; then
  printf 'PATCH_CRONJOB %s\n' "$args" >> "$FAKE_KUBECTL_LOG"
  if [[ "$args" == *'suspend":true'* && -n "$FAKE_PATCH_FAIL_ON" && "$args" == *"cronjob/$FAKE_PATCH_FAIL_ON"* ]]; then
    printf 'injected patch failure\n' >&2
    exit 1
  fi
  exit 0
fi
if [[ "$args" == *" delete cronjob "* ]]; then
  printf 'DELETE_CRONJOBS %s\n' "$args" >> "$FAKE_KUBECTL_LOG"
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
  local schedulers_present="${3:-false}"
  FAKE_KUBECTL_LOG="$log" \
  FAKE_KUBECTL_STATE="$state" \
  FAKE_KUBECTL_COUNTER="$counter" \
  FAKE_MIGRATION_RESULT="$1" \
  FAKE_SCHEDULERS_PRESENT="$schedulers_present" \
  FAKE_PATCH_FAIL_ON="${FAKE_PATCH_FAIL_ON:-}" \
  FAKE_CATCHUP_CREATE_UNKNOWN="${FAKE_CATCHUP_CREATE_UNKNOWN:-false}" \
  FAKE_CATCHUP_RESULT="${FAKE_CATCHUP_RESULT:-Complete}" \
  KUBECTL_BIN="$fake" \
  BACKOFFICE_IMAGE="$run_image" \
  BACKOFFICE_SOURCE_SHA="$source_sha" \
  BACKOFFICE_MIGRATION_TIMEOUT_SECONDS=2 \
  BACKOFFICE_MIGRATION_POLL_SECONDS=0 \
  BACKOFFICE_SCHEDULER_DRAIN_SETTLE_SECONDS=0 \
  BACKOFFICE_CATCHUP_TIMEOUT_SECONDS=1500 \
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

[ "$(grep -c '^CREATE_JOB ' "$log")" -eq 4 ]
[ "$(grep -c '^APPLY_STDIN backoffice,' "$log")" -eq 2 ]
[ "$(grep -c '^APPLY_STDIN vault-indexer,vault-writer,' "$log")" -eq 2 ]

migration_line="$(line_of '^CREATE_JOB ')"
web_line="$(line_of '^APPLY_STDIN backoffice,')"
web_rollout_line="$(line_of '^ROLLOUT backoffice$')"
scheduler_line="$(line_of '^APPLY_FILE scheduler-cronjobs.yaml$')"
worker_line="$(line_of '^APPLY_STDIN backoffice-app-ops-worker,')"
catchup_line="$(line_of '^CREATE_JOB backoffice-scheduler-catchup-')"

if ! [ "$migration_line" -lt "$web_line" ] ||
   ! [ "$web_line" -lt "$web_rollout_line" ] ||
   ! [ "$web_rollout_line" -lt "$worker_line" ] ||
   ! [ "$worker_line" -lt "$catchup_line" ] ||
   ! [ "$catchup_line" -lt "$scheduler_line" ]; then
  echo "FAIL migration → web → worker → catch-up → scheduler 순서가 깨졌다" >&2
  cat "$log" >&2
  exit 1
fi
echo "  ok   migration → web → worker → catch-up → scheduler"
echo "  ok   동일 SHA 재실행은 새 migration/catch-up attempt로 감사 가능"

echo "== 기존 scheduler drain과 재개 =="
: > "$log"
run_deploy Complete "$image" true >/dev/null
if [ "$(grep -c '^PATCH_CRONJOB .*suspend.*true' "$log")" -eq 3 ] &&
   grep -q '^DELETE_CRONJOBS ' "$log" &&
   grep -q '^APPLY_FILE scheduler-cronjobs.yaml$' "$log"; then
  echo "  ok   기존 scheduler 3개 suspend → drain → orphan reset → manifest 재생성"
else
  echo "FAIL 기존 scheduler drain/restart 계약이 깨졌다" >&2
  cat "$log" >&2
  exit 1
fi

echo "== scheduler suspend 도중 실패 복구 =="
: > "$log"
FAKE_PATCH_FAIL_ON=backoffice-reconcile
if run_deploy Complete "$image" true >/dev/null 2>&1; then
  echo "FAIL scheduler suspend 실패가 deploy 성공으로 처리됐다" >&2
  exit 1
fi
unset FAKE_PATCH_FAIL_ON
if grep -q '^PATCH_CRONJOB .*backoffice-reconcile.*suspend.*true' "$log" &&
   grep -q '^APPLY_FILE scheduler-cronjobs.yaml$' "$log"; then
  echo "  ok   첫 mutation 결과 불명에도 EXIT trap이 전체 manifest를 복구"
else
  echo "FAIL 부분 suspend 복구 계약이 깨졌다" >&2
  cat "$log" >&2
  exit 1
fi

echo "== catch-up create 결과 불명은 scheduler를 겹쳐 재개하지 않는다 =="
: > "$log"
FAKE_CATCHUP_CREATE_UNKNOWN=true
if run_deploy Complete "$image" true >/dev/null 2>&1; then
  echo "FAIL catch-up create 결과 불명이 deploy 성공으로 처리됐다" >&2
  exit 1
fi
unset FAKE_CATCHUP_CREATE_UNKNOWN
if grep -q '^CREATE_JOB backoffice-scheduler-catchup-' "$log" &&
   ! grep -q '^APPLY_FILE scheduler-cronjobs.yaml$' "$log"; then
  echo "  ok   결과 불명 catch-up과 CronJob의 중복 실행을 fail-closed"
else
  echo "FAIL catch-up create 결과 불명 계약이 깨졌다" >&2
  cat "$log" >&2
  exit 1
fi

echo "== terminal catch-up 실패는 scheduler를 복구하고 배포를 실패시킨다 =="
: > "$log"
FAKE_CATCHUP_RESULT=Failed
if run_deploy Complete "$image" true >/dev/null 2>&1; then
  echo "FAIL terminal catch-up 실패가 deploy 성공으로 처리됐다" >&2
  exit 1
fi
unset FAKE_CATCHUP_RESULT
if grep -q '^CREATE_JOB backoffice-scheduler-catchup-' "$log" &&
   grep -q '^APPLY_FILE scheduler-cronjobs.yaml$' "$log"; then
  echo "  ok   terminal 실패 확인 뒤 정기 scheduler 복구"
else
  echo "FAIL terminal catch-up 복구 계약이 깨졌다" >&2
  cat "$log" >&2
  exit 1
fi

echo "deploy-backoffice 계약 통과"
