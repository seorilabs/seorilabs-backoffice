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
scheduler_drain_timeout="${BACKOFFICE_SCHEDULER_DRAIN_TIMEOUT_SECONDS:-960}"
scheduler_drain_settle="${BACKOFFICE_SCHEDULER_DRAIN_SETTLE_SECONDS:-15}"
catchup_timeout="${BACKOFFICE_CATCHUP_TIMEOUT_SECONDS:-1560}"
catchup_quiesce_timeout="${BACKOFFICE_CATCHUP_QUIESCE_TIMEOUT_SECONDS:-180}"

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
for value in "$migration_timeout" "$scheduler_drain_timeout" "$catchup_timeout" "$catchup_quiesce_timeout"; do
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "오류: Job timeout은 양의 정수여야 한다" >&2
    exit 2
  fi
done
if [[ ! "$scheduler_drain_settle" =~ ^[0-9]+$ ]]; then
  echo "오류: BACKOFFICE_SCHEDULER_DRAIN_SETTLE_SECONDS는 0 이상의 정수여야 한다" >&2
  exit 2
fi
if [ "$catchup_timeout" -lt 1500 ]; then
  echo "오류: BACKOFFICE_CATCHUP_TIMEOUT_SECONDS는 Job activeDeadlineSeconds 이상인 1500이어야 한다" >&2
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
  echo "오류: ${purpose} Job 실패: $job_name" >&2
  k -n "$namespace" get job "$job_name" -o wide >&2 || true
  echo "보안 정책상 Job 로그는 CI에 출력하지 않는다. trusted operator 경계에서 확인해야 한다." >&2
  return 1
}

wait_for_job() {
  local purpose="$1"
  local job_name="$2"
  local timeout="$3"
  local deadline=$((SECONDS + timeout))
  local conditions

  while (( SECONDS < deadline )); do
    conditions="$(k -n "$namespace" get job "$job_name" -o 'jsonpath={range .status.conditions[*]}{.type}={.status}{"\n"}{end}')"
    if [[ "$conditions" == *"Complete=True"* ]]; then
      return 0
    fi
    if [[ "$conditions" == *"Failed=True"* ]]; then
      job_failure "$purpose" "$job_name"
      return 1
    fi
    sleep "$migration_poll"
  done

  echo "오류: ${purpose} Job timeout: ${timeout}s" >&2
  job_failure "$purpose" "$job_name"
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
  backoffice-reconcile
  backoffice-xcode-cloud-sync
  backoffice-registry-seed
  backoffice-automation-scheduler
)
scheduler_restore_needed=false
scheduler_restore_safe=true

cronjob_exists() {
  local cronjob="$1"
  local result
  if result="$(k -n "$namespace" get "cronjob/$cronjob" -o name 2>&1)"; then
    return 0
  fi
  if [[ "$result" == *NotFound* ]]; then
    return 1
  fi
  echo "오류: cronjob/$cronjob 조회 실패: $result" >&2
  return 2
}

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

restore_schedulers_on_exit() {
  local code=$?
  trap - EXIT
  if [ "$scheduler_restore_needed" = true ]; then
    if [ "$scheduler_restore_safe" != true ]; then
      echo "치명적 오류: catch-up Job 종료를 확인하지 못해 scheduler CronJob을 재개하지 않는다" >&2
      echo "중복 실행을 막기 위해 operator가 Job 종료 확인 후 scheduler-cronjobs.yaml을 적용해야 한다" >&2
      code=1
    elif ! restore_scheduler_manifests; then
      echo "배포 중단 — scheduler CronJob 매니페스트 복구 실패" >&2
      echo "치명적 오류: scheduler CronJob 자동 복구를 확인하지 못했다" >&2
      code=1
    fi
  fi
  exit "$code"
}

wait_for_job_quiescent() {
  local job_name="$1"
  local deadline=$((SECONDS + catchup_quiesce_timeout))
  local conditions
  while (( SECONDS < deadline )); do
    if ! conditions="$(k -n "$namespace" get job "$job_name" -o 'jsonpath={range .status.conditions[*]}{.type}={.status}{"\n"}{end}' 2>&1)"; then
      echo "오류: scheduler catch-up 종료 확인 실패: $conditions" >&2
      return 1
    fi
    if [[ "$conditions" == *"Complete=True"* || "$conditions" == *"Failed=True"* ]]; then
      return 0
    fi
    sleep "$migration_poll"
  done
  echo "오류: scheduler catch-up Job terminal 상태를 확인하지 못했다" >&2
  return 1
}
trap restore_schedulers_on_exit EXIT

suspend_and_drain_schedulers() {
  local cronjob code active deadline
  for cronjob in "${scheduler_cronjobs[@]}"; do
    if cronjob_exists "$cronjob"; then
      # patch 결과가 timeout으로 불명이어도 복구하도록 mutation 전에 세운다.
      scheduler_restore_needed=true
      k -n "$namespace" patch "cronjob/$cronjob" --type=merge \
        -p '{"spec":{"suspend":true}}' >/dev/null
    else
      code=$?
      [ "$code" -eq 1 ] || return "$code"
    fi
  done

  # CronJob controller가 마지막 Job 생성과 .status.active 반영을 끝낼 시간을 준다.
  sleep "$scheduler_drain_settle"
  deadline=$((SECONDS + scheduler_drain_timeout))
  while (( SECONDS < deadline )); do
    active=""
    for cronjob in "${scheduler_cronjobs[@]}"; do
      if cronjob_exists "$cronjob"; then
        active+="$(k -n "$namespace" get "cronjob/$cronjob" -o 'jsonpath={range .status.active[*]}{.name}{" "}{end}')"
      else
        code=$?
        [ "$code" -eq 1 ] || return "$code"
      fi
    done
    [ -z "${active// }" ] && return 0
    sleep "$migration_poll"
  done
  echo "오류: scheduler CronJob drain timeout: ${scheduler_drain_timeout}s" >&2
  return 1
}

reset_scheduler_cronjobs() {
  # suspend 중 놓친 시각은 재개 시 즉시 실행될 수 있다. active Job을 drain한 뒤
  # CronJob만 orphan 삭제하고 catch-up 완료 후 새로 생성해 missed schedule을 없앤다.
  scheduler_restore_needed=true
  k -n "$namespace" delete cronjob \
    "${scheduler_cronjobs[@]}" \
    --ignore-not-found=true \
    --cascade=orphan >/dev/null
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

echo "== scheduler drain and catch-up =="
# 첫 전환에서는 old in-process scheduler Pod가 사라진 뒤 실행된다. 이후에는 기존
# CronJob을 잠시 suspend하고 active Job을 비운 뒤 one-shot과 정기 실행의 중복을 막는다.
suspend_and_drain_schedulers
reset_scheduler_cronjobs
catchup_manifest="$(render scheduler-catchup-job.yaml)"
# create가 서버에는 반영된 뒤 응답만 유실될 수 있으므로 mutation 전에 unsafe로 둔다.
# 이름을 확인하지 못하면 중복 방지를 위해 CronJob 자동 재개 대신 operator 확인으로 멈춘다.
scheduler_restore_safe=false
catchup_ref="$(printf '%s\n' "$catchup_manifest" | k create -f - -o name)"
catchup_name="${catchup_ref##*/}"
if [ -z "$catchup_name" ]; then
  echo "오류: 생성된 scheduler catch-up Job 이름을 읽지 못했다" >&2
  exit 1
fi
if ! wait_for_job scheduler-catchup "$catchup_name" "$catchup_timeout"; then
  if wait_for_job_quiescent "$catchup_name"; then
    scheduler_restore_safe=true
  fi
  exit 1
fi
scheduler_restore_safe=true
catchup_sha="$(k -n "$namespace" get job "$catchup_name" -o 'jsonpath={.metadata.labels.seorilabs\.dev/source-sha}')"
if [ "$catchup_sha" != "$source_sha" ]; then
  echo "오류: scheduler catch-up source SHA 불일치" >&2
  exit 1
fi
restore_scheduler_manifests
scheduler_restore_needed=false

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
