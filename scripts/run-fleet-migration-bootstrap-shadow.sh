#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
kubectl_bin="${KUBECTL_BIN:-kubectl}"
crane_bin="${CRANE_BIN:-crane}"
jq_bin="${JQ_BIN:-jq}"
namespace="${BACKOFFICE_NAMESPACE:-platform}"
image="${BACKOFFICE_IMAGE:-}"
source_sha="${BACKOFFICE_SOURCE_SHA:-}"
detector_sha="${FLEET_MIGRATION_DETECTOR_SOURCE_SHA:-}"
execution_id="${FLEET_MIGRATION_EXECUTION_ID:-}"
runtime_key_fingerprint="${FLEET_MIGRATION_RUNTIME_KEY_FINGERPRINT:-}"
runtime_config_map="${FLEET_MIGRATION_RUNTIME_CONFIG_MAP:-}"
github_token_secret="${FLEET_MIGRATION_GITHUB_TOKEN_SECRET:-}"
timeout="${BACKOFFICE_FLEET_BOOTSTRAP_TIMEOUT_SECONDS:-3600}"

if [[ ! "$image" =~ ^.+@sha256:[0-9a-f]{64}$ ]]; then
  echo "오류: BACKOFFICE_IMAGE는 immutable sha256 digest여야 한다" >&2
  exit 2
fi
if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "오류: BACKOFFICE_SOURCE_SHA는 40자리 git SHA여야 한다" >&2
  exit 2
fi
if [[ ! "$detector_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "오류: FLEET_MIGRATION_DETECTOR_SOURCE_SHA는 40자리 git SHA여야 한다" >&2
  exit 2
fi
if [[ ! "$execution_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$ ]]; then
  echo "오류: FLEET_MIGRATION_EXECUTION_ID가 public identifier 계약과 다르다" >&2
  exit 2
fi
if [[ ! "$runtime_key_fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
  echo "오류: FLEET_MIGRATION_RUNTIME_KEY_FINGERPRINT는 등록된 Ed25519 SPKI SHA-256이어야 한다" >&2
  exit 2
fi
for ref in "$runtime_config_map" "$github_token_secret"; do
  if [[ ! "$ref" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]]; then
    echo "오류: runtime ConfigMap/Secret 이름이 DNS 계약과 다르다" >&2
    exit 2
  fi
done
if [[ ! "$timeout" =~ ^[1-9][0-9]*$ ]]; then
  echo "오류: BACKOFFICE_FLEET_BOOTSTRAP_TIMEOUT_SECONDS는 양의 정수여야 한다" >&2
  exit 2
fi
for command in "$kubectl_bin" "$crane_bin" "$jq_bin"; do
  command -v "$command" >/dev/null || { echo "오류: 필수 실행 도구가 없다" >&2; exit 2; }
done

# digest만 같고 다른 source로 빌드된 이미지를 실행하지 않는다. registry config의
# 공개 OCI label만 읽으며 credential이나 image config 원문은 출력하지 않는다.
image_revision="$($crane_bin config "$image" | "$jq_bin" -er '.config.Labels["org.opencontainers.image.revision"]')"
if [ "$image_revision" != "$source_sha" ]; then
  echo "오류: image OCI source revision이 BACKOFFICE_SOURCE_SHA와 다르다" >&2
  exit 1
fi

# trusted operator가 미리 설치한 고정 NetworkPolicy가 repo canonical spec과 정확히
# 같은지 확인한다. 이 runner에는 NetworkPolicy mutation 권한이 필요 없다.
policy_file="$root/k8s/fleet-migration-bootstrap-shadow-network-policy.yaml"
expected_policy="$($kubectl_bin create --dry-run=client -f "$policy_file" -o json | "$jq_bin" -Sc '.spec')"
actual_policy="$($kubectl_bin -n "$namespace" get networkpolicy/backoffice-fleet-migration-bootstrap-shadow -o json | "$jq_bin" -Sc '.spec')"
if [ "$actual_policy" != "$expected_policy" ]; then
  echo "오류: BOOTSTRAP shadow NetworkPolicy가 canonical spec과 다르다" >&2
  exit 1
fi

# projected object의 존재와 exact key 이름만 확인한다. Secret 값은 읽거나 출력하지 않는다.
runtime_keys="$($kubectl_bin -n "$namespace" get "configmap/$runtime_config_map" -o go-template='{{if index .data "runtime-attestation.json"}}a{{end}}{{if index .data "runtime-attestation-public.pem"}}b{{end}}')"
token_key="$($kubectl_bin -n "$namespace" get "secret/$github_token_secret" -o go-template='{{if index .data "installation.token"}}present{{end}}')"
db_key="$($kubectl_bin -n "$namespace" get secret/fleet-migration-shadow-db -o go-template='{{if index .data "DATABASE_URL"}}present{{end}}')"
if [ "$runtime_keys" != "ab" ] || [ "$token_key" != "present" ] || [ "$db_key" != "present" ]; then
  echo "오류: signed runtime capability 또는 전용 DB execution copy가 불완전하다" >&2
  exit 1
fi

rendered="$($here/render-manifest.sh "$root/k8s/fleet-migration-bootstrap-shadow-job.yaml" "$image" "$source_sha" \
  | sed \
      -e "s|__FLEET_MIGRATION_DETECTOR_SOURCE_SHA__|$detector_sha|g" \
      -e "s|__FLEET_MIGRATION_EXECUTION_ID__|$execution_id|g" \
      -e "s|__FLEET_MIGRATION_RUNTIME_KEY_FINGERPRINT__|$runtime_key_fingerprint|g" \
      -e "s|__FLEET_MIGRATION_RUNTIME_CONFIG_MAP__|$runtime_config_map|g" \
      -e "s|__FLEET_MIGRATION_GITHUB_TOKEN_SECRET__|$github_token_secret|g")"
if grep -q '__[A-Z0-9_]*__\|:latest' <<<"$rendered"; then
  echo "오류: BOOTSTRAP Job placeholder 또는 mutable image가 남았다" >&2
  exit 1
fi
job_ref="$(printf '%s\n' "$rendered" | "$kubectl_bin" create -f - -o name)"
job_name="${job_ref##*/}"
test -n "$job_name"
echo "fleet_bootstrap_job=$job_name source_sha=$source_sha detector_sha=$detector_sha execution_id=$execution_id"

job_json="$($kubectl_bin -n "$namespace" get "job/$job_name" -o json)"
if ! printf '%s' "$job_json" | "$jq_bin" -e \
  --arg image "$image" \
  --arg source "$source_sha" \
  --arg detector "$detector_sha" \
  --arg execution "$execution_id" \
  --arg runtimeKeyFingerprint "$runtime_key_fingerprint" \
  --arg runtimeConfigMap "$runtime_config_map" \
  --arg tokenSecret "$github_token_secret" '
    .spec.suspend == true
    and .spec.backoffLimit == 0
    and .spec.activeDeadlineSeconds == 3600
    and .spec.ttlSecondsAfterFinished == 604800
    and .metadata.labels["seorilabs.dev/source-sha"] == $source
    and .metadata.annotations["seorilabs.dev/execution-id"] == $execution
    and .spec.template.spec.restartPolicy == "Never"
    and .spec.template.spec.automountServiceAccountToken == false
    and .spec.template.spec.nodeSelector["kubernetes.io/hostname"] == "rpi5"
    and .spec.template.spec.securityContext.runAsUser == 10001
    and .spec.template.spec.securityContext.runAsGroup == 10001
    and .spec.template.spec.securityContext.fsGroup == 10001
    and .spec.template.spec.securityContext.seccompProfile.type == "RuntimeDefault"
    and (.spec.template.spec.containers | length) == 1
    and (.spec.template.spec.containers[0] as $c
      | $c.image == $image
      and $c.command == ["node", "/app/scripts-dist/fleet-migration-bootstrap-shadow.cjs"]
      and $c.resources.requests.memory == "768Mi"
      and $c.resources.limits.memory == "2Gi"
      and $c.securityContext.allowPrivilegeEscalation == false
      and $c.securityContext.readOnlyRootFilesystem == true
      and $c.securityContext.capabilities.drop == ["ALL"]
      and ($c.env | map(select(.name == "BACKOFFICE_SOURCE_SHA"))[0].value) == $source
      and ($c.env | map(select(.name == "FLEET_MIGRATION_DETECTOR_SOURCE_SHA"))[0].value) == $detector
      and ($c.env | map(select(.name == "FLEET_MIGRATION_EXECUTION_ID"))[0].value) == $execution
      and ($c.env | map(select(.name == "FLEET_MIGRATION_RUNTIME_ATTESTATION_KEY_FINGERPRINT"))[0].value) == $runtimeKeyFingerprint
      and ($c.env | map(select(.name == "DATABASE_URL"))[0].valueFrom.secretKeyRef == {name:"fleet-migration-shadow-db",key:"DATABASE_URL"})
      and ([ $c.env[].name ] | index("GITHUB_PRIVATE_KEY") | not)
      and ([ $c.env[].name ] | index("GITHUB_APP_ID") | not)
      and ([ $c.env[].name ] | index("CONTROL_PLANE_SNAPSHOT_SIGNING_KEY") | not))
    and (.spec.template.spec.volumes | map(select(.name == "runtime-public-attestation"))[0].projected.defaultMode) == 288
    and (.spec.template.spec.volumes | map(select(.name == "runtime-public-attestation"))[0].projected.sources[0].configMap.name) == $runtimeConfigMap
    and (.spec.template.spec.volumes | map(select(.name == "github-read-token"))[0].secret.secretName) == $tokenSecret
    and (.spec.template.spec.volumes | map(select(.name == "github-read-token"))[0].secret.defaultMode) == 288
  ' >/dev/null; then
  echo "오류: BOOTSTRAP Job runtime/source/capability/resource binding 불일치" >&2
  exit 1
fi
if [ -n "$($kubectl_bin -n "$namespace" get pods -l "job-name=$job_name" -o 'jsonpath={.items[0].metadata.name}')" ]; then
  echo "오류: binding 검증 전 suspended BOOTSTRAP Job에 Pod가 생겼다" >&2
  exit 1
fi
$kubectl_bin -n "$namespace" patch "job/$job_name" --type=merge -p '{"spec":{"suspend":false}}' >/dev/null
if [ "$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.spec.suspend}')" != "false" ]; then
  echo "오류: 검증된 BOOTSTRAP Job을 시작하지 못했다" >&2
  exit 1
fi

deadline=$(( $(date +%s) + timeout ))
terminal=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  complete="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.status.conditions[?(@.type=="Complete")].status}')"
  failed="$($kubectl_bin -n "$namespace" get "job/$job_name" -o 'jsonpath={.status.conditions[?(@.type=="Failed")].status}')"
  if [ "$complete" = "True" ]; then terminal="complete"; break; fi
  if [ "$failed" = "True" ]; then terminal="failed"; break; fi
  sleep 5
done
if [ -z "$terminal" ]; then
  echo "오류: BOOTSTRAP shadow terminal 상태 timeout. 자동 재실행하지 않는다." >&2
  exit 1
fi
if [ "$terminal" = "failed" ]; then
  pod_name="$($kubectl_bin -n "$namespace" get pods -l "job-name=$job_name" -o 'jsonpath={.items[0].metadata.name}')"
  reason="$($kubectl_bin -n "$namespace" get "pod/$pod_name" -o 'jsonpath={.status.containerStatuses[0].state.terminated.reason}')"
  exit_code="$($kubectl_bin -n "$namespace" get "pod/$pod_name" -o 'jsonpath={.status.containerStatuses[0].state.terminated.exitCode}')"
  echo "오류: BOOTSTRAP shadow failed reason=$reason exit_code=$exit_code. 동일 Job을 반복하지 않는다." >&2
  exit 1
fi

evidence="$($kubectl_bin -n "$namespace" logs "job/$job_name" -c bootstrap-shadow --tail=1)"
if ! printf '%s\n' "$evidence" | "$jq_bin" -e \
  --arg source "$source_sha" --arg detector "$detector_sha" --arg execution "$execution_id" '
    .state == "SHADOW_COMPLETE"
    and .sourceSha == $source
    and .detectorSourceSha == $detector
    and .executionId == $execution
    and .occurrenceAuditWrites == 2
    and .githubMutations == 0
    and .domainMutations == 0
    and .authoritative == false
    and .readyForPlanning == false
  ' >/dev/null; then
  echo "오류: durable fenced occurrence terminal readback을 확인하지 못했다" >&2
  exit 1
fi
printf '%s\n' "$evidence"
