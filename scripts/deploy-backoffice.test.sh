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
expected_digest="$(awk -F'"' '/seorilabs\.dev\/append-only-contract-digest:/ { print $2; exit }' \
  "$here/../k8s/provider-audit-trigger-verifier.yaml")"
[[ "$expected_digest" =~ ^[0-9a-f]{64}$ ]]
now_epoch="$(date -u +%s)"
iso_at() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }
migration_completed_at="$(iso_at $((now_epoch - 60)))"

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
  printf '%s|%s|%s|%s\n' "$condition" "$manifest_image" "$job" "$BACKOFFICE_SOURCE_SHA" > "$FAKE_KUBECTL_STATE"
  printf 'CREATE_JOB %s %s\n' "$job" "$manifest_image" >> "$FAKE_KUBECTL_LOG"
  if [[ "$prefix" == backoffice-scheduler-catchup-* && "$FAKE_CATCHUP_CREATE_UNKNOWN" == true ]]; then
    printf 'injected create response loss\n' >&2
    exit 1
  fi
  printf 'job.batch/%s\n' "$job"
  exit 0
fi

if [[ "$args" == *" get configmap backoffice-provider-audit-trigger-state"* ]]; then
  printf 'READ_TRIGGER_STATE\n' >> "$FAKE_KUBECTL_LOG"
  if [ "${FAKE_TRIGGER_STATE_MISSING:-false}" = true ]; then
    printf 'Error from server (NotFound): configmaps "backoffice-provider-audit-trigger-state" not found\n' >&2
    exit 1
  fi
  printf '%s|%s|%s|%s|%s' \
    "${FAKE_TRIGGER_STATUS:-PASS}" \
    "${FAKE_TRIGGER_TOTAL:-2}" \
    "${FAKE_TRIGGER_EXACT:-2}" \
    "${FAKE_TRIGGER_DIGEST:-$EXPECTED_CONTRACT_DIGEST}" \
    "${FAKE_TRIGGER_OBSERVED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  exit 0
fi

if [[ "$args" == *" get job "* ]]; then
  IFS='|' read -r condition job_image job_name job_sha < "$FAKE_KUBECTL_STATE"
  if [[ "$args" == *"status.completionTime"* ]]; then
    printf '%s' "${FAKE_MIGRATION_COMPLETED_AT:-$MIGRATION_COMPLETED_AT}"
    exit 0
  fi
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

if [[ "$args" == *" get cronjob vault-"* && "$args" == *"jobTemplate"* ]]; then
  printf 'READ_VAULT_IMAGE\n' >> "$FAKE_KUBECTL_LOG"
  case "${FAKE_VAULT_PARITY:-match}" in
    match) printf '%s' "$BACKOFFICE_IMAGE" ;;
    drift) printf 'registry.vzyx.xyz/seorilabs/seorilabs-backoffice@sha256:%s' "$(printf 'd%.0s' {1..64})" ;;
    absent) printf 'Error from server (NotFound): cronjobs.batch "vault-indexer" not found\n' >&2; exit 1 ;;
    unreadable) printf 'Error from server (Forbidden): cronjobs.batch is forbidden\n' >&2; exit 1 ;;
  esac
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
  EXPECTED_CONTRACT_DIGEST="$expected_digest" \
  MIGRATION_COMPLETED_AT="$migration_completed_at" \
  FAKE_MIGRATION_COMPLETED_AT="${FAKE_MIGRATION_COMPLETED_AT:-}" \
  FAKE_TRIGGER_STATUS="${FAKE_TRIGGER_STATUS:-PASS}" \
  FAKE_TRIGGER_TOTAL="${FAKE_TRIGGER_TOTAL:-2}" \
  FAKE_TRIGGER_EXACT="${FAKE_TRIGGER_EXACT:-2}" \
  FAKE_TRIGGER_DIGEST="${FAKE_TRIGGER_DIGEST:-$expected_digest}" \
  FAKE_TRIGGER_OBSERVED_AT="${FAKE_TRIGGER_OBSERVED_AT:-}" \
  FAKE_TRIGGER_STATE_MISSING="${FAKE_TRIGGER_STATE_MISSING:-false}" \
  FAKE_VAULT_PARITY="${FAKE_VAULT_PARITY:-match}" \
  KUBECTL_BIN="$fake" \
  BACKOFFICE_IMAGE="$run_image" \
  BACKOFFICE_SOURCE_SHA="$source_sha" \
  BACKOFFICE_MIGRATION_TIMEOUT_SECONDS=2 \
  BACKOFFICE_MIGRATION_POLL_SECONDS=0 \
  BACKOFFICE_CATCHUP_TIMEOUT_SECONDS=2400 \
  BACKOFFICE_TRIGGER_VERIFY_TIMEOUT_SECONDS=1 \
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
[ "$(grep -c '^READ_TRIGGER_STATE$' "$log")" -eq 2 ]
[ "$(grep -c '^APPLY_STDIN backoffice,' "$log")" -eq 2 ]
if grep -q '^APPLY_STDIN vault-indexer' "$log"; then
  echo "FAIL CI가 data namespace workload를 변경했다" >&2
  exit 1
fi
[ "$(grep -c '^READ_VAULT_IMAGE$' "$log")" -eq 4 ]
[ "$(grep -c '^APPLY_FILE backup-cronjob.yaml$' "$log")" -eq 2 ]
if grep -q '^APPLY_FILE backup-pvc.yaml$' "$log"; then
  echo "FAIL CI deployer가 stateful PVC를 변경했다" >&2
  exit 1
fi

migration_line="$(line_of '^CREATE_JOB ')"
verify_line="$(line_of '^READ_TRIGGER_STATE$')"
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

echo "== trigger 관측이 계약을 만족하지 않으면 rollout 전에 멈춘다 =="
pre_migration="$(iso_at $((now_epoch - 120)))"
long_stale="$(iso_at $((now_epoch - 7200)))"
for scenario in fail zero-trigger one-trigger bypass-trigger digest-mismatch pre-migration stale missing; do
  : > "$log"
  case "$scenario" in
    fail) FAKE_TRIGGER_STATUS=FAIL ;;
    zero-trigger) FAKE_TRIGGER_STATUS=FAIL; FAKE_TRIGGER_TOTAL=0; FAKE_TRIGGER_EXACT=0 ;;
    one-trigger) FAKE_TRIGGER_STATUS=FAIL; FAKE_TRIGGER_TOTAL=1; FAKE_TRIGGER_EXACT=1 ;;
    bypass-trigger) FAKE_TRIGGER_STATUS=FAIL; FAKE_TRIGGER_TOTAL=3; FAKE_TRIGGER_EXACT=2 ;;
    digest-mismatch) FAKE_TRIGGER_DIGEST="$(printf 'c%.0s' {1..64})" ;;
    pre-migration) FAKE_TRIGGER_OBSERVED_AT="$pre_migration" ;;
    stale) FAKE_TRIGGER_OBSERVED_AT="$long_stale" ;;
    missing) FAKE_TRIGGER_STATE_MISSING=true ;;
  esac
  if run_deploy Complete >/dev/null 2>&1; then
    echo "FAIL trigger 관측 $scenario 가 deploy 성공으로 처리됐다" >&2
    exit 1
  fi
  unset FAKE_TRIGGER_STATUS FAKE_TRIGGER_TOTAL FAKE_TRIGGER_EXACT FAKE_TRIGGER_DIGEST \
    FAKE_TRIGGER_OBSERVED_AT FAKE_TRIGGER_STATE_MISSING
  if ! grep -q '^READ_TRIGGER_STATE$' "$log"; then
    echo "FAIL trigger 관측 readback이 실행되지 않았다: $scenario" >&2
    exit 1
  fi
  if grep -q '^ROLLOUT \|^APPLY_STDIN backoffice,' "$log"; then
    echo "FAIL trigger 관측 $scenario 뒤에도 rollout이 진행됐다" >&2
    cat "$log" >&2
    exit 1
  fi
  echo "  ok   $scenario fail-closed"
done

echo "== migration 완료 이후 관측만 인정한다 =="
: > "$log"
FAKE_TRIGGER_OBSERVED_AT="$(iso_at $((now_epoch - 59)))"
run_deploy Complete >/dev/null
unset FAKE_TRIGGER_OBSERVED_AT
if ! grep -q '^ROLLOUT backoffice$' "$log"; then
  echo "FAIL migration 완료 이후 관측이 거부됐다" >&2
  exit 1
fi
echo "  ok   완료 이후 관측은 통과"

echo "== 완료와 같은 초의 관측은 race라 거부한다 =="
: > "$log"
FAKE_TRIGGER_OBSERVED_AT="$migration_completed_at"
if run_deploy Complete >/dev/null 2>&1; then
  echo "FAIL 같은 초 관측이 deploy 성공으로 처리됐다" >&2
  exit 1
fi
unset FAKE_TRIGGER_OBSERVED_AT
if grep -q '^ROLLOUT \|^APPLY_STDIN backoffice,' "$log"; then
  echo "FAIL 같은 초 관측 뒤에도 rollout이 진행됐다" >&2
  exit 1
fi
echo "  ok   fail-closed"

echo "== migration 완료 시각을 못 읽으면 배포하지 않는다 =="
: > "$log"
FAKE_MIGRATION_COMPLETED_AT=" "
if run_deploy Complete >/dev/null 2>&1; then
  echo "FAIL migration 완료 시각 부재가 deploy 성공으로 처리됐다" >&2
  exit 1
fi
unset FAKE_MIGRATION_COMPLETED_AT
if grep -q '^ROLLOUT \|^APPLY_STDIN backoffice,' "$log"; then
  echo "FAIL migration 완료 시각 부재 뒤에도 rollout이 진행됐다" >&2
  exit 1
fi
echo "  ok   fail-closed"

echo "== Vault 이미지 drift에도 CI는 data workload를 바꾸지 않는다 =="
for scenario in drift absent unreadable; do
  : > "$log"
  FAKE_VAULT_PARITY="$scenario"
  run_deploy Complete >/dev/null 2>&1 || true
  unset FAKE_VAULT_PARITY
  if grep -qE '^APPLY_STDIN vault-|^PATCH_CRONJOB|^APPLY_FILE vault-rag.yaml$' "$log"; then
    echo "FAIL Vault $scenario 에서 CI가 data workload를 변경했다" >&2
    cat "$log" >&2
    exit 1
  fi
  echo "  ok   $scenario 에서 mutation 없음"
done

echo "== deploy script는 data namespace mutation 명령을 갖지 않는다 =="
data_mutation="$(grep -nE '\-n data|k -n data|k8s/vault-rag.yaml' "$here/deploy-backoffice.sh" \
  | grep -vE '^[0-9]+:[[:space:]]*#' \
  | grep -vE '^[0-9]+:[[:space:]]*echo ' \
  | grep -E 'apply|create|patch|replace|delete|set image' || true)"
if [ -n "$data_mutation" ]; then
  echo "FAIL deploy script에 data namespace mutation이 남아 있다" >&2
  printf '%s\n' "$data_mutation" >&2
  exit 1
fi
echo "  ok   data namespace는 read-only 경로만 남았다"

echo "== CI는 verifier workload를 만들거나 바꾸지 않는다 =="
: > "$log"
run_deploy Complete >/dev/null
if grep -q 'provider-audit-trigger-verifier' "$log" ||
   grep -q '^CREATE_JOB backoffice-provider-audit' "$log" ||
   grep -qi 'mysql-root-cred' "$log"; then
  echo "FAIL CI가 verifier workload나 root secret 경계를 건드렸다" >&2
  cat "$log" >&2
  exit 1
fi
# verifier manifest는 계약 digest를 읽는 용도로만 등장해야 한다.
# 주석과 안내 문구를 걷어낸 실행 라인에서 apply/create/render 대상이면 안 된다.
verifier_code="$(grep -v '^[[:space:]]*#' "$here/deploy-backoffice.sh" \
  | grep -v '^[[:space:]]*echo ' \
  | grep 'provider-audit-trigger-verifier\|provider-audit-trigger-recovery' || true)"
if [ "$(printf '%s\n' "$verifier_code" | grep -c 'k8s/provider-audit-trigger-verifier.yaml')" -ne 1 ] ||
   printf '%s\n' "$verifier_code" | grep -qE '(apply|create|render)[[:space:]]'; then
  echo "FAIL deploy script가 verifier/recovery manifest를 apply·create 대상에 포함했다" >&2
  printf '%s\n' "$verifier_code" >&2
  exit 1
fi
echo "  ok   verifier workload는 trusted operator 경계에만 있다"

echo "deploy-backoffice 계약 통과"
