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
audit_namespace="${BACKOFFICE_AUDIT_NAMESPACE:-data}"
audit_state_configmap="${BACKOFFICE_AUDIT_STATE_CONFIGMAP:-backoffice-provider-audit-trigger-state}"
verify_timeout="${BACKOFFICE_TRIGGER_VERIFY_TIMEOUT_SECONDS:-660}"
trigger_max_age="${BACKOFFICE_TRIGGER_OBSERVATION_MAX_AGE_SECONDS:-900}"
catchup_timeout="${BACKOFFICE_CATCHUP_TIMEOUT_SECONDS:-2460}"

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
for value in "$migration_timeout" "$catchup_timeout" "$verify_timeout" "$trigger_max_age"; do
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "오류: Job timeout은 양의 정수여야 한다" >&2
    exit 2
  fi
done
if [ "$catchup_timeout" -lt 2400 ]; then
  echo "오류: BACKOFFICE_CATCHUP_TIMEOUT_SECONDS는 Job activeDeadlineSeconds 이상인 2400이어야 한다" >&2
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

wait_for_deployment() {
  local deployment="$1"
  if k -n "$namespace" rollout status "deployment/$deployment" --timeout="$rollout_timeout"; then
    if deployment_matches_image "$deployment"; then
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
  backoffice-reconcile
  backoffice-xcode-cloud-sync
  backoffice-registry-seed
  backoffice-automation-scheduler
  backoffice-platform-fleet
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

trigger_observation_fresh() {
  local status total exact digest observed_at observed_epoch now_epoch age
  IFS='|' read -r status total exact digest observed_at <<< "$1"
  [ "$status" = PASS ] || return 1
  [ "$total" = 2 ] || return 1
  [ "$exact" = 2 ] || return 1
  [ "$digest" = "$expected_digest" ] || return 1
  [[ "$observed_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  observed_epoch="$(date -u -d "$observed_at" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$observed_at" +%s 2>/dev/null || echo "")"
  [ -n "$observed_epoch" ] || return 1
  now_epoch="$(date -u +%s)"
  age=$((now_epoch - observed_epoch))
  [ "$age" -ge -60 ] || return 1
  [ "$age" -le "$trigger_max_age" ]
}

trigger_state=""
trigger_deadline=$((SECONDS + verify_timeout))
while true; do
  if trigger_state="$(read_trigger_state 2>&1)" && trigger_observation_fresh "$trigger_state"; then
    break
  fi
  if (( SECONDS >= trigger_deadline )); then
    echo "오류: append-only trigger 관측이 계약을 만족하지 않는다" >&2
    echo "expected: status=PASS total=2 exact=2 digest=${expected_digest} age<=${trigger_max_age}s" >&2
    echo "observed: ${trigger_state}" >&2
    echo "복구는 trusted operator가 provider-audit-trigger-recovery-job으로 수행한다. 배포는 진행하지 않는다." >&2
    exit 1
  fi
  sleep "$migration_poll"
done
echo "trigger_observation=${trigger_state} contract_digest=${expected_digest} source_sha=${source_sha}"

echo "== availability-preserving web rollout =="
apply_image_manifest deployment.yaml
wait_for_deployment backoffice

echo "== worker rollout =="
apply_image_manifest app-ops-worker.yaml
wait_for_deployment backoffice-app-ops-worker
apply_image_manifest discord-workers.yaml
wait_for_deployment backoffice-notification-worker
wait_for_deployment backoffice-operator-command-worker
apply_image_manifest teammate-worker.yaml
wait_for_deployment backoffice-teammate-worker
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
echo "== endpoint CronJob manifests =="
for manifest in \
  backup-cronjob.yaml \
  proactive-cronjobs.yaml \
  app-content-analytics-cronjob.yaml \
  platform-metric-cronjob.yaml \
  teammate-patrol-cronjobs.yaml; do
  k apply -f "$root/k8s/$manifest"
done

echo "== image CronJob rollout =="
apply_image_manifest store-review-cronjob.yaml
store_review_image="$(k -n "$namespace" get cronjob backoffice-store-reviews -o 'jsonpath={.spec.jobTemplate.spec.template.spec.containers[0].image}')"
if [ "$store_review_image" != "$image" ]; then
  echo "오류: store-review CronJob 이미지 digest가 일치하지 않는다" >&2
  exit 1
fi

echo "== optional data namespace workload parity =="
vault_indexer="$(k -n data get cronjob vault-indexer -o name 2>&1 || true)"
vault_writer="$(k -n data get cronjob vault-writer -o name 2>&1 || true)"
if [[ "$vault_indexer" == cronjob.batch/* && "$vault_writer" == cronjob.batch/* ]]; then
  apply_image_manifest vault-rag.yaml
  indexer_image="$(k -n data get cronjob vault-indexer -o 'jsonpath={.spec.jobTemplate.spec.template.spec.containers[0].image}')"
  writer_image="$(k -n data get cronjob vault-writer -o 'jsonpath={.spec.jobTemplate.spec.template.spec.containers[0].image}')"
  if [ "$indexer_image" != "$image" ] || [ "$writer_image" != "$image" ]; then
    echo "오류: Vault CronJob 이미지 digest가 일치하지 않는다" >&2
    exit 1
  fi
elif [[ "$vault_indexer" == *NotFound* && "$vault_writer" == *NotFound* ]]; then
  echo "Vault CronJob 미설치 — image parity 대상 없음"
else
  echo "오류: Vault CronJob 조회 권한 또는 설치 상태가 불완전하다" >&2
  echo "vault-indexer: $vault_indexer" >&2
  echo "vault-writer: $vault_writer" >&2
  exit 1
fi

echo "배포 완료: source_sha=$source_sha image=$image"
