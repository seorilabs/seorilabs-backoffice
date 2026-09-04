#!/usr/bin/env bash

set -euo pipefail
set +x

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
kubectl_bin="${KUBECTL_BIN:-kubectl}"
crane_bin="${CRANE_BIN:-crane}"
jq_bin="${JQ_BIN:-jq}"
openssl_bin="${OPENSSL_BIN:-openssl}"
od_bin="${OD_BIN:-od}"
tr_bin="${TR_BIN:-tr}"
namespace="platform"
image="${BACKOFFICE_IMAGE:-}"
image_digest="${image##*@}"
source_sha="${BACKOFFICE_SOURCE_SHA:-}"
occurrence_id="${FLEET_MIGRATION_OCCURRENCE_ID:-}"
run_id="${FLEET_MIGRATION_RUN_ID:-}"
provider_vector_digest="${FLEET_MIGRATION_PROVIDER_VECTOR_DIGEST:-}"
timeout="${FLEET_MIGRATION_INVENTORY_ISSUER_TIMEOUT_SECONDS:-660}"

fail() {
  echo "오류: $1" >&2
  exit 1
}

if [[ ! "$image" =~ ^registry\.vzyx\.xyz/seorilabs/seorilabs-backoffice@sha256:[0-9a-f]{64}$ ]]; then
  echo "오류: BACKOFFICE_IMAGE는 canonical repository의 immutable sha256 digest여야 한다" >&2
  exit 2
fi
if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "오류: BACKOFFICE_SOURCE_SHA는 40자리 git SHA여야 한다" >&2
  exit 2
fi
for evidence_id in "$occurrence_id" "$run_id"; do
  if [[ ! "$evidence_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$ ]]; then
    echo "오류: occurrence/run identity가 public evidence ID 계약과 다르다" >&2
    exit 2
  fi
done
if [[ ! "$provider_vector_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "오류: FLEET_MIGRATION_PROVIDER_VECTOR_DIGEST가 sha256 계약과 다르다" >&2
  exit 2
fi
if [[ ! "$timeout" =~ ^[1-9][0-9]*$ ]] || [ "$timeout" -gt 1200 ]; then
  echo "오류: FLEET_MIGRATION_INVENTORY_ISSUER_TIMEOUT_SECONDS는 1..1200이어야 한다" >&2
  exit 2
fi
for command in "$kubectl_bin" "$crane_bin" "$jq_bin" "$openssl_bin" "$od_bin" "$tr_bin"; do
  command -v "$command" >/dev/null || { echo "오류: 필수 실행 도구가 없다" >&2; exit 2; }
done

# DB 정본의 occurrenceId unique와 같은 키를 Kubernetes create CAS에도 사용한다.
# source SHA를 name에 넣지 않으므로 같은 occurrence는 재배포 뒤에도 같은 이름에 충돌한다.
occurrence_digest="$(printf '%s' "$occurrence_id" \
  | "$openssl_bin" dgst -sha256 -binary \
  | "$od_bin" -An -v -tx1 \
  | "$tr_bin" -d ' \n')"
if [[ ! "$occurrence_digest" =~ ^[0-9a-f]{64}$ ]]; then
  fail "occurrenceId SHA-256 계산 결과가 canonical hex digest가 아니다"
fi
job_name="fleet-inventory-issuer-${occurrence_digest:0:40}"
if [ "${#job_name}" -ne 63 ] || [[ ! "$job_name" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])$ ]]; then
  fail "occurrence 기반 issuer Job name이 DNS-1123 계약과 다르다"
fi

# 공개 OCI revision만 읽고 exact source가 아닌 image 실행을 거부한다.
image_revision="$($crane_bin config "$image" | "$jq_bin" -er '.config.Labels["org.opencontainers.image.revision"]')"
[ "$image_revision" = "$source_sha" ] || fail "image OCI source revision이 BACKOFFICE_SOURCE_SHA와 다르다"

rendered_issuer="$("$here/render-manifest.sh" "$root/k8s/fleet-migration-inventory-issuer-job.yaml" "$image" "$source_sha" \
  | sed \
      -e "s|__FLEET_MIGRATION_OCCURRENCE_ID__|$occurrence_id|g" \
      -e "s|__FLEET_MIGRATION_RUN_ID__|$run_id|g" \
      -e "s|__FLEET_MIGRATION_PROVIDER_VECTOR_DIGEST__|$provider_vector_digest|g" \
      -e "s|__FLEET_MIGRATION_JOB_NAME__|$job_name|g")"
rendered_signer="$("$here/render-manifest.sh" "$root/k8s/fleet-migration-inventory-signer.yaml" "$image" "$source_sha")"
if grep -q '__[A-Z0-9_]*__\|:latest' <<<"$rendered_issuer$rendered_signer"; then
  fail "canonical manifest에 unresolved placeholder 또는 mutable image가 남았다"
fi

# kubectl client renderer를 사용하되 어떤 지원 리소스도 생성하지 않는다. 실제 mutation은
# 검증이 끝난 Job create와 그 Job의 suspend 해제 두 번뿐이다.
issuer_documents="$(printf '%s\n' "$rendered_issuer" | "$kubectl_bin" create --dry-run=client -f - -o json | "$jq_bin" -cs '.')"
signer_documents="$(printf '%s\n' "$rendered_signer" | "$kubectl_bin" create --dry-run=client -f - -o json | "$jq_bin" -cs '.')"
if ! printf '%s' "$issuer_documents" | "$jq_bin" -e '
  length == 4
  and ([.[].kind] | sort) == ["Job","NetworkPolicy","Role","ServiceAccount"]
  and ([.[] | select(.kind == "Job")] | length) == 1
' >/dev/null; then
  fail "issuer manifest resource set이 canonical contract와 다르다"
fi
if ! printf '%s' "$signer_documents" | "$jq_bin" -e '
  length == 5
  and ([.[].kind] | sort) == ["Deployment","NetworkPolicy","Role","Service","ServiceAccount"]
  and ([.[] | select(.kind == "Deployment")] | length) == 1
' >/dev/null; then
  fail "signer manifest resource set이 canonical contract와 다르다"
fi
expected_job="$(printf '%s' "$issuer_documents" | "$jq_bin" -c '[.[] | select(.kind == "Job")][0]')"
expected_issuer_policy="$(printf '%s' "$issuer_documents" | "$jq_bin" -Sc '[.[] | select(.kind == "NetworkPolicy")][0].spec')"
expected_signer="$(printf '%s' "$signer_documents" | "$jq_bin" -c '[.[] | select(.kind == "Deployment")][0]')"
expected_service="$(printf '%s' "$signer_documents" | "$jq_bin" -c '[.[] | select(.kind == "Service")][0]')"
expected_signer_policy="$(printf '%s' "$signer_documents" | "$jq_bin" -Sc '[.[] | select(.kind == "NetworkPolicy")][0].spec')"
if [ "$(printf '%s' "$expected_job" | "$jq_bin" -er '.metadata.name')" != "$job_name" ] \
  || printf '%s' "$expected_job" | "$jq_bin" -e '.metadata | has("generateName")' >/dev/null; then
  fail "issuer Job이 occurrence 기반 fixed-name CAS와 다르다"
fi

# issuer/signer support boundary는 trusted operator가 미리 설치해야 한다. 이 runner는
# ServiceAccount, Role, NetworkPolicy, Deployment 또는 Service를 apply/patch하지 않는다.
if ! "$kubectl_bin" -n "$namespace" get serviceaccount/fleet-migration-inventory-issuer -o json \
  | "$jq_bin" -e '.automountServiceAccountToken == false' >/dev/null; then
  fail "issuer ServiceAccount가 canonical disabled-token contract와 다르다"
fi
if ! "$kubectl_bin" -n "$namespace" get role/fleet-migration-inventory-issuer -o json \
  | "$jq_bin" -e '(.rules | length) == 0' >/dev/null; then
  fail "issuer Role이 no-permission contract와 다르다"
fi
actual_issuer_policy="$($kubectl_bin -n "$namespace" get networkpolicy/fleet-migration-inventory-issuer -o json | "$jq_bin" -Sc '.spec')"
[ "$actual_issuer_policy" = "$expected_issuer_policy" ] || fail "issuer NetworkPolicy가 canonical spec과 다르다"
actual_signer_policy="$($kubectl_bin -n "$namespace" get networkpolicy/fleet-migration-inventory-signer -o json | "$jq_bin" -Sc '.spec')"
[ "$actual_signer_policy" = "$expected_signer_policy" ] || fail "signer NetworkPolicy가 canonical spec과 다르다"

# Secret/ConfigMap은 exact credential-id annotation과 key-name 존재만 marker로 읽는다.
# 값, 전체 annotation, raw JSON은 읽거나 출력하지 않는다.
read_bound_key_markers() {
  local kind="$1"
  local name="$2"
  local logical_id="$3"
  local key_template="$4"
  local expected="$5"
  local markers=""
  local template="{{if eq (index .metadata.annotations \"seorilabs.dev/credential-id\") \"$logical_id\"}}i{{end}}$key_template"
  if ! markers="$($kubectl_bin -n "$namespace" get "$kind/$name" -o "go-template=$template" 2>/dev/null)"; then
    fail "required execution object가 없다: $kind/$name"
  fi
  [ "$markers" = "i$expected" ] || fail "required execution object identity/key 계약이 불완전하다: $kind/$name"
}
read_bound_key_markers configmap fleet-migration-inventory-public-identity shared/platform/fleet-release-approval-signing '{{if index .data "public-key.pem"}}p{{end}}{{if index .data "catalog.json"}}c{{end}}' pc
read_bound_key_markers secret fleet-migration-inventory-issuer-db shared/seori-auth/fleet-migration-inventory-issuer-db '{{if index .data "DATABASE_URL"}}d{{end}}' d
read_bound_key_markers secret fleet-migration-inventory-issuer-github-app shared/github/backoffice-app-private-key '{{if index .data "private-key.pem"}}g{{end}}' g
read_bound_key_markers secret fleet-migration-inventory-signer-client shared/platform/fleet-migration-inventory-issuer-client-mtls '{{if index .data "ca.pem"}}a{{end}}{{if index .data "tls.crt"}}c{{end}}{{if index .data "tls.key"}}k{{end}}' ack
read_bound_key_markers secret fleet-migration-inventory-signer-server shared/platform/fleet-migration-inventory-signer-server-mtls '{{if index .data "client-ca.pem"}}a{{end}}{{if index .data "tls.crt"}}c{{end}}{{if index .data "tls.key"}}k{{end}}' ack
read_bound_key_markers secret fleet-release-approval-signing shared/platform/fleet-release-approval-signing '{{if index .data "private-key.pem"}}s{{end}}' s
# registry-pull-cred는 catalog logical credential이 아닌 cluster imagePullSecret이다.
# type과 exact key-name만 검증하고 존재하지 않는 credential-id를 발명하지 않는다.
read_key_markers() {
  local kind="$1"
  local name="$2"
  local template="$3"
  local expected="$4"
  local markers=""
  if ! markers="$($kubectl_bin -n "$namespace" get "$kind/$name" -o "go-template=$template" 2>/dev/null)"; then
    fail "required execution object가 없다: $kind/$name"
  fi
  [ "$markers" = "$expected" ] || fail "required execution object key 계약이 불완전하다: $kind/$name"
}
read_key_markers secret registry-pull-cred '{{if eq .type "kubernetes.io/dockerconfigjson"}}t{{end}}{{if index .data ".dockerconfigjson"}}d{{end}}' td

# signer는 별도 gate에서 이미 exact 1 replica로 활성화되고 Ready여야 한다. 여기서는
# source/image/security/key-isolation identity를 readback할 뿐 scale/rollout을 하지 않는다.
actual_signer="$($kubectl_bin -n "$namespace" get deployment/backoffice-fleet-migration-inventory-signer -o json)"
if ! printf '%s\n%s\n' "$expected_signer" "$actual_signer" | "$jq_bin" -e -s \
  --arg image "$image" --arg source "$source_sha" '
    .[0] as $e | .[1] as $a
    | $a.metadata.deletionTimestamp == null
    and $a.metadata.labels["seorilabs.dev/source-sha"] == $source
    and $a.metadata.annotations["seorilabs.dev/signing-credential-id"] == "shared/platform/fleet-release-approval-signing"
    and $a.metadata.annotations["seorilabs.dev/server-mtls-credential-id"] == "shared/platform/fleet-migration-inventory-signer-server-mtls"
    and $a.spec.replicas == 1
    and $a.status.observedGeneration == $a.metadata.generation
    and $a.status.updatedReplicas == 1
    and $a.status.readyReplicas == 1
    and $a.status.availableReplicas == 1
    and (($a.status.unavailableReplicas // 0) == 0)
    and $a.spec.strategy == $e.spec.strategy
    and $a.spec.selector == $e.spec.selector
    and $a.spec.template.metadata.labels == $e.spec.template.metadata.labels
    and $a.spec.template.spec.serviceAccountName == $e.spec.template.spec.serviceAccountName
    and $a.spec.template.spec.automountServiceAccountToken == false
    and $a.spec.template.spec.enableServiceLinks == false
    and $a.spec.template.spec.shareProcessNamespace == false
    and $a.spec.template.spec.nodeSelector == $e.spec.template.spec.nodeSelector
    and $a.spec.template.spec.imagePullSecrets == $e.spec.template.spec.imagePullSecrets
    and $a.spec.template.spec.securityContext == $e.spec.template.spec.securityContext
    and ($a.spec.template.spec.containers | length) == 1
    and ($a.spec.template.spec.containers[0] as $c | $e.spec.template.spec.containers[0] as $ec
      | $c.name == "signer"
      and $c.image == $image
      and $c.image == $ec.image
      and $c.command == $ec.command
      and $c.ports == $ec.ports
      and $c.env == $ec.env
      and $c.readinessProbe == $ec.readinessProbe
      and $c.livenessProbe == $ec.livenessProbe
      and $c.resources == $ec.resources
      and $c.securityContext == $ec.securityContext
      and $c.volumeMounts == $ec.volumeMounts)
    and $a.spec.template.spec.volumes == $e.spec.template.spec.volumes
  ' >/dev/null; then
  fail "live signer Deployment image/source/readiness/key-isolation binding 불일치"
fi

actual_service="$($kubectl_bin -n "$namespace" get service/fleet-migration-inventory-signer -o json)"
if ! printf '%s\n%s\n' "$expected_service" "$actual_service" | "$jq_bin" -e -s '
  .[0] as $e | .[1] as $a
  | $a.spec.selector == $e.spec.selector
  and ($a.spec.ports | length) == 1
  and $a.spec.ports[0].name == "mtls"
  and $a.spec.ports[0].port == 9444
  and $a.spec.ports[0].targetPort == "mtls"
  and $a.spec.ports[0].protocol == "TCP"
' >/dev/null; then
  fail "live signer Service가 canonical mTLS route와 다르다"
fi

signer_pods="$($kubectl_bin -n "$namespace" get pods -l 'app.kubernetes.io/name=backoffice,app.kubernetes.io/component=fleet-migration-inventory-signer' -o json)"
if ! printf '%s' "$signer_pods" | "$jq_bin" -e --arg image "$image" --arg digest "$image_digest" --arg source "$source_sha" '
  (.items | length) == 1
  and (.items[0] as $p
    | $p.metadata.deletionTimestamp == null
    and $p.metadata.labels["seorilabs.dev/source-sha"] == $source
    and $p.spec.serviceAccountName == "fleet-migration-inventory-signer"
    and ($p.spec.containers | length) == 1
    and $p.spec.containers[0].name == "signer"
    and $p.spec.containers[0].image == $image
    and $p.status.phase == "Running"
    and ($p.status.conditions | any(.type == "Ready" and .status == "True"))
    and ($p.status.containerStatuses | length) == 1
    and $p.status.containerStatuses[0].ready == true
    and ((try ($p.status.containerStatuses[0].imageID | capture("(?<digest>sha256:[0-9a-f]{64})$").digest) catch null) == $digest))
' >/dev/null; then
  fail "exact source/image signer Ready Pod가 하나가 아니다"
fi
signer_pod_name="$(printf '%s' "$signer_pods" | "$jq_bin" -er '.items[0].metadata.name')"
endpoints="$($kubectl_bin -n "$namespace" get endpointslice -l kubernetes.io/service-name=fleet-migration-inventory-signer -o json)"
if ! printf '%s' "$endpoints" | "$jq_bin" -e --arg pod "$signer_pod_name" '
  ([.items[].ports[] | select(.name == "mtls" and .port == 9444 and .protocol == "TCP")] | length) >= 1
  and ([.items[].endpoints[] | select(.conditions.ready == true and .targetRef.kind == "Pod" and .targetRef.name == $pod)] | length) == 1
' >/dev/null; then
  fail "signer Service endpoint가 exact Ready Pod identity와 결합되지 않았다"
fi

# fixed name create가 곧 Kubernetes CAS다. AlreadyExists, timeout, 연결 단절처럼 create 결과가
# 확정되지 않으면 named Job의 공개 identity marker만 읽고 무조건 READBACK_FIRST로 종료한다.
# 이 branch에서는 Job을 patch하거나 create를 반복하지 않는다.
job_ref=""
if ! job_ref="$(printf '%s' "$expected_job" | "$kubectl_bin" create -f - -o name 2>/dev/null)"; then
  readback_marker=""
  readback_template="{{if eq .metadata.name \"$job_name\"}}n{{end}}{{if eq (index .metadata.annotations \"seorilabs.dev/occurrence-id\") \"$occurrence_id\"}}o{{end}}{{if eq (index .metadata.annotations \"seorilabs.dev/run-id\") \"$run_id\"}}r{{end}}{{if eq (index .metadata.annotations \"seorilabs.dev/provider-vector-digest\") \"$provider_vector_digest\"}}p{{end}}{{if eq (index .metadata.labels \"seorilabs.dev/source-sha\") \"$source_sha\"}}s{{end}}"
  if readback_marker="$($kubectl_bin -n "$namespace" get "job/$job_name" -o "go-template=$readback_template" 2>/dev/null)" \
    && [ "$readback_marker" = "norps" ]; then
    fail "READBACK_FIRST: occurrence CAS Job이 이미 존재하거나 create 결과가 불명이다. 기존 named Job을 별도 readback한다"
  fi
  fail "READBACK_FIRST: create 결과가 불명이고 named Job의 exact public identity를 확인하지 못했다"
fi
if [ "$job_ref" != "job.batch/$job_name" ]; then
  fail "생성된 issuer Job identity가 canonical fixed job.batch name과 다르다"
fi

actual_job=""
if ! actual_job="$($kubectl_bin -n "$namespace" get "job/$job_name" -o json 2>/dev/null)"; then
  fail "READBACK_FIRST: created issuer Job의 exact binding readback 결과가 불명이다"
fi
if ! printf '%s\n%s\n' "$expected_job" "$actual_job" | "$jq_bin" -e -s '
  .[0] as $e | .[1] as $a
  | $a.metadata.name == $e.metadata.name
  and ($a.metadata.uid | type == "string" and length > 0)
  and $a.spec.suspend == true
  and $a.spec.backoffLimit == $e.spec.backoffLimit
  and $a.spec.activeDeadlineSeconds == $e.spec.activeDeadlineSeconds
  and $a.spec.ttlSecondsAfterFinished == $e.spec.ttlSecondsAfterFinished
  and $a.metadata.labels["app.kubernetes.io/name"] == $e.metadata.labels["app.kubernetes.io/name"]
  and $a.metadata.labels["app.kubernetes.io/component"] == $e.metadata.labels["app.kubernetes.io/component"]
  and $a.metadata.labels["seorilabs.dev/source-sha"] == $e.metadata.labels["seorilabs.dev/source-sha"]
  and $a.metadata.annotations["seorilabs.dev/signing-credential-id"] == $e.metadata.annotations["seorilabs.dev/signing-credential-id"]
  and $a.metadata.annotations["seorilabs.dev/database-credential-id"] == $e.metadata.annotations["seorilabs.dev/database-credential-id"]
  and $a.metadata.annotations["seorilabs.dev/client-mtls-credential-id"] == $e.metadata.annotations["seorilabs.dev/client-mtls-credential-id"]
  and $a.metadata.annotations["seorilabs.dev/github-app-credential-id"] == $e.metadata.annotations["seorilabs.dev/github-app-credential-id"]
  and $a.metadata.annotations["seorilabs.dev/occurrence-id"] == $e.metadata.annotations["seorilabs.dev/occurrence-id"]
  and $a.metadata.annotations["seorilabs.dev/run-id"] == $e.metadata.annotations["seorilabs.dev/run-id"]
  and $a.metadata.annotations["seorilabs.dev/provider-vector-digest"] == $e.metadata.annotations["seorilabs.dev/provider-vector-digest"]
  and $a.spec.template.metadata.labels["app.kubernetes.io/name"] == $e.spec.template.metadata.labels["app.kubernetes.io/name"]
  and $a.spec.template.metadata.labels["app.kubernetes.io/component"] == $e.spec.template.metadata.labels["app.kubernetes.io/component"]
  and $a.spec.template.metadata.labels["seorilabs.dev/source-sha"] == $e.spec.template.metadata.labels["seorilabs.dev/source-sha"]
  and $a.spec.template.spec.serviceAccountName == $e.spec.template.spec.serviceAccountName
  and $a.spec.template.spec.automountServiceAccountToken == false
  and $a.spec.template.spec.enableServiceLinks == false
  and $a.spec.template.spec.shareProcessNamespace == false
  and $a.spec.template.spec.restartPolicy == "Never"
  and $a.spec.template.spec.nodeSelector == $e.spec.template.spec.nodeSelector
  and $a.spec.template.spec.imagePullSecrets == $e.spec.template.spec.imagePullSecrets
  and $a.spec.template.spec.securityContext == $e.spec.template.spec.securityContext
  and ($a.spec.template.spec.containers | length) == 1
  and ($a.spec.template.spec.containers[0] as $c | $e.spec.template.spec.containers[0] as $ec
    | $c.name == "issuer"
    and $c.image == $ec.image
    and $c.imagePullPolicy == $ec.imagePullPolicy
    and $c.workingDir == $ec.workingDir
    and $c.command == $ec.command
    and $c.env == $ec.env
    and $c.resources == $ec.resources
    and $c.securityContext == $ec.securityContext
    and $c.volumeMounts == $ec.volumeMounts)
  and $a.spec.template.spec.volumes == $e.spec.template.spec.volumes
' >/dev/null; then
  fail "created issuer Job의 source/input/env/volume/security/suspend binding 불일치"
fi
created_job_uid="$(printf '%s' "$actual_job" | "$jq_bin" -er '.metadata.uid')"
created_job_resource_version="$(printf '%s' "$actual_job" | "$jq_bin" -er '.metadata.resourceVersion')"
if [ -z "$created_job_uid" ] || [ -z "$created_job_resource_version" ]; then
  fail "created issuer Job의 UID/resourceVersion을 고정하지 못했다"
fi
if [ -n "$($kubectl_bin -n "$namespace" get pods -l "job-name=$job_name" -o 'jsonpath={.items[0].metadata.name}')" ]; then
  fail "binding 검증 전 suspended issuer Job에 Pod가 생겼다"
fi

# 이 runner가 수행하는 유일한 activation mutation이다. 검증 이후 Job이 바뀌면 UID 또는
# resourceVersion JSON Patch test가 원자적으로 실패한다. signer와 credential object는 건드리지 않는다.
unsuspend_patch="$("$jq_bin" -cn \
  --arg uid "$created_job_uid" --arg resourceVersion "$created_job_resource_version" \
  '[
    {"op":"test","path":"/metadata/uid","value":$uid},
    {"op":"test","path":"/metadata/resourceVersion","value":$resourceVersion},
    {"op":"test","path":"/spec/suspend","value":true},
    {"op":"replace","path":"/spec/suspend","value":false}
  ]')"
if ! "$kubectl_bin" -n "$namespace" patch "job/$job_name" --type=json -p "$unsuspend_patch" >/dev/null 2>&1; then
  unsuspend_patch=""
  fail "READBACK_FIRST: 검증된 issuer Job의 UID/resourceVersion activation CAS가 실패하거나 결과가 불명이다"
fi
unsuspend_patch=""
activated_job="$($kubectl_bin -n "$namespace" get "job/$job_name" -o json)"
if ! printf '%s' "$activated_job" | "$jq_bin" -e \
  --arg uid "$created_job_uid" --arg resourceVersion "$created_job_resource_version" \
  '.metadata.uid == $uid and .metadata.resourceVersion != $resourceVersion and .spec.suspend == false' >/dev/null; then
  fail "READBACK_FIRST: activation 뒤 issuer Job UID/suspend readback이 불명이다"
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
  fail "issuer Job terminal 상태 timeout. 자동 재실행하지 않는다"
fi
if [ "$terminal" = "failed" ]; then
  fail "issuer Job이 failed terminal이다. 동일 occurrence를 반복하지 않고 named Job을 별도 readback한다"
fi

# Complete condition만으로 임의 Pod log를 읽지 않는다. Job UID에 controller ownerRef로
# 결합된 exact 1 Pod가 동일 source/image digest로 Succeeded/exit 0인 것을 먼저 검증한다.
completed_job="$($kubectl_bin -n "$namespace" get "job/$job_name" -o json)"
if ! printf '%s' "$completed_job" | "$jq_bin" -e \
  --arg job "$job_name" --arg occurrence "$occurrence_id" --arg run "$run_id" --arg provider "$provider_vector_digest" \
  --arg createdJobUid "$created_job_uid" --arg image "$image" --arg source "$source_sha" '
  .metadata.name == $job
  and .metadata.uid == $createdJobUid
  and .metadata.labels["seorilabs.dev/source-sha"] == $source
  and .metadata.annotations["seorilabs.dev/occurrence-id"] == $occurrence
  and .metadata.annotations["seorilabs.dev/run-id"] == $run
  and .metadata.annotations["seorilabs.dev/provider-vector-digest"] == $provider
  and .spec.suspend == false
  and .status.succeeded == 1
  and ((.status.failed // 0) == 0)
  and ((.status.active // 0) == 0)
  and (.status.conditions | any(.type == "Complete" and .status == "True"))
  and (.spec.template.spec.containers | length) == 1
  and .spec.template.metadata.labels["seorilabs.dev/source-sha"] == $source
  and .spec.template.spec.containers[0].name == "issuer"
  and .spec.template.spec.containers[0].image == $image
' >/dev/null; then
  fail "completed issuer Job의 UID/source/image/success binding 불일치"
fi
job_uid="$(printf '%s' "$completed_job" | "$jq_bin" -er '.metadata.uid')"
issuer_pods="$($kubectl_bin -n "$namespace" get pods -l "job-name=$job_name" -o json)"
if ! printf '%s' "$issuer_pods" | "$jq_bin" -e \
  --arg job "$job_name" --arg jobUid "$job_uid" --arg image "$image" --arg digest "$image_digest" --arg source "$source_sha" '
  (.items | length) == 1
  and (.items[0] as $p
    | $p.metadata.deletionTimestamp == null
    and $p.metadata.labels["job-name"] == $job
    and $p.metadata.labels["seorilabs.dev/source-sha"] == $source
    and ($p.metadata.ownerReferences | length) == 1
    and $p.metadata.ownerReferences[0].apiVersion == "batch/v1"
    and $p.metadata.ownerReferences[0].kind == "Job"
    and $p.metadata.ownerReferences[0].name == $job
    and $p.metadata.ownerReferences[0].uid == $jobUid
    and $p.metadata.ownerReferences[0].controller == true
    and $p.spec.serviceAccountName == "fleet-migration-inventory-issuer"
    and $p.spec.automountServiceAccountToken == false
    and (($p.spec.initContainers // []) | length) == 0
    and (($p.spec.ephemeralContainers // []) | length) == 0
    and ($p.spec.containers | length) == 1
    and $p.spec.containers[0].name == "issuer"
    and $p.spec.containers[0].image == $image
    and $p.spec.restartPolicy == "Never"
    and $p.status.phase == "Succeeded"
    and ($p.status.containerStatuses | length) == 1
    and $p.status.containerStatuses[0].name == "issuer"
    and ((try ($p.status.containerStatuses[0].imageID | capture("(?<digest>sha256:[0-9a-f]{64})$").digest) catch null) == $digest)
    and $p.status.containerStatuses[0].restartCount == 0
    and $p.status.containerStatuses[0].state.terminated.exitCode == 0
    and $p.status.containerStatuses[0].state.terminated.reason == "Completed")
' >/dev/null; then
  fail "issuer terminal Pod의 Job owner/source/imageID/Succeeded/exit binding 불일치"
fi
issuer_pod_name="$(printf '%s' "$issuer_pods" | "$jq_bin" -er '.items[0].metadata.name')"

evidence="$($kubectl_bin -n "$namespace" logs "pod/$issuer_pod_name" -c issuer --tail=1)"
evidence_filter="$root/scripts/fleet-migration-inventory-issuer-evidence.jq"
if [ ! -f "$evidence_filter" ]; then
  evidence=""
  fail "issuer terminal evidence allowlist가 없다"
fi
sanitized_evidence=""
if ! sanitized_evidence="$(printf '%s\n' "$evidence" | "$jq_bin" -ce \
  --arg occurrence "$occurrence_id" --arg run "$run_id" --arg provider "$provider_vector_digest" \
  -f "$evidence_filter" 2>/dev/null)"; then
  evidence=""
  fail "issuer의 secret-free authoritative terminal readback을 검증하지 못했다"
fi
evidence=""
printf '%s\n' "$sanitized_evidence"
