#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
kubectl_bin="${KUBECTL_BIN:-kubectl}"
namespace="${BACKOFFICE_NAMESPACE:-platform}"
image="${BACKOFFICE_IMAGE:-}"
source_sha="${BACKOFFICE_SOURCE_SHA:-}"
migration_timeout="${BACKOFFICE_MIGRATION_TIMEOUT_SECONDS:-300}"
migration_poll="${BACKOFFICE_MIGRATION_POLL_SECONDS:-2}"
rollout_timeout="${BACKOFFICE_ROLLOUT_TIMEOUT:-300s}"
deployment_state_timeout="${BACKOFFICE_DEPLOYMENT_STATE_TIMEOUT_SECONDS:-300}"
deployment_state_poll="${BACKOFFICE_DEPLOYMENT_STATE_POLL_SECONDS:-1}"
audit_namespace="${BACKOFFICE_AUDIT_NAMESPACE:-data}"
audit_state_configmap="${BACKOFFICE_AUDIT_STATE_CONFIGMAP:-backoffice-provider-audit-trigger-state}"
verify_timeout="${BACKOFFICE_TRIGGER_VERIFY_TIMEOUT_SECONDS:-660}"
catchup_timeout="${BACKOFFICE_CATCHUP_TIMEOUT_SECONDS:-3360}"
desired_state_backfill_contract="desired-state-safe-source-rebase/v3"

if [ -z "$image" ]; then
  echo "오류: BACKOFFICE_IMAGE가 필요하다" >&2
  exit 2
fi

if [[ ! "$image" =~ ^.+@sha256:[0-9a-f]{64}$ ]]; then
  echo "오류: BACKOFFICE_IMAGE는 immutable sha256 digest여야 한다" >&2
  exit 2
fi
if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "오류: BACKOFFICE_SOURCE_SHA는 40자리 git SHA여야 한다" >&2
  exit 2
fi
for value in "$migration_timeout" "$catchup_timeout" "$verify_timeout"; do
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "오류: Job timeout은 양의 정수여야 한다" >&2
    exit 2
  fi
done
if [[ ! "$deployment_state_timeout" =~ ^[1-9][0-9]*$ ]] ||
   [[ ! "$deployment_state_poll" =~ ^[0-9]+$ ]]; then
  echo "오류: deployment exact-state timeout은 양의 정수이고 poll은 0 이상의 정수여야 한다" >&2
  exit 2
fi
if [ "$catchup_timeout" -lt 3300 ]; then
  echo "오류: BACKOFFICE_CATCHUP_TIMEOUT_SECONDS는 Job activeDeadlineSeconds 이상인 3300이어야 한다" >&2
  exit 2
fi

k() {
  "$kubectl_bin" "$@"
}

render() {
  "$root/scripts/render-manifest.sh" "$root/k8s/$1" "$image" "$source_sha"
}

apply_image_manifest() {
  local manifest="$1"
  render "$manifest" | k apply -f -
}

job_failure() {
  local purpose="$1"
  local job_name="$2"
  local job_ns="${3:-$namespace}"
  echo "오류: ${purpose} Job 실패: $job_name" >&2
  k -n "$job_ns" get job "$job_name" -o wide >&2 || true
  echo "보안 정책상 Job 로그는 CI에 출력하지 않는다. trusted operator 경계에서 확인해야 한다." >&2
  return 1
}

wait_for_job() {
  local purpose="$1"
  local job_name="$2"
  local timeout="$3"
  local job_ns="${4:-$namespace}"
  local deadline=$((SECONDS + timeout))
  local conditions

  while (( SECONDS < deadline )); do
    conditions="$(k -n "$job_ns" get job "$job_name" -o 'jsonpath={range .status.conditions[*]}{.type}={.status}{"\n"}{end}')"
    if [[ "$conditions" == *"Complete=True"* ]]; then
      return 0
    fi
    if [[ "$conditions" == *"Failed=True"* ]]; then
      job_failure "$purpose" "$job_name" "$job_ns"
      return 1
    fi
    sleep "$migration_poll"
  done

  echo "오류: ${purpose} Job timeout: ${timeout}s" >&2
  job_failure "$purpose" "$job_name" "$job_ns"
}

deployment_matches_image() {
  local deployment="$1"
  local state generation observed desired replicas updated ready available unavailable images
  state="$(k -n "$namespace" get "deployment/$deployment" -o 'jsonpath={.metadata.generation}|{.status.observedGeneration}|{.spec.replicas}|{.status.replicas}|{.status.updatedReplicas}|{.status.readyReplicas}|{.status.availableReplicas}|{.status.unavailableReplicas}|{range .spec.template.spec.containers[*]}{.image}{","}{end}')"
  IFS='|' read -r generation observed desired replicas updated ready available unavailable images <<< "$state"
  desired="${desired:-0}"
  replicas="${replicas:-0}"
  updated="${updated:-0}"
  ready="${ready:-0}"
  available="${available:-0}"
  unavailable="${unavailable:-0}"

  [ "${observed:-0}" -ge "${generation:-1}" ] &&
    [ "$desired" -gt 0 ] &&
    [ "$replicas" -eq "$desired" ] &&
    [ "$updated" -eq "$desired" ] &&
    [ "$ready" -eq "$desired" ] &&
    [ "$available" -eq "$desired" ] &&
    [ "$unavailable" -eq 0 ] &&
    [ "$images" = "${image}," ]
}

wait_for_exact_deployment_state() {
  local deployment="$1"
  local deadline=$((SECONDS + deployment_state_timeout))

  while (( SECONDS < deadline )); do
    if deployment_matches_image "$deployment"; then
      return 0
    fi
    sleep "$deployment_state_poll"
  done

  deployment_matches_image "$deployment"
}

wait_for_deployment() {
  local deployment="$1"
  if k -n "$namespace" rollout status "deployment/$deployment" --timeout="$rollout_timeout"; then
    if wait_for_exact_deployment_state "$deployment"; then
      return 0
    fi
    echo "오류: deployment/$deployment rollout은 끝났지만 exact digest desired state가 아니다" >&2
    k -n "$namespace" get "deployment/$deployment" -o wide >&2 || true
    return 1
  fi
  if deployment_matches_image "$deployment"; then
    echo "deployment/$deployment 는 exact digest desired state라 이전 rollout condition을 무시한다"
    return 0
  fi
  k -n "$namespace" get "deployment/$deployment" -o wide >&2 || true
  return 1
}

scheduler_cronjobs=(
  backoffice-repository-discovery-backfill
  backoffice-desired-state-backfill
  backoffice-reconcile
  backoffice-xcode-cloud-sync
  backoffice-registry-seed
  backoffice-automation-scheduler
  backoffice-platform-fleet
  backoffice-fleet-project-projection
)

verify_schedulers_resumed() {
  local cronjob suspended result
  for cronjob in "${scheduler_cronjobs[@]}"; do
    if ! result="$(k -n "$namespace" get "cronjob/$cronjob" -o 'jsonpath={.spec.suspend}' 2>&1)"; then
      echo "오류: cronjob/$cronjob 재개 확인 실패: $result" >&2
      return 1
    fi
    suspended="$result"
    if [ "$suspended" = true ]; then
      echo "오류: cronjob/$cronjob 이 suspend 상태로 남았다" >&2
      return 1
    fi
  done
}

restore_scheduler_manifests() {
  if ! k apply -f "$root/k8s/scheduler-cronjobs.yaml" >/dev/null; then
    echo "오류: scheduler CronJob 매니페스트 복구 실패" >&2
    return 1
  fi
  verify_schedulers_resumed
}

echo "== pre-deploy migration =="
job_ref="$(render migration-job.yaml | k create -f - -o name)"
job_name="${job_ref##*/}"
if [ -z "$job_name" ]; then
  echo "오류: 생성된 migration Job 이름을 읽지 못했다" >&2
  exit 1
fi
echo "migration_job=$job_name source_sha=$source_sha"
wait_for_job migration "$job_name" "$migration_timeout"
job_image="$(k -n "$namespace" get job "$job_name" -o 'jsonpath={.spec.template.spec.containers[0].image}')"
job_sha="$(k -n "$namespace" get job "$job_name" -o 'jsonpath={.metadata.labels.seorilabs\.dev/source-sha}')"
if [ "$job_image" != "$image" ] || [ "$job_sha" != "$source_sha" ]; then
  echo "오류: migration Job digest 또는 source SHA 불일치" >&2
  exit 1
fi
image_id="$(k -n "$namespace" get pods -l "job-name=$job_name" -o 'jsonpath={.items[0].status.containerStatuses[0].imageID}' 2>/dev/null || true)"
if [[ "$image_id" != *@"${image##*@}" ]]; then
  echo "오류: migration Job runtime imageID가 요청 digest와 다르다" >&2
  exit 1
fi
echo "migration_image=$job_image image_id=${image_id:-unavailable}"
# 관측 신선도를 벽시계 max age가 아니라 이번 배포의 migration 경계로 판정한다.
# cluster clock을 쓰는 Job status를 기준으로 삼아 runner clock skew를 배제한다.
migration_completed_at="$(k -n "$namespace" get job "$job_name" -o 'jsonpath={.status.completionTime}')"
if [[ ! "$migration_completed_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  echo "오류: migration Job 완료 시각을 읽지 못했다: ${migration_completed_at:-unavailable}" >&2
  exit 1
fi
echo "migration_completed_at=$migration_completed_at"

# app migration principal에는 대상 table의 TRIGGER 권한이 없어
# information_schema.TRIGGERS가 빈 결과로 보인다. 권한 부족을 부재로 읽지 않도록
# 가시성 있는 고정 in-cluster verifier의 관측을 rollout 선행조건으로 요구한다.
#
# CI는 verifier workload를 만들거나 바꿀 수 없고 관측 ConfigMap을 읽기만 한다.
# 따라서 CI가 root secret을 mount하는 spec을 만들 수 없다. verifier는 trusted
# operator가 k8s/provider-audit-trigger-verifier.yaml로 apply한다.
echo "== provider audit trigger observation readback (data ns, read-only) =="
expected_digest="$(awk -F'"' '/seorilabs\.dev\/append-only-contract-digest:/ { print $2; exit }' \
  "$root/k8s/provider-audit-trigger-verifier.yaml")"
if [[ ! "$expected_digest" =~ ^[0-9a-f]{64}$ ]]; then
  echo "오류: append-only 계약 digest를 repo에서 읽지 못했다" >&2
  exit 1
fi

read_trigger_state() {
  k -n "$audit_namespace" get configmap "$audit_state_configmap" \
    -o 'jsonpath={.data.status}|{.data.total}|{.data.exact}|{.data.contractDigest}|{.data.observedAt}'
}

utc_epoch() {
  date -u -d "$1" +%s 2>/dev/null \
    || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null \
    || return 1
}

# 이번 배포의 migration 이후에 만들어진 관측만 인정한다. 벽시계 max age만 보면
# migration 이전 상태를 근거로 rollout할 수 있다.
trigger_observation_fresh() {
  local status total exact digest observed_at observed_epoch
  IFS='|' read -r status total exact digest observed_at <<< "$1"
  [ "$status" = PASS ] || return 1
  [ "$total" = 4 ] || return 1
  [ "$exact" = 4 ] || return 1
  [ "$digest" = "$expected_digest" ] || return 1
  [[ "$observed_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  observed_epoch="$(utc_epoch "$observed_at")" || return 1
  # 같은 초 race를 막으려고 완료 시각보다 엄격히 큰 관측만 인정한다.
  [ "$observed_epoch" -gt "$migration_boundary_epoch" ]
}

migration_boundary_epoch="$(utc_epoch "$migration_completed_at")" || {
  echo "오류: migration 완료 시각을 epoch으로 변환하지 못했다" >&2
  exit 1
}

trigger_state=""
trigger_deadline=$((SECONDS + verify_timeout))
while true; do
  if trigger_state="$(read_trigger_state 2>&1)" && trigger_observation_fresh "$trigger_state"; then
    break
  fi
  if (( SECONDS >= trigger_deadline )); then
    echo "오류: append-only trigger 관측이 계약을 만족하지 않는다" >&2
    echo "expected: status=PASS total=4 exact=4 digest=${expected_digest} observedAt>${migration_completed_at}" >&2
    echo "observed: ${trigger_state}" >&2
    echo "복구는 trusted operator가 provider-audit-trigger-recovery-job으로 수행한다. 배포는 진행하지 않는다." >&2
    exit 1
  fi
  sleep "$migration_poll"
done
echo "trigger_observation=${trigger_state} contract_digest=${expected_digest} migration_completed_at=${migration_completed_at} source_sha=${source_sha}"

echo "== availability-preserving web rollout =="
apply_image_manifest deployment.yaml
wait_for_deployment backoffice

echo "== worker rollout =="
apply_image_manifest app-ops-worker.yaml
wait_for_deployment backoffice-app-ops-worker
apply_image_manifest discord-workers.yaml
wait_for_deployment backoffice-notification-worker
wait_for_deployment backoffice-operator-command-worker
apply_image_manifest repository-discovery-worker.yaml
wait_for_deployment backoffice-repository-discovery-worker

echo "== continuously available scheduler manifests =="
# 정기 scheduler를 먼저 exact manifest로 수렴시킨다. 이후 runner나 catch-up이
# 중단돼도 CronJob은 삭제·suspend되지 않는다. catch-up과 같은 시각의 정기 실행은
# 각 endpoint의 durable idempotency/CAS 계약으로 한 번만 반영된다.
restore_scheduler_manifests

echo "== scheduler catch-up =="
catchup_manifest="$(render scheduler-catchup-job.yaml)"
catchup_ref="$(printf '%s\n' "$catchup_manifest" | k create -f - -o name)"
catchup_name="${catchup_ref##*/}"
if [ -z "$catchup_name" ]; then
  echo "오류: 생성된 scheduler catch-up Job 이름을 읽지 못했다" >&2
  exit 1
fi
wait_for_job scheduler-catchup "$catchup_name" "$catchup_timeout"
catchup_sha="$(k -n "$namespace" get job "$catchup_name" -o 'jsonpath={.metadata.labels.seorilabs\.dev/source-sha}')"
if [ "$catchup_sha" != "$source_sha" ]; then
  echo "오류: scheduler catch-up source SHA 불일치" >&2
  exit 1
fi
catchup_readback="$(k -n "$namespace" get pods -l "job-name=$catchup_name" \
  -o 'jsonpath={.items[0].status.containerStatuses[0].state.terminated.message}')"
readback_field() {
  local key="$1"
  printf '%s\n' "$catchup_readback" | awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2) }'
}
backfill_run_id="$(readback_field runId)"
backfill_contract="$(readback_field contractVersion)"
backfill_trigger="$(readback_field trigger)"
backfill_source_sha="$(readback_field sourceSha)"
backfill_status="$(readback_field status)"
backfill_failed="$(readback_field failed)"
if [[ ! "$backfill_run_id" =~ ^[A-Za-z0-9_-]+$ ]] ||
   [ "$backfill_contract" != "$desired_state_backfill_contract" ] ||
   [ "$backfill_trigger" != DEPLOY_CATCH_UP ] ||
   [ "$backfill_source_sha" != "$source_sha" ] ||
   [ "$backfill_status" != COMPLETED ] ||
   [ "$backfill_failed" != 0 ]; then
  echo "오류: scheduler catch-up desired-state run readback이 배포 계약과 일치하지 않는다" >&2
  exit 1
fi
echo "desired_state_backfill_run_id=${backfill_run_id} contract=${backfill_contract} source_sha=${backfill_source_sha} status=${backfill_status} failed=${backfill_failed}"
echo "== endpoint CronJob manifests =="
for manifest in \
  backup-cronjob.yaml \
  proactive-cronjobs.yaml \
  app-content-analytics-cronjob.yaml \
  platform-metric-cronjob.yaml; do
  k apply -f "$root/k8s/$manifest"
done

echo "== image CronJob rollout =="
apply_image_manifest store-review-cronjob.yaml
store_review_image="$(k -n "$namespace" get cronjob backoffice-store-reviews -o 'jsonpath={.spec.jobTemplate.spec.template.spec.containers[0].image}')"
if [ "$store_review_image" != "$image" ]; then
  echo "오류: store-review CronJob 이미지 digest가 일치하지 않는다" >&2
  exit 1
fi

# CI는 data namespace workload를 만들거나 바꾸지 않는다. CronJob patch/update는 field
# 제한이 없어 Pod template에 임의 Secret volume을 붙일 수 있고, 그 자체가 root secret
# export 경로다. 여기서는 이미지 parity를 관측해 보고만 하며 실제 갱신은 trusted
# operator가 k8s/vault-rag.yaml로 직접 apply한다.
echo "== optional data namespace image parity observation (read-only) =="
vault_parity=MATCH
for cronjob in vault-indexer vault-writer; do
  if ! observed="$(k -n data get cronjob "$cronjob" \
      -o 'jsonpath={.spec.jobTemplate.spec.template.spec.containers[0].image}' 2>&1)"; then
    if [[ "$observed" == *NotFound* ]]; then
      [ "$vault_parity" = DRIFT ] || vault_parity=ABSENT
    else
      vault_parity=UNREADABLE
    fi
    continue
  fi
  if [ "$observed" != "$image" ]; then
    vault_parity=DRIFT
  fi
done
echo "vault_image_parity=${vault_parity} expected=${image}"
if [ "$vault_parity" != MATCH ] && [ "$vault_parity" != ABSENT ]; then
  echo "Vault CronJob 이미지가 이번 배포와 다르거나 읽을 수 없다. CI는 이 workload를 바꾸지 않는다." >&2
  echo "trusted operator 조치: kubectl apply -f <(scripts/render-manifest.sh k8s/vault-rag.yaml \"$image\" \"$source_sha\")" >&2
fi

echo "배포 완료: source_sha=$source_sha image=$image"
