#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fake="$tmp/kubectl"
log="$tmp/kubectl.log"
state="$tmp/job.state"
counter="$tmp/job.counter"
deployment_counter="$tmp/deployment.counter"
yaml_cache="$tmp/yaml-cache"
mkdir -p "$yaml_cache"
source_sha="0123456789abcdef0123456789abcdef01234567"
digest="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
image="registry.vzyx.xyz/seorilabs/seorilabs-backoffice@sha256:${digest}"
expected_digest="$(awk -F'"' '/seorilabs\.dev\/append-only-contract-digest:/ { print $2; exit }' \
  "$here/../k8s/provider-audit-trigger-verifier.yaml")"
expected_count="$(awk -F'"' '/seorilabs\.dev\/append-only-contract-count:/ { print $2; exit }' \
  "$here/../k8s/provider-audit-trigger-verifier.yaml")"
[[ "$expected_digest" =~ ^[0-9a-f]{64}$ ]]
[[ "$expected_count" =~ ^[1-9][0-9]*$ ]]
now_epoch="$(date -u +%s)"
iso_at() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }
migration_completed_at="$(iso_at $((now_epoch - 60)))"

cat > "$fake" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail

: "${FAKE_KUBECTL_LOG:?}"
: "${FAKE_KUBECTL_STATE:?}"
: "${FAKE_KUBECTL_COUNTER:?}"
: "${FAKE_DEPLOYMENT_COUNTER:?}"
: "${BACKOFFICE_IMAGE:?}"
: "${BACKOFFICE_SOURCE_SHA:?}"
: "${FAKE_CATCHUP_CREATE_UNKNOWN:=false}"
: "${FAKE_CATCHUP_RESULT:=Complete}"
: "${FAKE_BACKFILL_RUN_ID=desired-state-run-fake}"
: "${FAKE_BACKFILL_CONTRACT:=desired-state-safe-source-rebase/v3}"
: "${FAKE_BACKFILL_TRIGGER:=DEPLOY_CATCH_UP}"
: "${FAKE_BACKFILL_SOURCE_SHA:=$BACKOFFICE_SOURCE_SHA}"
: "${FAKE_BACKFILL_STATUS:=COMPLETED}"
: "${FAKE_BACKFILL_FAILED:=0}"
: "${FAKE_REPO_ROOT:?}"
: "${FAKE_YAML_CACHE_DIR:?}"
: "${FAKE_SEALED_MISSING_KEY:=}"

args="$*"

# 시크릿 참조 점검: YAML 해석은 저장소 yaml 패키지로, SealedSecret은 저장소 파일을
# 현재 generation이 동기화된 클러스터 객체처럼 돌려준다. 배포를 여러 번 돌리므로
# 같은 파일의 변환 결과는 캐시한다.
yaml_to_json_cached() {
  local cache
  cache="$FAKE_YAML_CACHE_DIR/$(printf '%s\n' "$@" | cksum | cut -d' ' -f1).json"
  if [ ! -f "$cache" ]; then
    node "$FAKE_REPO_ROOT/scripts/fixtures/yaml-to-json.cjs" "$@" > "$cache.tmp"
    mv "$cache.tmp" "$cache"
  fi
  cat "$cache"
}
if [[ "$args" == "create --dry-run=client -o json --validate=false "* ]]; then
  printf 'SECRET_PREFLIGHT_PARSE\n' >> "$FAKE_KUBECTL_LOG"
  shift 5
  files=()
  while [ "$#" -gt 0 ]; do
    files+=("$2")
    shift 2
  done
  yaml_to_json_cached "${files[@]}"
  exit
fi
if [[ "$args" =~ ^-n\ platform\ get\ sealedsecret\ ([a-z0-9-]+)\ -o\ json$ ]]; then
  name="${BASH_REMATCH[1]}"
  printf 'READ_SEALED %s\n' "$name" >> "$FAKE_KUBECTL_LOG"
  sealed_file="$(grep -l "^  name: ${name}\$" "$FAKE_REPO_ROOT"/k8s/*sealedsecret*.yaml | head -n1 || true)"
  if [ -z "$sealed_file" ]; then
    printf 'Error from server (NotFound): sealedsecrets.bitnami.com "%s" not found\n' "$name" >&2
    exit 1
  fi
  yaml_to_json_cached "$sealed_file" \
    | jq --arg missing "$FAKE_SEALED_MISSING_KEY" '
        .metadata.generation = 1
        | .status = {observedGeneration: 1, conditions: [{type: "Synced", status: "True"}]}
        | if $missing == "" then . else del(.spec.encryptedData[$missing]) end'
  exit 0
fi

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
    "${FAKE_TRIGGER_TOTAL:-$EXPECTED_CONTRACT_COUNT}" \
    "${FAKE_TRIGGER_EXACT:-$EXPECTED_CONTRACT_COUNT}" \
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
  if [[ "$args" == *"state.terminated.message"* ]]; then
    printf 'runId=%s\ncontractVersion=%s\ntrigger=%s\nsourceSha=%s\nstatus=%s\nfailed=%s\n' \
      "$FAKE_BACKFILL_RUN_ID" \
      "$FAKE_BACKFILL_CONTRACT" \
      "$FAKE_BACKFILL_TRIGGER" \
      "$FAKE_BACKFILL_SOURCE_SHA" \
      "$FAKE_BACKFILL_STATUS" \
      "$FAKE_BACKFILL_FAILED"
  else
    printf '%s' "$BACKOFFICE_IMAGE"
  fi
  exit 0
fi

if [[ "$args" == *" rollout status deployment/"* ]]; then
  deployment="${args##*deployment/}"
  deployment="${deployment%% *}"
  printf 'ROLLOUT %s\n' "$deployment" >> "$FAKE_KUBECTL_LOG"
  [ "${FAKE_ROLLOUT_RESULT:-success}" = success ]
  exit
fi

if [[ "$args" == *"-n data get deployment/vault-indexer "* || "$args" == *"-n data get cronjob/vault-writer "* ]]; then
  printf 'READ_VAULT_IMAGE\n' >> "$FAKE_KUBECTL_LOG"
  case "${FAKE_VAULT_PARITY:-match}" in
    match) printf '%s' "$BACKOFFICE_IMAGE" ;;
    drift) printf 'registry.vzyx.xyz/seorilabs/seorilabs-backoffice@sha256:%s' "$(printf 'd%.0s' {1..64})" ;;
    absent) printf 'Error from server (NotFound): cronjobs.batch "vault-indexer" not found\n' >&2; exit 1 ;;
    unreadable) printf 'Error from server (Forbidden): cronjobs.batch is forbidden\n' >&2; exit 1 ;;
  esac
  exit 0
fi

if [[ "$args" == *" get deployment/"* && "$args" == *"jsonpath="* ]]; then
  if [[ "$args" == *"get deployment/backoffice-operations-insights "* && "${FAKE_INSIGHTS_PAUSED:-false}" = true ]]; then
    printf '1|1|0|0|0|0|0||%s,' "$BACKOFFICE_IMAGE"
    exit 0
  fi
  count=0
  [ ! -f "$FAKE_DEPLOYMENT_COUNTER" ] || count="$(cat "$FAKE_DEPLOYMENT_COUNTER")"
  count=$((count + 1))
  printf '%s' "$count" > "$FAKE_DEPLOYMENT_COUNTER"
  if [ "$count" -le "${FAKE_DEPLOYMENT_STALE_READS:-0}" ]; then
    printf '2|1|1|1|1|1|1||%s,' "$BACKOFFICE_IMAGE"
    exit 0
  fi
  printf '1|1|1|1|1|1|1||%s,' "$BACKOFFICE_IMAGE"
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
if [[ "$args" == *" patch cronjob backoffice-ait-console-metrics --type=strategic --patch-file "* ]]; then
  [ -f "${!#}" ]
  printf 'PATCH_AIT_IDENTITY\n' >> "$FAKE_KUBECTL_LOG"
  exit 0
fi
if [[ "$args" == *" set image cronjob/backoffice-ait-console-metrics "* ]]; then
  printf 'SET_AIT_IMAGE\n' >> "$FAKE_KUBECTL_LOG"
  exit 0
fi

if [[ "$args" == *" logs job/"* ]]; then
  printf 'fake migration failure\n' >&2
  exit 0
fi

if [[ "$args" == *" delete cronjob "* ]]; then
  retired="${args##* delete cronjob }"
  printf 'DELETE_CRONJOB %s\n' "${retired%% *}" >> "$FAKE_KUBECTL_LOG"
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
  FAKE_DEPLOYMENT_COUNTER="$deployment_counter" \
  FAKE_INSIGHTS_PAUSED="${FAKE_INSIGHTS_PAUSED:-false}" \
  FAKE_DEPLOYMENT_STALE_READS="${FAKE_DEPLOYMENT_STALE_READS:-0}" \
  FAKE_MIGRATION_RESULT="$1" \
  FAKE_CATCHUP_CREATE_UNKNOWN="${FAKE_CATCHUP_CREATE_UNKNOWN:-false}" \
  FAKE_CATCHUP_RESULT="${FAKE_CATCHUP_RESULT:-Complete}" \
  FAKE_BACKFILL_RUN_ID="${FAKE_BACKFILL_RUN_ID-desired-state-run-fake}" \
  FAKE_BACKFILL_CONTRACT="${FAKE_BACKFILL_CONTRACT:-desired-state-safe-source-rebase/v3}" \
  FAKE_BACKFILL_TRIGGER="${FAKE_BACKFILL_TRIGGER:-DEPLOY_CATCH_UP}" \
  FAKE_BACKFILL_SOURCE_SHA="${FAKE_BACKFILL_SOURCE_SHA:-$source_sha}" \
  FAKE_BACKFILL_STATUS="${FAKE_BACKFILL_STATUS:-COMPLETED}" \
  FAKE_BACKFILL_FAILED="${FAKE_BACKFILL_FAILED:-0}" \
  EXPECTED_CONTRACT_DIGEST="$expected_digest" \
  EXPECTED_CONTRACT_COUNT="$expected_count" \
  MIGRATION_COMPLETED_AT="$migration_completed_at" \
  FAKE_MIGRATION_COMPLETED_AT="${FAKE_MIGRATION_COMPLETED_AT:-}" \
  FAKE_TRIGGER_STATUS="${FAKE_TRIGGER_STATUS:-PASS}" \
  FAKE_TRIGGER_TOTAL="${FAKE_TRIGGER_TOTAL:-$expected_count}" \
  FAKE_TRIGGER_EXACT="${FAKE_TRIGGER_EXACT:-$expected_count}" \
  FAKE_TRIGGER_DIGEST="${FAKE_TRIGGER_DIGEST:-$expected_digest}" \
  FAKE_TRIGGER_OBSERVED_AT="${FAKE_TRIGGER_OBSERVED_AT:-}" \
  FAKE_TRIGGER_STATE_MISSING="${FAKE_TRIGGER_STATE_MISSING:-false}" \
  FAKE_VAULT_PARITY="${FAKE_VAULT_PARITY:-match}" \
  FAKE_REPO_ROOT="$here/.." \
  FAKE_YAML_CACHE_DIR="$yaml_cache" \
  FAKE_SEALED_MISSING_KEY="${FAKE_SEALED_MISSING_KEY:-}" \
  KUBECTL_BIN="$fake" \
  BACKOFFICE_IMAGE="$run_image" \
  BACKOFFICE_SOURCE_SHA="$source_sha" \
  BACKOFFICE_MIGRATION_TIMEOUT_SECONDS=2 \
  BACKOFFICE_MIGRATION_POLL_SECONDS=0 \
  BACKOFFICE_DEPLOYMENT_STATE_TIMEOUT_SECONDS=2 \
  BACKOFFICE_DEPLOYMENT_STATE_POLL_SECONDS=0 \
  BACKOFFICE_CATCHUP_TIMEOUT_SECONDS=3300 \
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

echo "== AC1 필수 시크릿 키가 클러스터 SealedSecret에 없으면 아무것도 바꾸지 않는다 =="
# 2026-11-15 장애: 키를 Secret에만 직접 넣어 rollout은 통과했고, sealed-secrets 컨트롤러
# 재시작 때 키가 지워져 웹과 알림 워커가 CreateContainerConfigError로 멈췄다.
: > "$log"
preflight_err="$tmp/preflight.err"
FAKE_SEALED_MISSING_KEY=SLACK_CHANNEL_METRIC_INSIGHTS_ID
if run_deploy Complete >/dev/null 2>"$preflight_err"; then
  echo "FAIL SealedSecret에 없는 필수 키가 deploy 성공으로 처리됐다" >&2
  exit 1
fi
unset FAKE_SEALED_MISSING_KEY
grep -q '^READ_SEALED backoffice-secrets$' "$log"
if grep -qE '^(CREATE_JOB|APPLY_|ROLLOUT|PATCH_|SET_|DELETE_)' "$log"; then
  echo "FAIL 시크릿 참조 점검 실패 뒤에도 클러스터를 바꿨다" >&2
  cat "$log" >&2
  exit 1
fi
grep -qF 'platform/backoffice-secrets: SLACK_CHANNEL_METRIC_INSIGHTS_ID' "$preflight_err"
grep -qF 'kubectl apply -f k8s/backoffice-sealedsecret.yaml' "$preflight_err"
echo "  ok   migration Job 생성 전에 누락 키와 적용할 파일을 알리고 중단"

echo "== AC6 배포 스크립트가 적용하는 매니페스트는 모두 시크릿 점검 목록에 있다 =="
# 점검 목록 밖의 매니페스트는 필수 키 누락을 잡지 못한다. 목록 정의를 뺀 실행 코드에서
# 매니페스트 이름을 모아 목록과 비교한다. 제외 대상: 읽기 전용 verifier, 안내 문구의
# vault-rag, 객체로 변환할 수 없는 부분 패치.
manifest_drift() {
  local script="$1" listed used manifest drift=""
  listed="$(awk '
    /^secret_ref_manifests=\($/ { inside = 1; next }
    inside && /^\)$/ { exit }
    inside { gsub(/[[:space:]]/, ""); if ($0 != "") print }
  ' "$script" | sort -u)"
  used="$(awk '
    /^secret_ref_manifests=\($/ { inside = 1; next }
    inside && /^\)$/ { inside = 0; next }
    !inside && !/^[[:space:]]*#/
  ' "$script" | grep -oE '[A-Za-z0-9_.-]+\.yaml' | sort -u)"
  for manifest in $used; do
    case "$manifest" in
      provider-audit-trigger-verifier.yaml | vault-rag.yaml | console-metrics-batch-identity-patch.yaml) continue ;;
    esac
    printf '%s\n' "$listed" | grep -Fxq "$manifest" || drift="$drift $manifest"
  done
  printf '%s' "${drift# }"
}
drift="$(manifest_drift "$here/deploy-backoffice.sh")"
if [ -n "$drift" ]; then
  echo "FAIL deploy-backoffice.sh의 secret_ref_manifests에 빠진 매니페스트: $drift" >&2
  exit 1
fi
for manifest in $(awk '/^secret_ref_manifests=\($/ { f = 1; next } f && /^\)$/ { exit } f { print $1 }' "$here/deploy-backoffice.sh"); do
  if [ ! -f "$here/../k8s/$manifest" ]; then
    echo "FAIL 점검 목록의 매니페스트가 없다: $manifest" >&2
    exit 1
  fi
done
mutated="$tmp/deploy-backoffice.mutated.sh"
sed 's|^apply_image_manifest realtime-spike-cronjob.yaml$|&\napply_image_manifest new-worker.yaml|' \
  "$here/deploy-backoffice.sh" > "$mutated"
if [ "$(manifest_drift "$mutated")" != new-worker.yaml ]; then
  echo "FAIL 목록에 없는 새 매니페스트 적용을 감지하지 못했다" >&2
  exit 1
fi
if grep -qE 'secretKeyRef|secretRef|secretName' "$here/../k8s/console-metrics-batch-identity-patch.yaml"; then
  echo "FAIL 점검에서 제외한 부분 패치에 시크릿 참조가 생겼다" >&2
  exit 1
fi
echo "  ok   적용 매니페스트와 점검 목록 일치, 새 매니페스트 누락 감지"

echo "== 성공 순서와 동일 SHA 재실행 =="
: > "$log"
run_deploy Complete >/dev/null
run_deploy Complete >/dev/null

[ "$(grep -c '^CREATE_JOB ' "$log")" -eq 4 ]
[ "$(grep -c '^READ_TRIGGER_STATE$' "$log")" -eq 2 ]
[ "$(grep -c '^APPLY_STDIN backoffice,' "$log")" -eq 2 ]
[ "$(grep -c '^APPLY_STDIN backoffice-store-submissions,' "$log")" -eq 2 ]
if grep -q '^APPLY_STDIN vault-indexer' "$log"; then
  echo "FAIL CI가 data namespace workload를 변경했다" >&2
  exit 1
fi
[ "$(grep -c '^READ_VAULT_IMAGE$' "$log")" -eq 4 ]
if grep -q '^APPLY_FILE backup-cronjob.yaml$' "$log"; then
  echo "FAIL 일반 앱 배포가 미검증 백업 계정으로 CronJob을 교체했다" >&2
  exit 1
fi
if grep -q '^APPLY_FILE backup-pvc.yaml$' "$log"; then
  echo "FAIL CI deployer가 stateful PVC를 변경했다" >&2
  exit 1
fi

secret_preflight_line="$(line_of '^READ_SEALED backoffice-secrets$')"
migration_line="$(line_of '^CREATE_JOB ')"
verify_line="$(line_of '^READ_TRIGGER_STATE$')"
if [ -z "$secret_preflight_line" ] || ! [ "$secret_preflight_line" -lt "$migration_line" ]; then
  echo "FAIL 시크릿 참조 점검이 migration Job보다 먼저 실행되지 않았다" >&2
  cat "$log" >&2
  exit 1
fi
echo "  ok   시크릿 참조 점검 → migration"
notification_line="$(line_of '^ROLLOUT backoffice-notification-worker$')"
web_line="$(line_of '^APPLY_STDIN backoffice,')"
web_rollout_line="$(line_of '^ROLLOUT backoffice$')"
scheduler_line="$(line_of '^APPLY_FILE scheduler-cronjobs.yaml$')"
worker_line="$(line_of '^APPLY_STDIN backoffice-app-ops-worker,')"
catchup_line="$(line_of '^CREATE_JOB backoffice-scheduler-catchup-')"

if ! [ "$migration_line" -lt "$verify_line" ] ||
   ! [ "$verify_line" -lt "$notification_line" ] ||
   ! [ "$notification_line" -lt "$web_line" ] ||
   ! [ "$web_line" -lt "$web_rollout_line" ] ||
   ! [ "$web_rollout_line" -lt "$worker_line" ] ||
   ! [ "$worker_line" -lt "$scheduler_line" ] ||
   ! [ "$scheduler_line" -lt "$catchup_line" ]; then
  echo "FAIL migration → trigger-verify → web → worker → scheduler → catch-up 순서가 깨졌다" >&2
  cat "$log" >&2
  exit 1
fi
echo "  ok   migration → trigger-verify → notification consumer → web → worker → scheduler → catch-up"
echo "  ok   동일 SHA 재실행은 같은 source-bound desired-state run으로 검증"
[ "$(grep -c '^ROLLOUT backoffice-operations-insights$' "$log")" -eq 2 ]
[ "$(grep -c '^APPLY_STDIN backoffice-keyword-collection,' "$log")" -eq 2 ]
[ "$(grep -c '^APPLY_STDIN backoffice-market-feedback,backoffice-weekly-insights,backoffice-keyword-daily,' "$log")" -eq 2 ]
echo "  ok   검색 수집과 보고 worker 및 CronJob이 같은 배포에 포함된다"

echo "== 중지된 분석 worker는 복제본 0과 같은 digest를 확인한다 =="
: > "$log"
FAKE_INSIGHTS_PAUSED=true
run_deploy Complete >/dev/null
unset FAKE_INSIGHTS_PAUSED
grep -q '^APPLY_STDIN backoffice-keyword-collection,' "$log"
echo "  ok   분석 worker 중지 상태 보존 뒤 수집 일정을 반영한다"

echo "== rollout condition이 먼저 끝나도 새 generation exact state를 기다린다 =="
: > "$log"
rm -f "$deployment_counter"
FAKE_DEPLOYMENT_STALE_READS=1
run_deploy Complete >/dev/null
unset FAKE_DEPLOYMENT_STALE_READS
if [ "$(cat "$deployment_counter")" -gt 1 ]; then
  echo "  ok   observedGeneration 지연 뒤 exact digest state 확인"
else
  echo "FAIL deployment exact-state 재확인이 실행되지 않았다" >&2
  exit 1
fi

echo "== desired-state source-bound readback이 어긋나면 배포 실패 =="
for scenario in source status failed contract trigger missing-run; do
  : > "$log"
  case "$scenario" in
    source) FAKE_BACKFILL_SOURCE_SHA="$(printf 'b%.0s' {1..40})" ;;
    status) FAKE_BACKFILL_STATUS=PARTIAL ;;
    failed) FAKE_BACKFILL_FAILED=1 ;;
    contract) FAKE_BACKFILL_CONTRACT=desired-state-draft-backfill/v1 ;;
    trigger) FAKE_BACKFILL_TRIGGER=HOURLY_CRON ;;
    missing-run) FAKE_BACKFILL_RUN_ID= ;;
  esac
  if run_deploy Complete >/dev/null 2>&1; then
    echo "FAIL desired-state $scenario readback이 deploy 성공으로 처리됐다" >&2
    exit 1
  fi
  unset FAKE_BACKFILL_SOURCE_SHA FAKE_BACKFILL_STATUS FAKE_BACKFILL_FAILED \
    FAKE_BACKFILL_CONTRACT FAKE_BACKFILL_TRIGGER FAKE_BACKFILL_RUN_ID
  echo "  ok   $scenario fail-closed"
done

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
    bypass-trigger) FAKE_TRIGGER_STATUS=FAIL; FAKE_TRIGGER_TOTAL=$((expected_count + 1)); FAKE_TRIGGER_EXACT="$expected_count" ;;
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

echo "== 퇴역한 CronJob은 매니페스트에서 빠지고 클러스터에서도 지워진다 =="
# apply 는 사라진 리소스를 지우지 않는다. 이름만 바꾸면 옛 job 이 그대로 남아
# 없어진 엔드포인트를 계속 때린다. 두 쪽이 함께 있어야 정리가 성립한다.
retired_list="$(sed -n 's/^for retired in \(.*\); do$/\1/p' "$here/deploy-backoffice.sh")"
if [ -z "$retired_list" ]; then
  echo "FAIL deploy script에 퇴역 CronJob 정리 루프가 없다" >&2
  exit 1
fi
for retired in $retired_list; do
  if grep -q "name: $retired\$" "$here"/../k8s/*.yaml; then
    echo "FAIL 퇴역 대상이 아직 매니페스트에 있다: $retired" >&2
    exit 1
  fi
  if ! grep -q "DELETE_CRONJOB $retired" "$log"; then
    echo "FAIL 배포가 퇴역 CronJob을 지우지 않았다: $retired" >&2
    exit 1
  fi
done
echo "  ok   퇴역 CronJob 정리"

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
# verifier manifest는 계약 digest와 count를 읽는 용도로만 등장해야 한다.
# 주석과 안내 문구를 걷어낸 실행 라인에서 apply/create/render 대상이면 안 된다.
verifier_code="$(grep -v '^[[:space:]]*#' "$here/deploy-backoffice.sh" \
  | grep -v '^[[:space:]]*echo ' \
  | grep 'provider-audit-trigger-verifier\|provider-audit-trigger-recovery' || true)"
if [ "$(printf '%s\n' "$verifier_code" | grep -c 'k8s/provider-audit-trigger-verifier.yaml')" -ne 2 ] ||
   printf '%s\n' "$verifier_code" | grep -qE '(apply|create|render)[[:space:]]'; then
  echo "FAIL deploy script가 verifier/recovery manifest를 apply·create 대상에 포함했다" >&2
  printf '%s\n' "$verifier_code" >&2
  exit 1
fi
echo "  ok   verifier workload는 trusted operator 경계에만 있다"

echo "deploy-backoffice 계약 통과"
